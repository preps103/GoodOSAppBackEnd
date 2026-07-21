"use strict";

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const IDENTIFIER = /^[a-z][a-z0-9_-]{1,62}$/;
const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i;
const UPLOAD_ROOT = process.env.GOODBASE_UPLOAD_ROOT || "/var/lib/goodbase/uploads";
const FUNCTION_ROOT = process.env.GOODBASE_FUNCTION_ROOT || "/var/lib/goodbase/functions";

function identifier(value, label) {
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

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function bool(value, fallback = false) {
  if ([true, "true", 1, "1"].includes(value)) return true;
  if ([false, "false", 0, "0"].includes(value)) return false;
  return fallback;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function context(request) {
  return {
    organizationId: request.tenantContext.organizationId,
    projectId: request.tenantContext.projectId,
    environmentId: request.tenantContext.environmentId,
  };
}

async function audit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user.id,
    appId: "goodbase",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: { ...context(request), ...metadata },
  });
}

router.use(authRequired, tenantContext, dataPlaneAdminRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const tenant = context(request);
    const result = await database.query(
      `SELECT
        (SELECT COUNT(*)::int FROM goodbase_queues WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status<>'deleted') AS queues,
        (SELECT COUNT(*)::int FROM goodbase_queue_messages WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status IN ('available','leased')) AS queue_depth,
        (SELECT COUNT(*)::int FROM goodbase_schedules WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='active') AS active_schedules,
        (SELECT COUNT(*)::int FROM goodbase_backup_policies WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='active') AS backup_policies,
        (SELECT COUNT(*)::int FROM goodbase_upload_sessions WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status IN ('created','uploading')) AS active_uploads,
        (SELECT COUNT(*)::int FROM goodbase_edge_functions WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='active') AS edge_functions,
        (SELECT COUNT(*)::int FROM goodbase_edge_runtimes WHERE status='online' AND last_heartbeat_at>NOW()-INTERVAL '2 minutes') AS online_runtimes`,
      [tenant.organizationId, tenant.projectId, tenant.environmentId]
    );
    return response.json({ success: true, phases: { queues: 6, schedules: 7, recovery: 8, storage: 9, edge: 10 }, metrics: result.rows[0] });
  } catch (error) { return next(error); }
});

router.get("/queues", async (request, response, next) => {
  try {
    const tenant = context(request);
    const result = await database.query(
      `SELECT queue.*,
        COUNT(message.id) FILTER (WHERE message.status='available')::int AS available,
        COUNT(message.id) FILTER (WHERE message.status='leased')::int AS leased,
        COUNT(message.id) FILTER (WHERE message.status='dead_lettered')::int AS dead_lettered,
        EXTRACT(EPOCH FROM NOW()-MIN(message.created_at) FILTER (WHERE message.status='available'))::int AS oldest_seconds
       FROM goodbase_queues queue LEFT JOIN goodbase_queue_messages message ON message.queue_id=queue.id
       WHERE queue.organization_id=$1 AND queue.project_id=$2 AND queue.environment_id=$3 AND queue.status<>'deleted'
       GROUP BY queue.id ORDER BY queue.created_at`,
      [tenant.organizationId, tenant.projectId, tenant.environmentId]
    );
    return response.json({ success: true, queues: result.rows });
  } catch (error) { return next(error); }
});

router.post("/queues", async (request, response, next) => {
  try {
    const tenant = context(request);
    const name = identifier(request.body?.name, "queue name");
    const id = `queue_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await database.query(
      `INSERT INTO goodbase_queues(id,name,organization_id,project_id,environment_id,visibility_timeout_seconds,max_attempts,max_payload_bytes,retention_seconds,created_by,metadata_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11::jsonb) RETURNING *`,
      [id, name, tenant.organizationId, tenant.projectId, tenant.environmentId,
        integer(request.body?.visibilityTimeoutSeconds,60,1,86400), integer(request.body?.maxAttempts,5,1,100),
        integer(request.body?.maxPayloadBytes,262144,1024,10485760), integer(request.body?.retentionSeconds,1209600,3600,31536000),
        request.user.id, JSON.stringify(object(request.body?.metadata))]
    );
    await audit(request,"goodbase.queue.create","queue",id);
    return response.status(201).json({ success: true, queue: result.rows[0] });
  } catch (error) { return next(error); }
});

router.post("/queues/:id/messages", async (request, response, next) => {
  try {
    const result = await database.query(
      `SELECT goodbase_queue_send($1,$2::jsonb,$3,$4,$5) AS id`,
      [text(request.params.id,100), JSON.stringify(object(request.body?.payload)), text(request.body?.idempotencyKey,200) || null,
        integer(request.body?.delaySeconds,0,0,31536000), integer(request.body?.priority,100,0,1000)]
    );
    await audit(request,"goodbase.queue.message.send","queue",request.params.id,{ messageId: result.rows[0].id });
    return response.status(202).json({ success: true, messageId: result.rows[0].id });
  } catch (error) { return next(error); }
});

router.post("/queues/:id/receive", async (request, response, next) => {
  try {
    const result = await database.query(
      `SELECT * FROM goodbase_queue_receive($1,$2,$3,$4)`,
      [text(request.params.id,100), text(request.body?.consumerId,200), integer(request.body?.limit,1,1,100),
        request.body?.visibilitySeconds == null ? null : integer(request.body.visibilitySeconds,60,1,86400)]
    );
    return response.json({ success: true, messages: result.rows });
  } catch (error) { return next(error); }
});

router.post("/queues/messages/:id/ack", async (request, response, next) => {
  try {
    const result = await database.query(`SELECT goodbase_queue_ack($1::uuid,$2::uuid,$3) AS acknowledged`,
      [request.params.id, request.body?.leaseToken, bool(request.body?.archive,true)]);
    return response.status(result.rows[0].acknowledged ? 200 : 409).json({ success: result.rows[0].acknowledged });
  } catch (error) { return next(error); }
});

router.post("/queues/messages/:id/nack", async (request, response, next) => {
  try {
    const result = await database.query(`SELECT goodbase_queue_nack($1::uuid,$2::uuid,$3) AS released`,
      [request.params.id, request.body?.leaseToken, text(request.body?.error,2000)]);
    return response.status(result.rows[0].released ? 200 : 409).json({ success: result.rows[0].released });
  } catch (error) { return next(error); }
});

router.get("/schedules", async (request, response, next) => {
  try {
    const tenant = context(request);
    const result = await database.query(
      `SELECT schedule.*,
        (SELECT jsonb_agg(run ORDER BY run.created_at DESC) FROM (SELECT * FROM goodbase_schedule_runs WHERE schedule_id=schedule.id ORDER BY created_at DESC LIMIT 10) run) AS recent_runs
       FROM goodbase_schedules schedule WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at`,
      [tenant.organizationId,tenant.projectId,tenant.environmentId]
    );
    return response.json({ success:true,schedules:result.rows });
  } catch(error){ return next(error); }
});

router.post("/schedules", async (request,response,next)=>{
  try{
    const tenant=context(request); const targetType=text(request.body?.targetType,30);
    if(!["sql_function","http","edge_function","queue"].includes(targetType)) return response.status(400).json({success:false,message:"Unsupported schedule target."});
    const targetRef=text(request.body?.targetRef,1000);
    if(targetType==="http"&&!HTTPS_URL.test(targetRef)) return response.status(400).json({success:false,message:"Scheduled HTTP targets must use HTTPS."});
    const cron=text(request.body?.cronExpression,100)||null; const interval=request.body?.intervalSeconds==null?null:integer(request.body.intervalSeconds,60,10,31536000);
    if(Boolean(cron)===Boolean(interval)) return response.status(400).json({success:false,message:"Provide exactly one cronExpression or intervalSeconds."});
    const id=`schedule_${crypto.randomUUID().replaceAll("-","")}`;
    const result=await database.query(
      `INSERT INTO goodbase_schedules(id,name,organization_id,project_id,environment_id,target_type,target_ref,cron_expression,interval_seconds,timezone,concurrency_limit,timeout_seconds,max_attempts,payload_json,headers_json,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::uuid) RETURNING *`,
      [id,identifier(request.body?.name,"schedule name"),tenant.organizationId,tenant.projectId,tenant.environmentId,targetType,targetRef,cron,interval,
        text(request.body?.timezone,80)||"UTC",integer(request.body?.concurrencyLimit,1,1,100),integer(request.body?.timeoutSeconds,60,1,3600),integer(request.body?.maxAttempts,3,1,20),
        JSON.stringify(object(request.body?.payload)),JSON.stringify(object(request.body?.headers)),request.user.id]
    );
    await audit(request,"goodbase.schedule.create","schedule",id,{targetType});
    return response.status(201).json({success:true,schedule:result.rows[0]});
  }catch(error){return next(error);}
});

router.patch("/schedules/:id/status",async(request,response,next)=>{
  try{const status=text(request.body?.status,20);if(!["active","paused","disabled"].includes(status))return response.status(400).json({success:false,message:"Invalid schedule status."});
    const tenant=context(request);const result=await database.query(`UPDATE goodbase_schedules SET status=$2,updated_at=NOW() WHERE id=$1 AND organization_id=$3 AND project_id=$4 AND environment_id=$5 RETURNING *`,[request.params.id,status,tenant.organizationId,tenant.projectId,tenant.environmentId]);
    return response.status(result.rowCount?200:404).json({success:Boolean(result.rowCount),schedule:result.rows[0]});
  }catch(error){return next(error);}
});

router.get("/recovery",async(request,response,next)=>{
  try{const tenant=context(request);const result=await database.query(
    `SELECT policy.*,
      (SELECT MIN(recoverable_at) FROM goodbase_recovery_points WHERE policy_id=policy.id AND status='available') AS earliest_recovery,
      (SELECT MAX(recoverable_at) FROM goodbase_recovery_points WHERE policy_id=policy.id AND status='available') AS latest_recovery,
      (SELECT MAX(completed_at) FROM goodbase_dr_exercises WHERE policy_id=policy.id AND status='passed') AS last_verified_restore
     FROM goodbase_backup_policies policy WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3`,[tenant.organizationId,tenant.projectId,tenant.environmentId]);
    const archiver=await database.query(`SELECT archived_count,failed_count,last_archived_wal,last_archived_time,last_failed_wal,last_failed_time FROM pg_stat_archiver`);
    return response.json({success:true,policies:result.rows,walArchiver:archiver.rows[0]});
  }catch(error){return next(error);}
});

router.put("/recovery/policy",async(request,response,next)=>{
  try{const tenant=context(request);const keyRef=text(request.body?.encryptionKeyRef,300);if(!/^env:\/[A-Z0-9_]+$/i.test(keyRef))return response.status(400).json({success:false,message:"encryptionKeyRef must use env://VARIABLE."});
    const id=`backup_${tenant.projectId}_${tenant.environmentId}`.slice(0,100);const result=await database.query(
      `INSERT INTO goodbase_backup_policies(id,organization_id,project_id,environment_id,daily_enabled,retention_days,pitr_enabled,wal_archive_enabled,offsite_required,restore_verify_hours,rpo_minutes,rto_minutes,encryption_key_ref)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(organization_id,project_id,environment_id) DO UPDATE SET daily_enabled=EXCLUDED.daily_enabled,retention_days=EXCLUDED.retention_days,pitr_enabled=EXCLUDED.pitr_enabled,wal_archive_enabled=EXCLUDED.wal_archive_enabled,offsite_required=EXCLUDED.offsite_required,restore_verify_hours=EXCLUDED.restore_verify_hours,rpo_minutes=EXCLUDED.rpo_minutes,rto_minutes=EXCLUDED.rto_minutes,encryption_key_ref=EXCLUDED.encryption_key_ref,updated_at=NOW() RETURNING *`,
      [id,tenant.organizationId,tenant.projectId,tenant.environmentId,bool(request.body?.dailyEnabled,true),integer(request.body?.retentionDays,30,1,3650),bool(request.body?.pitrEnabled,true),bool(request.body?.walArchiveEnabled,true),bool(request.body?.offsiteRequired,true),integer(request.body?.restoreVerifyHours,24,1,720),integer(request.body?.rpoMinutes,5,1,1440),integer(request.body?.rtoMinutes,60,1,10080),keyRef]);
    await audit(request,"goodbase.recovery.policy.upsert","backup_policy",id);return response.json({success:true,policy:result.rows[0]});
  }catch(error){return next(error);}
});

router.post("/recovery/exercises",async(request,response,next)=>{
  try{const type=text(request.body?.type,40);if(!["restore_verify","pitr","replica_promotion","regional_failover"].includes(type))return response.status(400).json({success:false,message:"Unsupported recovery exercise."});
    const result=await database.query(`INSERT INTO goodbase_dr_exercises(policy_id,exercise_type,target_recovery_point,evidence_json) VALUES($1,$2,$3,$4::jsonb) RETURNING *`,[text(request.body?.policyId,100),type,request.body?.targetRecoveryPoint||null,JSON.stringify(object(request.body?.evidence))]);
    return response.status(202).json({success:true,exercise:result.rows[0]});
  }catch(error){return next(error);}
});

router.post("/storage/uploads",async(request,response,next)=>{
  try{const tenant=context(request);const protocol=text(request.body?.protocol||"tus",30);if(!["tus","s3_multipart"].includes(protocol))return response.status(400).json({success:false,message:"Unsupported upload protocol."});
    const result=await database.query(`INSERT INTO goodbase_upload_sessions(organization_id,project_id,environment_id,bucket_id,object_key,protocol,content_type,upload_length,part_size_bytes,expires_at,created_by,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+make_interval(secs=>$10),$11::uuid,$12::jsonb) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,text(request.body?.bucketId,100),text(request.body?.objectKey,1000),protocol,text(request.body?.contentType,200),integer(request.body?.uploadLength,0,1,53687091200),integer(request.body?.partSizeBytes,8388608,5242880,536870912),integer(request.body?.expiresSeconds,86400,300,604800),request.user.id,JSON.stringify(object(request.body?.metadata))]);
    return response.status(201).json({success:true,upload:result.rows[0],location:`/api/goodbase/v1/platform/storage/uploads/${result.rows[0].id}`});
  }catch(error){return next(error);}
});

router.head("/storage/uploads/:id", async (request, response, next) => {
  try {
    const tenant=context(request);const result=await database.query(`SELECT upload_offset,upload_length,status,expires_at FROM goodbase_upload_sessions WHERE id=$1::uuid AND organization_id=$2 AND project_id=$3 AND environment_id=$4`,[request.params.id,tenant.organizationId,tenant.projectId,tenant.environmentId]);
    if(!result.rowCount)return response.sendStatus(404);const upload=result.rows[0];
    response.set({"Tus-Resumable":"1.0.0","Upload-Offset":String(upload.upload_offset),"Upload-Length":String(upload.upload_length),"Upload-Expires":new Date(upload.expires_at).toUTCString(),"Cache-Control":"no-store"});
    return response.sendStatus(upload.status==="expired"?410:204);
  }catch(error){return next(error);}
});

router.patch("/storage/uploads/:id", express.raw({type:"application/offset+octet-stream",limit:"64mb"}), async (request,response,next)=>{
  try{
    const tenant=context(request);const result=await database.query(`SELECT * FROM goodbase_upload_sessions WHERE id=$1::uuid AND organization_id=$2 AND project_id=$3 AND environment_id=$4 FOR UPDATE`,[request.params.id,tenant.organizationId,tenant.projectId,tenant.environmentId]);
    if(!result.rowCount)return response.sendStatus(404);const upload=result.rows[0];
    if(upload.protocol!=="tus")return response.status(409).json({success:false,message:"Upload session is not TUS."});
    if(new Date(upload.expires_at)<=new Date())return response.sendStatus(410);
    const offset=integer(request.headers["upload-offset"],-1,-1,Number.MAX_SAFE_INTEGER);if(offset!==Number(upload.upload_offset))return response.status(409).set("Upload-Offset",String(upload.upload_offset)).json({success:false,message:"Upload offset mismatch."});
    const chunk=Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0);if(!chunk.length)return response.status(400).json({success:false,message:"Upload chunk is empty."});
    const nextOffset=offset+chunk.length;if(nextOffset>Number(upload.upload_length))return response.status(413).json({success:false,message:"Chunk exceeds declared upload length."});
    const sessionDirectory=path.join(UPLOAD_ROOT,request.params.id);fs.mkdirSync(sessionDirectory,{recursive:true,mode:0o750});
    const partNumber=Math.floor(offset/Math.max(Number(upload.part_size_bytes),1))+1;const partPath=path.join(sessionDirectory,`${String(partNumber).padStart(6,"0")}-${offset}.part`);
    fs.writeFileSync(partPath,chunk,{flag:"wx",mode:0o640});const checksum=crypto.createHash("sha256").update(chunk).digest("hex");
    await database.query(`INSERT INTO goodbase_upload_parts(session_id,part_number,byte_start,byte_end,size_bytes,checksum_sha256,storage_ref) VALUES($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,part_number) DO NOTHING`,[request.params.id,partNumber,offset,nextOffset-1,chunk.length,checksum,partPath]);
    await database.query(`UPDATE goodbase_upload_sessions SET status=CASE WHEN $2=upload_length THEN 'completed' ELSE 'uploading' END,upload_offset=$2,updated_at=NOW() WHERE id=$1::uuid`,[request.params.id,nextOffset]);
    response.set({"Tus-Resumable":"1.0.0","Upload-Offset":String(nextOffset),"Cache-Control":"no-store"});return response.sendStatus(204);
  }catch(error){return next(error);}
});

router.put("/storage/uploads/:id/parts/:part",async(request,response,next)=>{
  try{const checksum=text(request.body?.checksumSha256,64);if(!/^[a-f0-9]{64}$/i.test(checksum))return response.status(400).json({success:false,message:"A SHA-256 checksum is required."});
    const result=await database.query(`INSERT INTO goodbase_upload_parts(session_id,part_number,byte_start,byte_end,size_bytes,checksum_sha256,storage_ref) VALUES($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,part_number) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256,storage_ref=EXCLUDED.storage_ref,size_bytes=EXCLUDED.size_bytes RETURNING *`,[request.params.id,integer(request.params.part,1,1,10000),integer(request.body?.byteStart,0,0,Number.MAX_SAFE_INTEGER),integer(request.body?.byteEnd,0,0,Number.MAX_SAFE_INTEGER),integer(request.body?.sizeBytes,0,1,536870912),checksum,text(request.body?.storageRef,1500)]);
    await database.query(`UPDATE goodbase_upload_sessions SET status='uploading',upload_offset=(SELECT COALESCE(SUM(size_bytes),0) FROM goodbase_upload_parts WHERE session_id=$1::uuid),updated_at=NOW() WHERE id=$1::uuid`,[request.params.id]);
    return response.json({success:true,part:result.rows[0]});
  }catch(error){return next(error);}
});

router.post("/storage/uploads/:id/complete",async(request,response,next)=>{
  try{const result=await database.query(`UPDATE goodbase_upload_sessions SET status=CASE WHEN upload_offset=upload_length THEN 'completed' ELSE status END,checksum_sha256=$2,updated_at=NOW() WHERE id=$1::uuid RETURNING *`,[request.params.id,text(request.body?.checksumSha256,64)]);if(!result.rowCount)return response.status(404).json({success:false,message:"Upload not found."});if(result.rows[0].status!=="completed")return response.status(409).json({success:false,message:"Upload is incomplete.",upload:result.rows[0]});
    await database.query(`INSERT INTO goodbase_storage_security_events(bucket_id,object_key,event_type) VALUES($1,$2,'scan_requested')`,[result.rows[0].bucket_id,result.rows[0].object_key]);return response.json({success:true,upload:result.rows[0],scanStatus:"queued"});
  }catch(error){return next(error);}
});

router.post("/storage/transforms",async(request,response,next)=>{
  try{const spec={bucketId:text(request.body?.bucketId,100),objectKey:text(request.body?.objectKey,1000),width:integer(request.body?.width,0,1,8192),height:integer(request.body?.height,0,1,8192),fit:text(request.body?.fit||"cover",20),format:text(request.body?.format||"webp",20),quality:integer(request.body?.quality,80,1,100)};const cacheKey=crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const result=await database.query(`INSERT INTO goodbase_image_transforms(bucket_id,object_key,width,height,fit,format,quality,signed,cache_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(cache_key) DO UPDATE SET cache_key=EXCLUDED.cache_key RETURNING *`,[spec.bucketId,spec.objectKey,spec.width,spec.height,spec.fit,spec.format,spec.quality,bool(request.body?.signed,true),cacheKey]);return response.status(202).json({success:true,transform:result.rows[0]});
  }catch(error){return next(error);}
});

router.post("/storage/cache/purge",async(request,response,next)=>{
  try{const bucket=text(request.body?.bucketId,100);const key=text(request.body?.objectKey,1000);await database.query(`INSERT INTO goodbase_cdn_events(bucket_id,object_key,event_type,edge_region) VALUES($1,$2,'purge',$3)`,[bucket,key,text(request.body?.region||"global",100)]);await audit(request,"goodbase.storage.cache.purge","storage_object",`${bucket}/${key}`);return response.status(202).json({success:true,status:"queued"});}catch(error){return next(error);}
});

router.get("/edge/functions",async(request,response,next)=>{
  try{const tenant=context(request);const result=await database.query(`SELECT function.*,(SELECT jsonb_agg(version ORDER BY version.version DESC) FROM goodbase_edge_versions version WHERE version.function_id=function.id) AS versions FROM goodbase_edge_functions function WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at`,[tenant.organizationId,tenant.projectId,tenant.environmentId]);return response.json({success:true,functions:result.rows,runtime:"deno@2.8.1"});}catch(error){return next(error);}
});

router.post("/edge/functions",async(request,response,next)=>{
  try{const tenant=context(request);const networkPolicy=text(request.body?.networkPolicy||"deny",20);if(!["deny","allowlist"].includes(networkPolicy))return response.status(400).json({success:false,message:"Invalid network policy."});const id=`edge_${crypto.randomUUID().replaceAll("-","")}`;const result=await database.query(`INSERT INTO goodbase_edge_functions(id,organization_id,project_id,environment_id,name,timeout_ms,memory_mb,cpu_ms,concurrency_limit,request_limit_bytes,response_limit_bytes,network_policy,network_allowlist,secret_refs,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::uuid) RETURNING *`,[id,tenant.organizationId,tenant.projectId,tenant.environmentId,identifier(request.body?.name,"function name"),integer(request.body?.timeoutMs,10000,100,300000),integer(request.body?.memoryMb,128,32,2048),integer(request.body?.cpuMs,1000,10,300000),integer(request.body?.concurrencyLimit,10,1,1000),integer(request.body?.requestLimitBytes,1048576,1024,10485760),integer(request.body?.responseLimitBytes,6291456,1024,10485760),networkPolicy,JSON.stringify(Array.isArray(request.body?.networkAllowlist)?request.body.networkAllowlist:[]),JSON.stringify(Array.isArray(request.body?.secretRefs)?request.body.secretRefs:[]),request.user.id]);return response.status(201).json({success:true,function:result.rows[0]});}catch(error){return next(error);}
});

router.post("/edge/functions/:id/versions",async(request,response,next)=>{
  try{
    const functionId=identifier(request.params.id,"function id");
    const source=String(request.body?.source||"");if(!source||Buffer.byteLength(source)>5*1024*1024)return response.status(400).json({success:false,message:"Function source is required and must not exceed 5 MiB."});
    const bundleSha=crypto.createHash("sha256").update(source).digest("hex");const next=await database.query(`SELECT COALESCE(MAX(version),0)+1 AS version FROM goodbase_edge_versions WHERE function_id=$1`,[functionId]);const version=Number(next.rows[0].version);
    const directory=path.join(FUNCTION_ROOT,functionId);fs.mkdirSync(directory,{recursive:true,mode:0o755});const bundleRef=`/${functionId}/${version}.ts`;const absolutePath=path.join(FUNCTION_ROOT,functionId,`${version}.ts`);fs.writeFileSync(absolutePath,source,{flag:"wx",mode:0o644});
    try{const result=await database.query(`INSERT INTO goodbase_edge_versions(function_id,version,bundle_sha256,bundle_ref) VALUES($1,$2,$3,$4) RETURNING *`,[functionId,version,bundleSha,bundleRef]);return response.status(201).json({success:true,version:result.rows[0]});}
    catch(error){fs.rmSync(absolutePath,{force:true});throw error;}
  }catch(error){return next(error);}
});

router.post("/edge/functions/:id/deploy",async(request,response,next)=>{
  try{const version=integer(request.body?.version,0,1,1000000);const result=await database.query(`INSERT INTO goodbase_edge_deployments(function_id,version,region,traffic_percent,status,rollback_version) VALUES($1,$2,$3,$4,'ready',(SELECT active_version FROM goodbase_edge_functions WHERE id=$1)) RETURNING *`,[request.params.id,version,text(request.body?.region||"us-west",100),integer(request.body?.trafficPercent,100,0,100)]);if(integer(request.body?.trafficPercent,100,0,100)===100)await database.query(`UPDATE goodbase_edge_functions SET active_version=$2,updated_at=NOW() WHERE id=$1`,[request.params.id,version]);return response.status(202).json({success:true,deployment:result.rows[0]});}catch(error){return next(error);}
});

router.get("/edge/runtime/health", async (request, response) => {
  const endpoint = process.env.GOODBASE_EDGE_RUNTIME_URL || "http://127.0.0.1:8500";
  try {
    const result = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
    const payload = await result.json();
    return response.status(result.ok ? 200 : 503).json({ success: result.ok, endpoint, runtime: payload });
  } catch {
    return response.status(503).json({ success: false, endpoint, message: "Isolated edge runtime is unavailable." });
  }
});

router.post("/edge/functions/:id/invoke", async (request, response, next) => {
  const invocationId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const functionResult = await database.query(
      `SELECT function.*, version.bundle_ref, version.version
       FROM goodbase_edge_functions function
       JOIN goodbase_edge_versions version ON version.function_id=function.id AND version.version=function.active_version
       WHERE function.id=$1 AND function.status='active'`,
      [request.params.id]
    );
    if (!functionResult.rowCount) return response.status(404).json({ success: false, message: "Active function version not found." });
    const fn = functionResult.rows[0];
    const requestBytes = Buffer.byteLength(JSON.stringify(request.body?.input ?? {}));
    if (requestBytes > fn.request_limit_bytes) return response.status(413).json({ success: false, message: "Function request exceeds its configured limit." });
    await database.query(
      `INSERT INTO goodbase_edge_invocations(id,function_id,version,request_id,status,region,request_bytes)
       VALUES($1::uuid,$2,$3,$4,'running',$5,$6)`,
      [invocationId, fn.id, fn.version, request.id || null, text(request.body?.region || "us-west",100), requestBytes]
    );
    const endpoint = process.env.GOODBASE_EDGE_RUNTIME_URL || "http://127.0.0.1:8500";
    const runtimeResponse = await fetch(`${endpoint}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(fn.timeout_ms + 2500),
      body: JSON.stringify({
        functionId: fn.id, version: fn.version, bundleRef: fn.bundle_ref,
        timeoutMs: fn.timeout_ms, responseLimitBytes: fn.response_limit_bytes,
        networkPolicy: fn.network_policy, networkAllowlist: fn.network_allowlist,
        input: request.body?.input ?? {},
      }),
    });
    const payload = await runtimeResponse.json();
    const durationMs = Date.now() - startedAt;
    await database.query(
      `UPDATE goodbase_edge_invocations SET status=$2,duration_ms=$3,response_bytes=$4,error_code=$5,finished_at=NOW() WHERE id=$1::uuid`,
      [invocationId, runtimeResponse.ok ? "succeeded" : payload.code === "FUNCTION_TIMEOUT" ? "timed_out" : "failed",
        durationMs, Buffer.byteLength(JSON.stringify(payload)), payload.code || null]
    );
    await audit(request,"goodbase.edge.invoke","edge_function",fn.id,{invocationId,version:fn.version,durationMs});
    return response.status(runtimeResponse.status).json({ invocationId, ...payload });
  } catch (error) {
    await database.query(`UPDATE goodbase_edge_invocations SET status='failed',duration_ms=$2,error_code='RUNTIME_UNAVAILABLE',finished_at=NOW() WHERE id=$1::uuid`,[invocationId,Date.now()-startedAt]).catch(()=>null);
    return next(error);
  }
});

module.exports = router;
