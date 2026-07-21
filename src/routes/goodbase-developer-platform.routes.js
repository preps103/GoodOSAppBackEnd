"use strict";

const crypto = require("crypto");
const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const IDENTIFIER = /^[a-z][a-z0-9_-]{1,62}$/;

function tenant(request) {
  return {
    organizationId: request.tenantContext.organizationId,
    projectId: request.tenantContext.projectId,
    environmentId: request.tenantContext.environmentId
  };
}

function id(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) {
    const error = new Error(`Invalid ${label}.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function text(value, max = 500) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

async function audit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user.id,
    appId: "goodbase",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: { ...tenant(request), ...metadata }
  });
}

function privileged(request, response, next) {
  if (!request.auth?.mfaVerified) {
    return response.status(428).json({
      success: false,
      code: "GOODBASE_PRIVILEGED_MFA_REQUIRED",
      message: "Verify MFA before approving migrations, promotions, or destructive preview actions."
    });
  }
  return next();
}

function analyzeSql(sql) {
  const source = String(sql || "").trim();
  if (!source || Buffer.byteLength(source) > 1024 * 1024) {
    const error = new Error("Migration SQL must be between 1 byte and 1 MiB.");
    error.statusCode = 400;
    throw error;
  }
  const statements = source.split(";").map((item) => item.trim()).filter(Boolean);
  const destructive = statements.filter((statement) => /\b(DROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)|TRUNCATE|ALTER\s+TABLE\b[\s\S]*\bDROP\b)\b/i.test(statement));
  const forbidden = statements.filter((statement) => /\b(COPY\s+.*PROGRAM|CREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS\s+)?(?:dblink|file_fdw)|ALTER\s+(?:SYSTEM|ROLE)|CREATE\s+ROLE|DROP\s+ROLE)\b/i.test(statement));
  const createsTable = statements.filter((statement) => /^CREATE\s+TABLE\b/i.test(statement)).length;
  const enablesRls = statements.filter((statement) => /ALTER\s+TABLE\b[\s\S]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(statement)).length;
  return {
    statements: statements.length,
    destructiveChanges: destructive.length,
    forbiddenOperations: forbidden.length,
    rlsWarnings: Math.max(0, createsTable - enablesRls),
    warnings: [
      ...(destructive.length ? ["Migration contains destructive operations and requires explicit approval."] : []),
      ...(createsTable > enablesRls ? ["One or more new tables do not enable row-level security in this migration."] : []),
      ...(forbidden.length ? ["Migration contains an operation prohibited by the hosted migration runner."] : [])
    ]
  };
}

router.use(authRequired, tenantContext, dataPlaneAdminRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const t = tenant(request);
    const result = await database.query(
      `SELECT
        (SELECT COUNT(*)::int FROM goodbase_auth_channels WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='enabled') AS auth_channels,
        (SELECT COUNT(*)::int FROM goodbase_local_projects WHERE organization_id=$1 AND project_id=$2 AND status<>'revoked') AS local_projects,
        (SELECT COUNT(*)::int FROM goodbase_sdk_releases WHERE status='active') AS sdk_releases,
        (SELECT COUNT(*)::int FROM goodbase_migration_plans WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3) AS migration_plans,
        (SELECT COUNT(*)::int FROM goodbase_preview_environments WHERE organization_id=$1 AND project_id=$2 AND status NOT IN ('deleted','failed')) AS previews`,
      [t.organizationId, t.projectId, t.environmentId]
    );
    return response.json({ success: true, phases: { authentication: 11, localDevelopment: 12, sdks: 13, migrations: 14, previews: 15 }, metrics: result.rows[0] });
  } catch (error) { return next(error); }
});

router.get("/auth/channels", async (request, response, next) => {
  try {
    const t = tenant(request);
    const [channels, policy, hooks] = await Promise.all([
      database.query(`SELECT id,channel_type,provider,status,configuration_json,created_at,updated_at FROM goodbase_auth_channels WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY channel_type,provider`, [t.organizationId,t.projectId,t.environmentId]),
      database.query(`SELECT * FROM goodbase_auth_security_policies WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 LIMIT 1`, [t.organizationId,t.projectId,t.environmentId]),
      database.query(`SELECT id,event_type,target_type,target_ref,timeout_ms,fail_mode,status,created_at,updated_at FROM goodbase_auth_hooks WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY event_type`, [t.organizationId,t.projectId,t.environmentId])
    ]);
    return response.json({ success:true,channels:channels.rows,policy:policy.rows[0]||null,hooks:hooks.rows });
  } catch (error) { return next(error); }
});

router.patch("/auth/channels/:id", async (request, response, next) => {
  try {
    const t=tenant(request); const status=["enabled","disabled"].includes(request.body?.status)?request.body.status:null;
    if(!status) return response.status(400).json({success:false,message:"Status must be enabled or disabled."});
    const result=await database.query(`UPDATE goodbase_auth_channels SET status=$5,updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 RETURNING id,channel_type,provider,status,configuration_json,updated_at`,[t.organizationId,t.projectId,t.environmentId,request.params.id,status]);
    if(!result.rows[0]) return response.status(404).json({success:false,message:"Authentication channel was not found."});
    await audit(request,"goodbase.auth.channel.update","auth_channel",result.rows[0].id,{status});
    return response.json({success:true,channel:result.rows[0]});
  } catch(error){return next(error);}
});

router.get("/sdks", async (_request,response,next)=>{
  try{const result=await database.query(`SELECT id,language,version,status,minimum_platform_version,artifact_url,checksum_sha256,capabilities_json,changelog,released_at FROM goodbase_sdk_releases ORDER BY language,released_at DESC`);return response.json({success:true,releases:result.rows});}catch(error){return next(error);}
});

router.get("/migrations", async (request,response,next)=>{
  try{const t=tenant(request);const result=await database.query(`SELECT plan.*,COALESCE(jsonb_agg(step ORDER BY step.sequence) FILTER(WHERE step.id IS NOT NULL),'[]'::jsonb) AS steps FROM goodbase_migration_plans plan LEFT JOIN goodbase_migration_steps step ON step.plan_id=plan.id WHERE plan.organization_id=$1 AND plan.project_id=$2 AND plan.environment_id=$3 GROUP BY plan.id ORDER BY plan.created_at DESC LIMIT 100`,[t.organizationId,t.projectId,t.environmentId]);return response.json({success:true,plans:result.rows});}catch(error){return next(error);}
});

router.post("/migrations/validate", async (request,response,next)=>{
  const client=await database.pool.connect();
  try{
    const t=tenant(request);const name=text(request.body?.name,120);const fileName=text(request.body?.fileName,240);const sql=String(request.body?.sql||"");
    if(!name||!fileName) return response.status(400).json({success:false,message:"Migration name and file name are required."});
    const analysis=analyzeSql(sql);const checksum=crypto.createHash("sha256").update(sql).digest("hex");
    await client.query("BEGIN");
    const plan=await client.query(`INSERT INTO goodbase_migration_plans(organization_id,project_id,environment_id,name,status,source_revision,destructive_change_count,rls_warning_count,validation_json,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,[t.organizationId,t.projectId,t.environmentId,name,analysis.forbiddenOperations?"rejected":"validated",text(request.body?.sourceRevision,120)||null,analysis.destructiveChanges,analysis.rlsWarnings,JSON.stringify(analysis),request.user.id]);
    await client.query(`INSERT INTO goodbase_migration_steps(plan_id,sequence,file_name,checksum_sha256,sql_text,rollback_guidance,status) VALUES($1,1,$2,$3,$4,$5,$6)`,[plan.rows[0].id,fileName,checksum,sql,text(request.body?.rollbackGuidance,2000)||null,analysis.forbiddenOperations?"pending":"validated"]);
    await client.query("COMMIT");await audit(request,"goodbase.migration.validate","migration_plan",plan.rows[0].id,{checksum,analysis});
    return response.status(201).json({success:true,plan:plan.rows[0],checksum,analysis});
  }catch(error){await client.query("ROLLBACK");return next(error);}finally{client.release();}
});

router.post("/migrations/:id/approve",privileged,async(request,response,next)=>{
  try{const t=tenant(request);const result=await database.query(`UPDATE goodbase_migration_plans SET status='approved',approved_by=$5,approved_at=NOW(),updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='validated' RETURNING *`,[t.organizationId,t.projectId,t.environmentId,request.params.id,request.user.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Only a validated migration can be approved."});await audit(request,"goodbase.migration.approve","migration_plan",request.params.id);return response.json({success:true,plan:result.rows[0]});}catch(error){return next(error);}
});

router.get("/previews",async(request,response,next)=>{
  try{const t=tenant(request);const result=await database.query(`SELECT preview.*,COALESCE(jsonb_agg(resource ORDER BY resource.resource_type) FILTER(WHERE resource.id IS NOT NULL),'[]'::jsonb) AS resources FROM goodbase_preview_environments preview LEFT JOIN goodbase_preview_resources resource ON resource.preview_id=preview.id WHERE preview.organization_id=$1 AND preview.project_id=$2 GROUP BY preview.id ORDER BY preview.created_at DESC LIMIT 100`,[t.organizationId,t.projectId]);return response.json({success:true,previews:result.rows});}catch(error){return next(error);}
});

router.post("/previews",async(request,response,next)=>{
  const client=await database.pool.connect();
  try{
    const t=tenant(request);const slug=id(request.body?.slug||request.body?.name,"preview slug");const previewId=`preview_${crypto.randomUUID().replaceAll("-","")}`;const databaseName=`goodbase_preview_${crypto.randomBytes(8).toString("hex")}`;const secretRef=`secret://goodbase/previews/${previewId}/database`;
    const ttl=integer(request.body?.ttlHours,72,1,720);const base=`https://${slug}.preview.base.goodos.app`;
    await client.query("BEGIN");
    const result=await client.query(`INSERT INTO goodbase_preview_environments(id,organization_id,project_id,source_environment_id,name,slug,pull_request_ref,source_revision,status,database_name,credential_secret_ref,api_url,auth_url,storage_namespace,realtime_tenant,function_namespace,cpu_limit_millicores,memory_limit_mb,storage_limit_mb,auto_pause_minutes,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW()+make_interval(hours=>$20),$21) RETURNING *`,[previewId,t.organizationId,t.projectId,t.environmentId,text(request.body?.name,120)||slug,slug,text(request.body?.pullRequestRef,120)||null,text(request.body?.sourceRevision,120)||"working-tree",databaseName,secretRef,base,`${base}/auth/v1`,`preview/${previewId}`,previewId,previewId,integer(request.body?.cpuMillicores,500,100,4000),integer(request.body?.memoryMb,512,128,8192),integer(request.body?.storageMb,1024,128,102400),integer(request.body?.autoPauseMinutes,60,5,10080),ttl,request.user.id]);
    for(const type of ["database","credentials","auth","storage","realtime","function"]){await client.query(`INSERT INTO goodbase_preview_resources(preview_id,resource_type,resource_ref,status) VALUES($1,$2,$3,'requested')`,[previewId,type,type==="database"?databaseName:type==="credentials"?secretRef:`${type}:${previewId}`]);}
    await client.query(`INSERT INTO goodbase_preview_events(preview_id,event_type,status,detail_json,actor_id) VALUES($1,'preview.requested','accepted',$2::jsonb,$3)`,[previewId,JSON.stringify({sourceRevision:request.body?.sourceRevision||"working-tree",ttlHours:ttl}),request.user.id]);
    await client.query("COMMIT");await audit(request,"goodbase.preview.create","preview_environment",previewId,{slug,sourceRevision:request.body?.sourceRevision||null});
    return response.status(202).json({success:true,preview:result.rows[0],message:"Preview provisioning was queued for the isolated environment provisioner."});
  }catch(error){await client.query("ROLLBACK");if(error.code==="23505")error.statusCode=409;return next(error);}finally{client.release();}
});

router.post("/previews/:id/promote",privileged,async(request,response,next)=>{
  try{const t=tenant(request);const result=await database.query(`UPDATE goodbase_preview_environments SET status='promoting',updated_at=NOW() WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND source_environment_id=$3 AND status='ready' AND COALESCE((health_json->>'ready')::boolean,FALSE)=TRUE RETURNING *`,[t.organizationId,t.projectId,t.environmentId,request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Only a healthy, ready preview can enter the promotion workflow."});await database.query(`INSERT INTO goodbase_preview_events(preview_id,event_type,status,detail_json,actor_id) VALUES($1,'preview.promotion.requested','queued',$2::jsonb,$3)`,[request.params.id,JSON.stringify({targetEnvironmentId:t.environmentId}),request.user.id]);await audit(request,"goodbase.preview.promote","preview_environment",request.params.id);return response.status(202).json({success:true,preview:result.rows[0]});}catch(error){return next(error);}
});

router.delete("/previews/:id",privileged,async(request,response,next)=>{
  try{const t=tenant(request);const result=await database.query(`UPDATE goodbase_preview_environments SET status='deleting',updated_at=NOW() WHERE id=$3 AND organization_id=$1 AND project_id=$2 AND status NOT IN ('deleted','deleting','promoting') RETURNING id,status`,[t.organizationId,t.projectId,request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Preview cannot be deleted in its current state."});await audit(request,"goodbase.preview.delete","preview_environment",request.params.id);return response.status(202).json({success:true,preview:result.rows[0]});}catch(error){return next(error);}
});

module.exports = router;
