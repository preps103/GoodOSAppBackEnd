"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const HOSTNAME = /^(?=.{4,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const OPERATION_TYPES = new Set([
  "organization.create", "project.create", "project.pause", "project.restore", "project.duplicate",
  "project.delete", "database.password.rotate", "api_keys.rotate", "backup.create", "backup.restore",
  "branch.create", "branch.delete", "function.deploy", "domain.configure", "auth.configure",
  "storage.configure", "realtime.configure", "member.invite", "member.role.update"
]);
const MANAGEMENT_SCOPES = new Set([
  "platform:read", "observability:read", "observability:write", "management:read", "management:write",
  "domains:read", "domains:write", "search:read", "search:write", "infrastructure:read",
  "infrastructure:write", "platform:privileged"
]);

function currentTenant(request) {
  return {
    organizationId: request.tenantContext.organizationId,
    projectId: request.tenantContext.projectId,
    environmentId: request.tenantContext.environmentId
  };
}

function cleanText(value, maximum = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, maximum);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireMfa(request, response, next) {
  if (!request.auth?.mfaVerified && !request.managementScopes?.includes("platform:privileged")) {
    return response.status(428).json({
      success: false,
      code: "GOODBASE_PRIVILEGED_MFA_REQUIRED",
      message: "Verify MFA before performing this privileged platform action."
    });
  }
  return next();
}

async function enterpriseAuthentication(request, response, next) {
  const authorization = String(request.get("authorization") || "");
  const token = authorization.startsWith("Bearer gbp_") ? authorization.slice(7).trim() : null;
  if (!token) return authRequired(request, response, next);
  try {
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await database.query(
      `UPDATE goodbase_management_tokens token SET last_used_at=NOW()
       FROM users account
       WHERE token.token_hash=$1 AND token.status='active'
         AND (token.expires_at IS NULL OR token.expires_at>NOW())
         AND account.id=token.created_by AND account.status='active'
       RETURNING token.id,token.organization_id,token.project_id,token.scopes,account.id AS user_id`,
      [hash]
    );
    const credential = result.rows[0];
    if (!credential) return response.status(401).json({ success:false,code:"GOODBASE_MANAGEMENT_TOKEN_INVALID",message:"Management token is invalid, expired, or revoked." });
    request.user = { id: credential.user_id };
    request.auth = { source: "management_token", mfaVerified: false };
    request.managementTokenId = credential.id;
    request.managementScopes = credential.scopes || [];
    request.headers["x-goodos-organization-id"] = credential.organization_id;
    if (credential.project_id) request.headers["x-goodos-project-id"] = credential.project_id;
    return next();
  } catch (error) { return next(error); }
}

function requiredManagementScope(request) {
  const write = !["GET","HEAD","OPTIONS"].includes(request.method);
  const path = request.path;
  if (path === "/overview") return "platform:read";
  if (path.startsWith("/logs") || path.startsWith("/observability")) return `observability:${write ? "write" : "read"}`;
  if (path.startsWith("/management")) return `management:${write ? "write" : "read"}`;
  if (path.startsWith("/domains")) return `domains:${write ? "write" : "read"}`;
  if (path.startsWith("/search")) return `search:${write ? "write" : "read"}`;
  if (path.startsWith("/infrastructure")) return `infrastructure:${write ? "write" : "read"}`;
  return "platform:read";
}

function managementScopeRequired(request, response, next) {
  if (!request.managementTokenId) return next();
  const required = requiredManagementScope(request);
  if (!request.managementScopes.includes(required)) {
    return response.status(403).json({ success:false,code:"GOODBASE_MANAGEMENT_SCOPE_REQUIRED",message:`Management scope ${required} is required.` });
  }
  return next();
}

async function audit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user.id,
    appId: "goodbase",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: { ...currentTenant(request), ...metadata }
  });
}

function numericVector(value, dimensions) {
  if (!Array.isArray(value) || value.length !== dimensions) {
    const error = new Error(`Embedding must contain exactly ${dimensions} values.`);
    error.statusCode = 400;
    throw error;
  }
  const vector = value.map(Number);
  if (vector.some((item) => !Number.isFinite(item) || Math.abs(item) > 1000000)) {
    const error = new Error("Embedding contains an invalid numeric value.");
    error.statusCode = 400;
    throw error;
  }
  return vector;
}

function vectorScore(left, right, metric) {
  if (!left || !right || left.length !== right.length) return null;
  let dot = 0; let leftMagnitude = 0; let rightMagnitude = 0; let squaredDistance = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
    squaredDistance += (left[index] - right[index]) ** 2;
  }
  if (metric === "inner_product") return dot;
  if (metric === "euclidean") return 1 / (1 + Math.sqrt(squaredDistance));
  return leftMagnitude && rightMagnitude ? dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)) : 0;
}

router.use(enterpriseAuthentication, tenantContext, dataPlaneAdminRequired, managementScopeRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const tenant = currentTenant(request);
    const result = await database.query(
      `SELECT
       (SELECT COUNT(*)::int FROM goodbase_unified_logs WHERE created_at>NOW()-INTERVAL '24 hours') AS logs_24h,
       (SELECT COUNT(*)::int FROM goodbase_management_operations WHERE organization_id=$1 AND requested_at>NOW()-INTERVAL '24 hours') AS management_operations_24h,
       (SELECT COUNT(*)::int FROM goodbase_custom_domains WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND activation_status='active') AS active_domains,
       (SELECT COUNT(*)::int FROM goodbase_vector_documents WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3) AS vector_documents,
       (SELECT COUNT(*)::int FROM goodbase_service_nodes WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='ready') AS ready_nodes,
       (SELECT COUNT(*)::int FROM goodbase_incidents WHERE organization_id=$1 AND status<>'resolved') AS open_incidents`,
      [tenant.organizationId, tenant.projectId, tenant.environmentId]
    );
    return response.json({ success: true, phases: { observability: 16, managementApi: 17, customDomains: 18, vectorSearch: 19, regionalInfrastructure: 20 }, metrics: result.rows[0] });
  } catch (error) { return next(error); }
});

router.get("/logs", async (request, response, next) => {
  const client = await database.pool.connect();
  try {
    const tenant = currentTenant(request);
    const limit = boundedInteger(request.query.limit, 100, 1, 500);
    const hours = boundedInteger(request.query.hours, 24, 1, 24 * 90);
    const service = cleanText(request.query.service, 80);
    const severity = cleanText(request.query.severity, 20);
    const requestId = cleanText(request.query.requestId, 128);
    const traceId = cleanText(request.query.traceId, 128);
    const query = cleanText(request.query.query, 128);
    const regex = String(request.query.regex || "false") === "true";
    const values = [hours, tenant.organizationId];
    const where = ["created_at >= NOW()-($1::text||' hours')::interval", "(organization_id IS NULL OR organization_id=$2)"];
    for (const [value, sql] of [[service,"service"],[severity,"severity"],[requestId,"request_id"],[traceId,"trace_id"]]) {
      if (value) { values.push(value); where.push(`${sql}=$${values.length}`); }
    }
    if (query) { values.push(query); where.push(regex ? `COALESCE(message,'') ~* $${values.length}` : `COALESCE(message,'') ILIKE '%'||$${values.length}||'%'`); }
    values.push(limit);
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const result = await client.query(`SELECT * FROM goodbase_unified_logs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    await client.query("COMMIT");
    return response.json({ success: true, logs: result.rows, count: result.rowCount, filters: { hours, service: service || null, severity: severity || null, regex } });
  } catch (error) { await client.query("ROLLBACK").catch(() => null); if (error.code === "2201B") error.statusCode = 400; return next(error); } finally { client.release(); }
});

router.get("/observability", async (request, response, next) => {
  try {
    const tenant = currentTenant(request);
    const [savedQueries, drains, policies, slos] = await Promise.all([
      database.query(`SELECT * FROM goodbase_log_saved_queries WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY name`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT id,name,drain_type,endpoint,minimum_severity,source_filters,status,last_delivery_at,last_error,created_at,updated_at FROM goodbase_log_drains WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY name`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT * FROM goodbase_observability_policies WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 LIMIT 1`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT definition.*,measurement.result AS latest_status,measurement.observed_value AS latest_value,measurement.measured_at FROM backend_slo_definitions definition LEFT JOIN LATERAL(SELECT * FROM backend_slo_measurements WHERE slo_id=definition.id ORDER BY measured_at DESC LIMIT 1) measurement ON TRUE ORDER BY definition.service_name,definition.name`)
    ]);
    return response.json({ success:true,savedQueries:savedQueries.rows,drains:drains.rows,policy:policies.rows[0]||null,slos:slos.rows });
  } catch(error){return next(error);}
});

router.post("/observability/saved-queries", async (request,response,next)=>{
  try{const tenant=currentTenant(request);const name=cleanText(request.body?.name,120);if(!name)return response.status(400).json({success:false,message:"Query name is required."});const result=await database.query(`INSERT INTO goodbase_log_saved_queries(organization_id,project_id,environment_id,name,query_text,regex_enabled,filters_json,is_shared,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,name,cleanText(request.body?.query,128)||null,request.body?.regex===true,JSON.stringify(request.body?.filters||{}),request.body?.shared===true,request.user.id]);await audit(request,"goodbase.observability.query.create","saved_log_query",result.rows[0].id);return response.status(201).json({success:true,savedQuery:result.rows[0]});}catch(error){if(error.code==="23505")error.statusCode=409;return next(error);}
});

router.post("/observability/drains", requireMfa, async(request,response,next)=>{
  try{const tenant=currentTenant(request);const type=cleanText(request.body?.type,20);if(!["https","syslog","otlp","s3"].includes(type))return response.status(400).json({success:false,message:"Unsupported log drain type."});const endpoint=cleanText(request.body?.endpoint,500);const secretRef=cleanText(request.body?.secretRef,300);if(!endpoint||secretRef&&!secretRef.startsWith("secret://"))return response.status(400).json({success:false,message:"A valid endpoint and secret:// reference are required."});const result=await database.query(`INSERT INTO goodbase_log_drains(organization_id,project_id,environment_id,name,drain_type,endpoint,secret_ref,minimum_severity,source_filters,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10) RETURNING id,name,drain_type,endpoint,minimum_severity,source_filters,status,created_at`,[tenant.organizationId,tenant.projectId,tenant.environmentId,cleanText(request.body?.name,120),type,endpoint,secretRef||null,cleanText(request.body?.minimumSeverity,20)||"info",Array.isArray(request.body?.sources)?request.body.sources.map((item)=>cleanText(item,80)).slice(0,30):[],request.user.id]);await audit(request,"goodbase.observability.drain.create","log_drain",result.rows[0].id);return response.status(201).json({success:true,drain:result.rows[0]});}catch(error){return next(error);}
});

router.get("/management",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const [operations,tokens,integrations]=await Promise.all([database.query(`SELECT * FROM goodbase_management_operations WHERE organization_id=$1 AND project_id=$2 ORDER BY requested_at DESC LIMIT 100`,[tenant.organizationId,tenant.projectId]),database.query(`SELECT id,name,token_prefix,scopes,status,last_used_at,expires_at,created_at,revoked_at FROM goodbase_management_tokens WHERE organization_id=$1 ORDER BY created_at DESC`,[tenant.organizationId]),database.query(`SELECT id,integration_type,name,configuration_json,status,created_at,updated_at FROM goodbase_automation_integrations WHERE organization_id=$1 AND (project_id IS NULL OR project_id=$2) ORDER BY name`,[tenant.organizationId,tenant.projectId])]);return response.json({success:true,operations:operations.rows,tokens:tokens.rows,integrations:integrations.rows});}catch(error){return next(error);}
});

router.post("/management/tokens",requireMfa,async(request,response,next)=>{
  try{const tenant=currentTenant(request);const raw=`gbp_${crypto.randomBytes(32).toString("base64url")}`;const hash=crypto.createHash("sha256").update(raw).digest("hex");const scopes=Array.isArray(request.body?.scopes)?request.body.scopes.map((item)=>cleanText(item,100)).filter((item)=>MANAGEMENT_SCOPES.has(item)).slice(0,50):[];if(!scopes.length)return response.status(400).json({success:false,message:"At least one supported management scope is required."});const result=await database.query(`INSERT INTO goodbase_management_tokens(organization_id,project_id,name,token_prefix,token_hash,scopes,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::int IS NULL THEN NULL ELSE NOW()+($7::text||' days')::interval END,$8) RETURNING id,name,token_prefix,scopes,status,expires_at,created_at`,[tenant.organizationId,request.body?.organizationWide===true?null:tenant.projectId,cleanText(request.body?.name,120),raw.slice(0,12),hash,scopes,request.body?.expiresInDays==null?null:boundedInteger(request.body.expiresInDays,90,1,365),request.user.id]);await audit(request,"goodbase.management.token.create","management_token",result.rows[0].id,{scopes});return response.status(201).json({success:true,token:result.rows[0],secret:raw,message:"Store this token now. Goodbase will not display it again."});}catch(error){return next(error);}
});

router.post("/management/operations",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const operationType=cleanText(request.body?.type,100);if(!OPERATION_TYPES.has(operationType))return response.status(400).json({success:false,message:"Unsupported management operation."});const destructive=/delete|rotate|restore/.test(operationType);if(destructive&&!request.auth?.mfaVerified&&!request.managementScopes?.includes("platform:privileged"))return response.status(428).json({success:false,code:"GOODBASE_PRIVILEGED_MFA_REQUIRED",message:"Verify MFA before this operation."});const idempotencyKey=cleanText(request.get("Idempotency-Key")||request.body?.idempotencyKey,200);if(!idempotencyKey)return response.status(400).json({success:false,message:"Idempotency-Key is required."});const result=await database.query(`INSERT INTO goodbase_management_operations(organization_id,project_id,environment_id,operation_type,idempotency_key,request_json,requested_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(organization_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,operationType,idempotencyKey,JSON.stringify(request.body?.parameters||{}),request.user.id]);await audit(request,"goodbase.management.operation.request","management_operation",result.rows[0].id,{operationType});return response.status(result.rows[0].status==="queued"?202:200).json({success:true,operation:result.rows[0]});}catch(error){return next(error);}
});

router.get("/domains",async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`SELECT domain.*,COALESCE(jsonb_agg(event ORDER BY event.created_at DESC) FILTER(WHERE event.id IS NOT NULL),'[]'::jsonb) AS events FROM goodbase_custom_domains domain LEFT JOIN goodbase_domain_events event ON event.domain_id=domain.id WHERE domain.organization_id=$1 AND domain.project_id=$2 AND domain.environment_id=$3 GROUP BY domain.id ORDER BY domain.created_at DESC`,[tenant.organizationId,tenant.projectId,tenant.environmentId]);return response.json({success:true,domains:result.rows});}catch(error){return next(error);}});

router.post("/domains",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const hostname=cleanText(request.body?.hostname,253).toLowerCase();if(!HOSTNAME.test(hostname)||hostname.endsWith(".goodos.app"))return response.status(400).json({success:false,message:"Provide a valid customer-owned hostname outside goodos.app."});const token=crypto.randomBytes(24).toString("base64url");const expectedName=`_goodbase-verification.${hostname}`;const expectedValue=`goodbase-verification=${token}`;const result=await database.query(`INSERT INTO goodbase_custom_domains(organization_id,project_id,environment_id,hostname,domain_type,target_hostname,verification_token_hash,expected_txt_name,expected_txt_value,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,hostname,domain_type,target_hostname,expected_txt_name,expected_txt_value,dns_status,certificate_status,activation_status,created_at`,[tenant.organizationId,tenant.projectId,tenant.environmentId,hostname,cleanText(request.body?.type,20)||"api",cleanText(request.body?.targetHostname,253)||"base.goodos.app",crypto.createHash("sha256").update(token).digest("hex"),expectedName,expectedValue,request.user.id]);await database.query(`INSERT INTO goodbase_domain_events(domain_id,event_type,status,detail_json,actor_id) VALUES($1,'domain.created','pending',$2::jsonb,$3)`,[result.rows[0].id,JSON.stringify({expectedName,targetHostname:result.rows[0].target_hostname}),request.user.id]);await audit(request,"goodbase.domain.create","custom_domain",result.rows[0].id,{hostname});return response.status(201).json({success:true,domain:result.rows[0]});}catch(error){if(error.code==="23505")error.statusCode=409;return next(error);}
});

router.post("/domains/:id/verify",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const domainResult=await database.query(`SELECT * FROM goodbase_custom_domains WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);const domain=domainResult.rows[0];if(!domain)return response.status(404).json({success:false,message:"Domain was not found."});const records=(await dns.resolveTxt(domain.expected_txt_name)).flat();const verified=records.includes(domain.expected_txt_value);await database.query(`UPDATE goodbase_custom_domains SET dns_status=$2,last_checked_at=NOW(),last_error=$3,certificate_status=CASE WHEN $2='verified' AND certificate_status='pending' THEN 'issuing' ELSE certificate_status END,updated_at=NOW() WHERE id=$1`,[domain.id,verified?"verified":"failed",verified?null:"Expected TXT verification record was not found."]);await database.query(`INSERT INTO goodbase_domain_events(domain_id,event_type,status,detail_json,actor_id) VALUES($1,'dns.verification',$2,$3::jsonb,$4)`,[domain.id,verified?"verified":"failed",JSON.stringify({recordsFound:records.length}),request.user.id]);return response.status(verified?200:409).json({success:verified,dnsStatus:verified?"verified":"failed"});}catch(error){if(["ENOTFOUND","ENODATA"].includes(error.code))return response.status(409).json({success:false,dnsStatus:"pending",message:"DNS verification record is not visible yet."});return next(error);}
});

router.post("/domains/:id/activate",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`UPDATE goodbase_custom_domains SET activation_status='activating',updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND dns_status='verified' AND certificate_status='ready' AND activation_status IN('inactive','failed') RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Domain requires verified DNS and a ready certificate before activation."});await audit(request,"goodbase.domain.activate","custom_domain",request.params.id);return response.status(202).json({success:true,domain:result.rows[0]});}catch(error){return next(error);}});

router.post("/domains/:id/deactivate",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`UPDATE goodbase_custom_domains SET activation_status='deactivating',updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND activation_status='active' RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Only an active domain can be deactivated."});await audit(request,"goodbase.domain.deactivate","custom_domain",request.params.id);return response.status(202).json({success:true,domain:result.rows[0]});}catch(error){return next(error);}});

router.get("/search/collections",async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`SELECT collection.*,(SELECT COUNT(*)::int FROM goodbase_vector_documents document WHERE document.collection_id=collection.id) AS document_count FROM goodbase_vector_collections collection WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY name`,[tenant.organizationId,tenant.projectId,tenant.environmentId]);return response.json({success:true,collections:result.rows});}catch(error){return next(error);}});

router.post("/search/collections",async(request,response,next)=>{try{const tenant=currentTenant(request);const dimensions=boundedInteger(request.body?.dimensions,1536,2,4096);const result=await database.query(`INSERT INTO goodbase_vector_collections(organization_id,project_id,environment_id,name,dimensions,distance_metric,index_type,provider,model,provider_secret_ref,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,cleanText(request.body?.name,120),dimensions,["cosine","inner_product","euclidean"].includes(request.body?.distanceMetric)?request.body.distanceMetric:"cosine",["hnsw","ivfflat","exact"].includes(request.body?.indexType)?request.body.indexType:"hnsw",cleanText(request.body?.provider,80)||null,cleanText(request.body?.model,120)||null,cleanText(request.body?.providerSecretRef,300)||null,request.user.id]);await audit(request,"goodbase.vector.collection.create","vector_collection",result.rows[0].id);return response.status(201).json({success:true,collection:result.rows[0]});}catch(error){if(error.code==="23505")error.statusCode=409;return next(error);}});

router.post("/search/collections/:id/documents",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const collectionResult=await database.query(`SELECT * FROM goodbase_vector_collections WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='active'`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);const collection=collectionResult.rows[0];if(!collection)return response.status(404).json({success:false,message:"Vector collection was not found."});const content=String(request.body?.content||"").trim();if(!content||Buffer.byteLength(content)>1024*1024)return response.status(400).json({success:false,message:"Document content must be between 1 byte and 1 MiB."});const embedding=request.body?.embedding?numericVector(request.body.embedding,collection.dimensions):null;const document=await database.query(`INSERT INTO goodbase_vector_documents(organization_id,project_id,environment_id,collection_id,external_id,content,metadata_json,embedding,embedding_model,embedding_status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) ON CONFLICT(collection_id,external_id) DO UPDATE SET content=EXCLUDED.content,metadata_json=EXCLUDED.metadata_json,embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,embedding_status=EXCLUDED.embedding_status,updated_at=NOW() RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,collection.id,cleanText(request.body?.externalId,200)||null,content,JSON.stringify(request.body?.metadata||{}),embedding,collection.model,embedding?"ready":"pending"]);if(!embedding)await database.query(`INSERT INTO goodbase_embedding_jobs(document_id) VALUES($1)`,[document.rows[0].id]);return response.status(202).json({success:true,document:document.rows[0],embeddingQueued:!embedding});}catch(error){return next(error);}
});

router.post("/search/collections/:id/query",async(request,response,next)=>{
  try{const tenant=currentTenant(request);const collectionResult=await database.query(`SELECT * FROM goodbase_vector_collections WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);const collection=collectionResult.rows[0];if(!collection)return response.status(404).json({success:false,message:"Vector collection was not found."});const mode=["keyword","semantic","hybrid"].includes(request.body?.mode)?request.body.mode:"hybrid";const query=cleanText(request.body?.query,2000);const queryVector=request.body?.embedding?numericVector(request.body.embedding,collection.dimensions):null;if(mode!=="keyword"&&!queryVector)return response.status(400).json({success:false,message:"Semantic and hybrid search require a query embedding."});const terms=query.toLowerCase().split(/\W+/).filter((item)=>item.length>1).slice(0,30);const documents=await database.query(`SELECT id,external_id,content,metadata_json,embedding,embedding_model,updated_at FROM goodbase_vector_documents WHERE collection_id=$1 AND organization_id=$2 ORDER BY updated_at DESC LIMIT 1000`,[collection.id,tenant.organizationId]);const results=documents.rows.map((document)=>{const keyword=terms.length?terms.filter((term)=>document.content.toLowerCase().includes(term)).length/terms.length:0;const semantic=queryVector&&document.embedding?vectorScore(queryVector,document.embedding.map(Number),collection.distance_metric):null;const score=mode==="keyword"?keyword:mode==="semantic"?(semantic??-Infinity):(keyword*0.35+(semantic??0)*0.65);return{...document,embedding:undefined,keywordScore:keyword,semanticScore:semantic,score};}).filter((item)=>Number.isFinite(item.score)&&item.score>=boundedNumber(request.body?.minimumScore,0,-1000000,1000000)).sort((a,b)=>b.score-a.score).slice(0,boundedInteger(request.body?.limit,20,1,100));return response.json({success:true,mode,results,count:results.length});}catch(error){return next(error);}
});

router.post("/search/collections/:id/rebuild",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`UPDATE goodbase_vector_collections SET status='building',updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status IN('active','degraded') RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Search index cannot be rebuilt in its current state."});await database.query(`INSERT INTO goodbase_search_index_events(collection_id,event_type,status,detail_json) VALUES($1,'index.rebuild','queued',$2::jsonb)`,[request.params.id,JSON.stringify({indexType:result.rows[0].index_type})]);await audit(request,"goodbase.vector.index.rebuild","vector_collection",request.params.id);return response.status(202).json({success:true,collection:result.rows[0]});}catch(error){return next(error);}});

router.get("/infrastructure",async(request,response,next)=>{try{const tenant=currentTenant(request);const [regions,nodes,policies,plans,incidents,limits]=await Promise.all([database.query(`SELECT * FROM goodbase_regions ORDER BY is_primary DESC,id`),database.query(`SELECT * FROM goodbase_service_nodes WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY region_id,service_type,node_name`,[tenant.organizationId,tenant.projectId,tenant.environmentId]),database.query(`SELECT * FROM goodbase_capacity_policies WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY region_id,service_type`,[tenant.organizationId,tenant.projectId,tenant.environmentId]),database.query(`SELECT * FROM goodbase_failover_plans WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY name`,[tenant.organizationId,tenant.projectId,tenant.environmentId]),database.query(`SELECT * FROM goodbase_incidents WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 100`,[tenant.organizationId]),database.query(`SELECT * FROM goodbase_service_limits WHERE organization_id=$1 AND (project_id IS NULL OR project_id=$2) ORDER BY plan_name,limit_key`,[tenant.organizationId,tenant.projectId])]);return response.json({success:true,regions:regions.rows,nodes:nodes.rows,capacityPolicies:policies.rows,failoverPlans:plans.rows,incidents:incidents.rows,serviceLimits:limits.rows});}catch(error){return next(error);}});

router.put("/infrastructure/capacity-policies",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const minimum=boundedInteger(request.body?.minimumNodes,1,1,100);const maximum=boundedInteger(request.body?.maximumNodes,3,minimum,500);const result=await database.query(`INSERT INTO goodbase_capacity_policies(organization_id,project_id,environment_id,service_type,region_id,minimum_nodes,maximum_nodes,target_utilization_percent,scale_up_cooldown_seconds,scale_down_cooldown_seconds,cpu_limit_millicores,memory_limit_mb,status,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13) ON CONFLICT(organization_id,project_id,environment_id,service_type,region_id) DO UPDATE SET minimum_nodes=EXCLUDED.minimum_nodes,maximum_nodes=EXCLUDED.maximum_nodes,target_utilization_percent=EXCLUDED.target_utilization_percent,scale_up_cooldown_seconds=EXCLUDED.scale_up_cooldown_seconds,scale_down_cooldown_seconds=EXCLUDED.scale_down_cooldown_seconds,cpu_limit_millicores=EXCLUDED.cpu_limit_millicores,memory_limit_mb=EXCLUDED.memory_limit_mb,status='active',updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,cleanText(request.body?.serviceType,40),cleanText(request.body?.regionId,40),minimum,maximum,boundedInteger(request.body?.targetUtilizationPercent,65,10,95),boundedInteger(request.body?.scaleUpCooldownSeconds,300,30,86400),boundedInteger(request.body?.scaleDownCooldownSeconds,900,60,86400),boundedInteger(request.body?.cpuLimitMillicores,1000,100,64000),boundedInteger(request.body?.memoryLimitMb,1024,128,262144),request.user.id]);await audit(request,"goodbase.infrastructure.capacity.update","capacity_policy",result.rows[0].id);return response.json({success:true,capacityPolicy:result.rows[0]});}catch(error){return next(error);}});

router.post("/infrastructure/failover-plans",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`INSERT INTO goodbase_failover_plans(organization_id,project_id,environment_id,name,service_type,primary_region_id,recovery_region_id,rto_minutes,rpo_minutes,automatic,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,cleanText(request.body?.name,120),cleanText(request.body?.serviceType,40),cleanText(request.body?.primaryRegionId,40),cleanText(request.body?.recoveryRegionId,40),boundedInteger(request.body?.rtoMinutes,60,1,10080),boundedInteger(request.body?.rpoMinutes,15,0,10080),request.body?.automatic===true,request.user.id]);await audit(request,"goodbase.infrastructure.failover_plan.create","failover_plan",result.rows[0].id);return response.status(201).json({success:true,failoverPlan:result.rows[0]});}catch(error){return next(error);}});

router.post("/infrastructure/incidents",async(request,response,next)=>{try{const tenant=currentTenant(request);const result=await database.query(`INSERT INTO goodbase_incidents(organization_id,project_id,environment_id,title,severity,public_message,internal_summary,affected_services,affected_regions,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,cleanText(request.body?.title,200),["minor","major","critical"].includes(request.body?.severity)?request.body.severity:"minor",cleanText(request.body?.publicMessage,2000)||null,cleanText(request.body?.internalSummary,5000)||null,Array.isArray(request.body?.affectedServices)?request.body.affectedServices.map((item)=>cleanText(item,80)).slice(0,50):[],Array.isArray(request.body?.affectedRegions)?request.body.affectedRegions.map((item)=>cleanText(item,80)).slice(0,50):[],request.user.id]);await audit(request,"goodbase.incident.create","incident",result.rows[0].id);return response.status(201).json({success:true,incident:result.rows[0]});}catch(error){return next(error);}});

router.post("/infrastructure/failover-plans/:id/events",requireMfa,async(request,response,next)=>{try{const tenant=currentTenant(request);const eventType=cleanText(request.body?.type,20);if(!["test","failover","failback"].includes(eventType))return response.status(400).json({success:false,message:"Unsupported failover event type."});const plan=await database.query(`SELECT id FROM goodbase_failover_plans WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status IN('active','failed_over','failed')`,[tenant.organizationId,tenant.projectId,tenant.environmentId,request.params.id]);if(!plan.rows[0])return response.status(404).json({success:false,message:"Failover plan was not found or is unavailable."});const result=await database.query(`INSERT INTO goodbase_failover_events(plan_id,event_type,initiated_by) VALUES($1,$2,$3) RETURNING *`,[request.params.id,eventType,request.user.id]);await audit(request,"goodbase.infrastructure.failover.request","failover_event",result.rows[0].id,{eventType});return response.status(202).json({success:true,event:result.rows[0]});}catch(error){return next(error);}});

module.exports = router;
