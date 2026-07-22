"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const database = require("../config/database");

const exportRoot = path.resolve(process.env.GOODBASE_TELEMETRY_PRIVACY_ROOT || "/var/lib/goodapp-backend/telemetry-privacy");
const externalStores = new Set(["prometheus","loki","tempo"]);
const allowedStores = new Set(["analytics","sessions","crashes","browser",...externalStores]);

function scopeValues(scope){return[scope.organizationId,scope.projectId,scope.environmentId];}
function validUuid(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||""));}
function cleanHash(value){const text=String(value||"").trim().toLowerCase();return /^[0-9a-f]{64}$/.test(text)?text:null;}
function safeArtifact(requestId){const file=path.resolve(exportRoot,`${requestId}.json`);if(!file.startsWith(`${exportRoot}${path.sep}`))throw new Error("Privacy artifact path is invalid.");return file;}

async function createRequest({scope,action,userId,subjectHash,requestedBy,targetStores}){
  if(!["export","delete"].includes(action))throw Object.assign(new Error("Privacy action must be export or delete."),{statusCode:400});
  const normalizedUser=validUuid(userId)?String(userId):null,normalizedHash=cleanHash(subjectHash);
  if(!normalizedUser&&!normalizedHash)throw Object.assign(new Error("A valid user ID or subject hash is required."),{statusCode:400});
  const stores=Array.isArray(targetStores)&&targetStores.length?targetStores.map(String):["analytics","sessions","crashes","browser","prometheus","loki","tempo"];
  if(stores.length>20||stores.some(store=>!allowedStores.has(store)))throw Object.assign(new Error("A telemetry target store is invalid."),{statusCode:400});
  const result=await database.query(`INSERT INTO goodbase_telemetry_privacy_requests(organization_id,project_id,environment_id,action,subject_hash,user_id,requested_by,target_stores) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,action,status,target_stores,created_at`,[...scopeValues(scope),action,normalizedHash,normalizedUser,requestedBy,stores]);
  return result.rows[0];
}

async function controllerRequest(request){
  const endpoint=process.env.GOODBASE_TELEMETRY_PRIVACY_CONTROLLER_URL,secret=process.env.GOODBASE_TELEMETRY_PRIVACY_SIGNING_SECRET;
  if(!endpoint||!secret)return null;
  const url=new URL(endpoint);if(url.protocol!=="https:")throw new Error("Telemetry privacy controller must use HTTPS.");
  const payload=JSON.stringify(request),timestamp=String(Date.now()),nonce=crypto.randomUUID();
  const signature=crypto.createHmac("sha256",secret).update(`${timestamp}.${nonce}.${payload}`).digest("hex");
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),20000);
  try{
    const response=await fetch(url,{method:"POST",signal:abort.signal,headers:{"Content-Type":"application/json","X-Goodbase-Timestamp":timestamp,"X-Goodbase-Nonce":nonce,"X-Goodbase-Signature":`sha256=${signature}`,"Idempotency-Key":request.idempotencyKey},body:payload});
    const body=await response.json().catch(()=>({}));
    if(!response.ok||body.completed!==true)throw new Error(body.message||`Privacy controller returned HTTP ${response.status}.`);
    return{requestId:body.requestId||null,checksum:body.checksum||null,completed:true};
  }finally{clearTimeout(timer);}
}

async function activeHold(client,row){
  const result=await client.query(`SELECT id FROM backend_legal_holds WHERE organization_id=$1 AND status='active' AND (scope_type='organization' OR (scope_type='user' AND scope_id=$2)) LIMIT 1`,[row.organization_id,row.user_id?String(row.user_id):""]);
  return result.rows[0]?.id||null;
}

async function exportDatabase(client,row){
  const scope=[row.organization_id,row.project_id,row.environment_id],identity=[row.user_id,row.subject_hash];
  const [events,sessions,crashes,traces]=await Promise.all([
    client.query(`SELECT * FROM goodbase_analytics_events WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5)) ORDER BY occurred_at LIMIT 50000`,[...scope,...identity]),
    client.query(`SELECT * FROM goodbase_analytics_sessions WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5)) ORDER BY started_at LIMIT 50000`,[...scope,...identity]),
    client.query(`SELECT occurrence.* FROM goodbase_crash_occurrences occurrence JOIN goodbase_crash_issues issue ON issue.id=occurrence.issue_id WHERE issue.organization_id=$1 AND issue.project_id=$2 AND issue.environment_id=$3 AND (($4::uuid IS NOT NULL AND occurrence.user_id=$4) OR ($5::text IS NOT NULL AND occurrence.subject_hash=$5)) ORDER BY occurrence.occurred_at LIMIT 50000`,[...scope,...identity]),
    client.query(`SELECT * FROM goodbase_performance_traces WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5)) ORDER BY occurred_at LIMIT 50000`,[...scope,...identity]),
  ]);
  return{schemaVersion:1,requestId:row.id,generatedAt:new Date().toISOString(),analytics:events.rows,sessions:sessions.rows,crashes:crashes.rows,browserPerformance:traces.rows,limits:{rowsPerStore:50000}};
}

async function deleteDatabase(client,row){
  const scope=[row.organization_id,row.project_id,row.environment_id],identity=[row.user_id,row.subject_hash],counts={};
  const crashes=await client.query(`DELETE FROM goodbase_crash_occurrences occurrence USING goodbase_crash_issues issue WHERE issue.id=occurrence.issue_id AND issue.organization_id=$1 AND issue.project_id=$2 AND issue.environment_id=$3 AND (($4::uuid IS NOT NULL AND occurrence.user_id=$4) OR ($5::text IS NOT NULL AND occurrence.subject_hash=$5))`,[...scope,...identity]);counts.crashes=crashes.rowCount;
  const events=await client.query(`DELETE FROM goodbase_analytics_events WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5))`,[...scope,...identity]);counts.analytics=events.rowCount;
  const sessions=await client.query(`DELETE FROM goodbase_analytics_sessions WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5))`,[...scope,...identity]);counts.sessions=sessions.rowCount;
  const traces=await client.query(`DELETE FROM goodbase_performance_traces WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND (($4::uuid IS NOT NULL AND user_id=$4) OR ($5::text IS NOT NULL AND subject_hash=$5))`,[...scope,...identity]);counts.browser=traces.rowCount;
  await client.query(`DELETE FROM goodbase_crash_issues issue WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND NOT EXISTS(SELECT 1 FROM goodbase_crash_occurrences occurrence WHERE occurrence.issue_id=issue.id)`,scope);
  return counts;
}

async function processRequest({scope,requestId}){
  const client=await database.pool.connect();
  try{
    await client.query("BEGIN");
    const found=await client.query(`SELECT * FROM goodbase_telemetry_privacy_requests WHERE id=$4 AND organization_id=$1 AND project_id=$2 AND environment_id=$3 FOR UPDATE`,[...scopeValues(scope),requestId]);
    const row=found.rows[0];if(!row)throw Object.assign(new Error("Telemetry privacy request not found."),{statusCode:404});
    if(row.status==="completed"){await client.query("COMMIT");return{request:row,alreadyCompleted:true};}
    const hold=await activeHold(client,row);if(hold){await client.query(`UPDATE goodbase_telemetry_privacy_requests SET status='blocked',legal_hold_id=$2,failure_reason='Active legal hold prevents processing.' WHERE id=$1`,[row.id,hold]);await client.query("COMMIT");return{requestId:row.id,status:"blocked",legalHoldId:hold};}
    const external=row.target_stores.filter(store=>externalStores.has(store));
    if(external.length&&(!process.env.GOODBASE_TELEMETRY_PRIVACY_CONTROLLER_URL||!process.env.GOODBASE_TELEMETRY_PRIVACY_SIGNING_SECRET)){
      await client.query(`UPDATE goodbase_telemetry_privacy_requests SET status='blocked',failure_reason='External telemetry privacy controller is not configured.' WHERE id=$1`,[row.id]);await client.query("COMMIT");return{requestId:row.id,status:"blocked",missingController:true};
    }
    await client.query(`UPDATE goodbase_telemetry_privacy_requests SET status='processing',failure_reason=NULL WHERE id=$1`,[row.id]);await client.query("COMMIT");
    const externalEvidence=external.length?await controllerRequest({operation:row.action,requestId:row.id,subjectHash:row.subject_hash,userId:row.user_id,stores:external,idempotencyKey:`telemetry-privacy:${row.id}:${row.action}`}):null;
    await client.query("BEGIN");
    let artifactRef=null,checksum=null,databaseEvidence;
    if(row.action==="export"){
      const payload=await exportDatabase(client,row),encoded=JSON.stringify(payload),target=safeArtifact(row.id),staging=`${target}.${process.pid}.tmp`;
      await fs.promises.mkdir(exportRoot,{recursive:true,mode:0o750});await fs.promises.writeFile(staging,encoded,{mode:0o640,flag:"wx"});await fs.promises.rename(staging,target);
      artifactRef=target;checksum=crypto.createHash("sha256").update(encoded).digest("hex");databaseEvidence={counts:{analytics:payload.analytics.length,sessions:payload.sessions.length,crashes:payload.crashes.length,browser:payload.browserPerformance.length}};
    }else databaseEvidence={deleted:await deleteDatabase(client,row)};
    const evidence={database:databaseEvidence,external:externalEvidence,completedAt:new Date().toISOString()};
    const updated=await client.query(`UPDATE goodbase_telemetry_privacy_requests SET status='completed',evidence_json=$2::jsonb,artifact_ref=$3,checksum_sha256=$4,completed_at=NOW(),failure_reason=NULL WHERE id=$1 RETURNING id,action,status,target_stores,evidence_json,artifact_ref,checksum_sha256,completed_at`,[row.id,JSON.stringify(evidence),artifactRef,checksum]);
    await client.query("COMMIT");return{request:updated.rows[0]};
  }catch(error){try{await client.query("ROLLBACK");await client.query(`UPDATE goodbase_telemetry_privacy_requests SET status='failed',failure_reason=$2 WHERE id=$1 AND status='processing'`,[requestId,String(error.code||error.message).slice(0,500)]);}catch{}throw error;}finally{client.release();}
}

module.exports={createRequest,processRequest,allowedStores,externalStores};
