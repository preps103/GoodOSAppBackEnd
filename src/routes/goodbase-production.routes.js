"use strict";

const crypto = require("crypto");
const express = require("express");

const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const { logAudit } = require("../services/audit.service");
const {
  callController,
  runProductionVerification
} = require("../services/goodbase-production.service");

const router = express.Router();

function scope(request) {
  return {
    organizationId: request.tenantContext.organizationId,
    projectId: request.tenantContext.projectId,
    environmentId: request.tenantContext.environmentId
  };
}

function clean(value, maximum = 200) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function mfaRequired(request, response, next) {
  if (!request.auth?.mfaVerified) {
    return response.status(428).json({
      success: false,
      code: "GOODBASE_PRIVILEGED_MFA_REQUIRED",
      message: "Verify MFA before performing this privileged production action."
    });
  }
  return next();
}

async function audit(request, action, type, id, metadata = {}) {
  return logAudit({
    userId: request.user.id,
    appId: "goodbase",
    action,
    entityType: type,
    entityId: id,
    ipAddress: request.ip,
    metadata: { ...scope(request), ...metadata }
  });
}

router.use(authRequired, tenantContext, dataPlaneAdminRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const tenant = scope(request);
    const result = await database.query(
      `SELECT
        (SELECT status FROM goodbase_verification_runs WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at DESC LIMIT 1) AS verification_status,
        (SELECT COUNT(*)::int FROM goodbase_backup_artifacts_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='verified') AS verified_backups,
        (SELECT COUNT(*)::int FROM goodbase_restore_exercises_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='passed') AS passed_restores,
        (SELECT COUNT(*)::int FROM goodbase_sdk_releases WHERE status='active') AS published_sdks,
        (SELECT COUNT(*)::int FROM goodbase_sync_collections WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND status='active') AS sync_collections,
        (SELECT COUNT(*)::int FROM goodbase_controller_registrations WHERE status='ready') AS ready_controllers`,
      [tenant.organizationId, tenant.projectId, tenant.environmentId]
    );
    return response.json({
      success: true,
      phases: {
        productionVerification: 21,
        disasterRecovery: 22,
        sdkEcosystem: 23,
        offlineSync: 24,
        infrastructureControllers: 25
      },
      status: result.rows[0]
    });
  } catch (error) { return next(error); }
});

router.get("/verification/runs", async (request, response, next) => {
  try {
    const tenant = scope(request);
    const result = await database.query(
      `SELECT run.*,
        COALESCE((SELECT jsonb_agg(check_item ORDER BY check_item.checked_at)
          FROM goodbase_verification_checks check_item WHERE check_item.run_id=run.id),'[]'::jsonb) AS checks
       FROM goodbase_verification_runs run
       WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3
       ORDER BY created_at DESC LIMIT $4`,
      [tenant.organizationId, tenant.projectId, tenant.environmentId, integer(request.query.limit, 20, 1, 100)]
    );
    return response.json({ success: true, runs: result.rows });
  } catch (error) { return next(error); }
});

router.post("/verification/runs", mfaRequired, async (request, response, next) => {
  try {
    const result = await runProductionVerification({
      scope: scope(request),
      triggerType: "manual",
      requestedBy: request.user.id
    });
    await audit(request, "goodbase.production.verify", "verification_run", result.run.id, {
      status: result.run.status,
      criticalFailures: result.run.critical_failures
    });
    return response.status(result.run.status === "passed" ? 201 : 424).json({ success: result.run.status === "passed", ...result });
  } catch (error) { return next(error); }
});

router.get("/recovery", async (request, response, next) => {
  try {
    const tenant = scope(request);
    const [policy, backups, restores, replicas] = await Promise.all([
      database.query(`SELECT * FROM goodbase_recovery_policies_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT * FROM goodbase_backup_artifacts_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at DESC LIMIT 100`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT * FROM goodbase_restore_exercises_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY created_at DESC LIMIT 100`, [tenant.organizationId,tenant.projectId,tenant.environmentId]),
      database.query(`SELECT * FROM goodbase_replication_targets_v2 WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY region_id`, [tenant.organizationId,tenant.projectId,tenant.environmentId])
    ]);
    return response.json({ success:true,policy:policy.rows[0]||null,backups:backups.rows,restores:restores.rows,replicas:replicas.rows });
  } catch (error) { return next(error); }
});

router.put("/recovery/policy", mfaRequired, async (request, response, next) => {
  try {
    const tenant = scope(request);
    const provider = clean(request.body?.offsiteProvider, 80);
    const keyRef = clean(request.body?.encryptionKeyRef, 128);
    if (!provider || !/^[A-Z][A-Z0-9_]{2,127}$/.test(keyRef)) {
      return response.status(400).json({ success:false,message:"Offsite provider and an environment-backed encryption key reference are required." });
    }
    const result = await database.query(
      `INSERT INTO goodbase_recovery_policies_v2
        (organization_id,project_id,environment_id,full_backup_cron,wal_archive_enabled,retention_days,offsite_provider,secondary_provider,encryption_key_ref,rpo_minutes,rto_minutes,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
       ON CONFLICT(organization_id,project_id,environment_id) DO UPDATE SET
        full_backup_cron=EXCLUDED.full_backup_cron,wal_archive_enabled=EXCLUDED.wal_archive_enabled,
        retention_days=EXCLUDED.retention_days,offsite_provider=EXCLUDED.offsite_provider,
        secondary_provider=EXCLUDED.secondary_provider,encryption_key_ref=EXCLUDED.encryption_key_ref,
        rpo_minutes=EXCLUDED.rpo_minutes,rto_minutes=EXCLUDED.rto_minutes,status='active',updated_at=NOW()
       RETURNING *`,
      [tenant.organizationId,tenant.projectId,tenant.environmentId,clean(request.body?.fullBackupCron,80)||"0 2 * * *",
        request.body?.walArchiveEnabled!==false,integer(request.body?.retentionDays,30,1,3650),provider,
        clean(request.body?.secondaryProvider,80)||null,keyRef,integer(request.body?.rpoMinutes,15,0,10080),
        integer(request.body?.rtoMinutes,60,1,10080),request.user.id]
    );
    await audit(request,"goodbase.recovery.policy.update","recovery_policy",result.rows[0].id);
    return response.json({success:true,policy:result.rows[0]});
  } catch (error) { return next(error); }
});

async function readyController(type) {
  const result = await database.query(
    `SELECT * FROM goodbase_controller_registrations WHERE controller_type=$1 AND status='ready' ORDER BY updated_at DESC LIMIT 1`,
    [type]
  );
  return result.rows[0] || null;
}

router.post("/recovery/backups", mfaRequired, async (request, response, next) => {
  try {
    const tenant = scope(request);
    const controller = await readyController("recovery");
    if (!controller) return response.status(503).json({success:false,code:"GOODBASE_RECOVERY_CONTROLLER_UNAVAILABLE",message:"A verified recovery controller is required before a backup can be queued."});
    const artifact = await database.query(
      `INSERT INTO goodbase_backup_artifacts_v2(organization_id,project_id,environment_id,backup_type,status,expires_at,metadata_json)
       VALUES($1,$2,$3,$4,'queued',NOW()+INTERVAL '30 days',$5::jsonb) RETURNING *`,
      [tenant.organizationId,tenant.projectId,tenant.environmentId,["full","storage","configuration"].includes(request.body?.type)?request.body.type:"full",JSON.stringify({requestedBy:request.user.id})]
    );
    const operation = await queueControllerOperation(request, controller, "backup.create", { backupId:artifact.rows[0].id,type:artifact.rows[0].backup_type });
    return response.status(202).json({success:true,backup:artifact.rows[0],operation});
  } catch (error) { return next(error); }
});

router.post("/recovery/restores", mfaRequired, async (request, response, next) => {
  try {
    const tenant = scope(request);
    const controller = await readyController("recovery");
    if (!controller) return response.status(503).json({success:false,code:"GOODBASE_RECOVERY_CONTROLLER_UNAVAILABLE",message:"A verified recovery controller is required before a restore can be queued."});
    const targetType = clean(request.body?.targetType,40);
    if (!["isolated_verification","current_project","new_project","point_in_time","dr_server"].includes(targetType)) return response.status(400).json({success:false,message:"Choose a supported restore target."});
    const restore = await database.query(
      `INSERT INTO goodbase_restore_exercises_v2(organization_id,project_id,environment_id,backup_id,target_type,target_ref,requested_point_in_time,requested_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenant.organizationId,tenant.projectId,tenant.environmentId,request.body?.backupId||null,targetType,clean(request.body?.targetRef,300)||null,request.body?.pointInTime||null,request.user.id]
    );
    const operation = await queueControllerOperation(request,controller,"backup.restore",{restoreId:restore.rows[0].id,...request.body});
    return response.status(202).json({success:true,restore:restore.rows[0],operation});
  } catch (error) { return next(error); }
});

router.get("/sdks", async (_request, response, next) => {
  try {
    const result = await database.query(
      `SELECT id,language AS sdk,version,status,minimum_platform_version,
              COALESCE(package_ref,artifact_url) AS package_ref,source_commit,
              checksum_sha256,signed,test_report_json,capabilities_json,
              COALESCE(published_at,released_at) AS published_at,created_at
       FROM goodbase_sdk_releases ORDER BY language,COALESCE(published_at,released_at) DESC`
    );
    return response.json({success:true,releases:result.rows});
  } catch (error) { return next(error); }
});

router.post("/sdks/releases", mfaRequired, async (request, response, next) => {
  try {
    const sdk = clean(request.body?.sdk,30);
    if (!["javascript","node","react","nextjs","dart","swift","kotlin","python","csharp"].includes(sdk)) return response.status(400).json({success:false,message:"Unsupported official SDK."});
    const version=clean(request.body?.version,40);const packageRef=clean(request.body?.packageRef,500);const sourceCommit=clean(request.body?.sourceCommit,64);
    if(!version||!packageRef||!/^[0-9a-f]{7,64}$/.test(sourceCommit))return response.status(400).json({success:false,message:"Version, package reference, and a valid source commit are required."});
    const capabilities=Array.isArray(request.body?.capabilities)?request.body.capabilities.map((item)=>clean(item,80)).filter(Boolean).slice(0,100):[];
    const releaseId=`sdk_${sdk}_${version.replace(/[^a-zA-Z0-9]+/g,"_")}`;
    const result = await database.query(
      `INSERT INTO goodbase_sdk_releases(id,language,version,status,minimum_platform_version,artifact_url,package_ref,source_commit,capabilities_json,checksum_sha256,signed,test_report_json)
       VALUES($1,$2,$3,'preview',$4,$5,$5,$6,$7::jsonb,$8,$9,$10::jsonb) RETURNING *`,
      [releaseId,sdk,version,clean(request.body?.minimumPlatformVersion,80)||"1.0.0",packageRef,sourceCommit,
        JSON.stringify(capabilities),clean(request.body?.checksumSha256,64)||null,request.body?.signed===true,JSON.stringify(request.body?.testReport||{})]
    );
    await audit(request,"goodbase.sdk.release.register","sdk_release",result.rows[0].id,{sdk});
    return response.status(201).json({success:true,release:result.rows[0]});
  } catch (error) { if(error.code==="23505")error.statusCode=409; return next(error); }
});

router.get("/sync/collections", async (request, response, next) => {
  try {
    const tenant=scope(request);
    const result=await database.query(`SELECT * FROM goodbase_sync_collections WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 ORDER BY name`,[tenant.organizationId,tenant.projectId,tenant.environmentId]);
    return response.json({success:true,collections:result.rows});
  } catch(error){return next(error);}
});

router.post("/sync/collections", async (request, response, next) => {
  try {
    const tenant=scope(request);const name=clean(request.body?.name,120);
    if(!/^[a-z][a-z0-9_-]{1,119}$/.test(name))return response.status(400).json({success:false,message:"Collection names must use lowercase letters, numbers, underscores, or hyphens."});
    const policy=["reject","last_write_wins","merge"].includes(request.body?.conflictPolicy)?request.body.conflictPolicy:"reject";
    const result=await database.query(`INSERT INTO goodbase_sync_collections(organization_id,project_id,environment_id,name,conflict_policy,retention_days,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[tenant.organizationId,tenant.projectId,tenant.environmentId,name,policy,integer(request.body?.retentionDays,30,1,3650),request.user.id]);
    await audit(request,"goodbase.sync.collection.create","sync_collection",result.rows[0].id,{name});
    return response.status(201).json({success:true,collection:result.rows[0]});
  }catch(error){if(error.code==="23505")error.statusCode=409;return next(error);}
});

router.get("/sync/collections/:id/changes", async (request,response,next)=>{
  try{
    const tenant=scope(request);const cursor=integer(request.query.cursor,0,0,Number.MAX_SAFE_INTEGER);const limit=integer(request.query.limit,500,1,1000);
    const result=await database.query(`SELECT event.sequence_id,event.record_key,event.version,event.operation,event.value_json,event.created_at FROM goodbase_sync_events event JOIN goodbase_sync_collections collection ON collection.id=event.collection_id WHERE collection.id=$1 AND collection.organization_id=$2 AND collection.project_id=$3 AND collection.environment_id=$4 AND event.sequence_id>$5 ORDER BY event.sequence_id LIMIT $6`,[request.params.id,tenant.organizationId,tenant.projectId,tenant.environmentId,cursor,limit]);
    const nextCursor=result.rows.length?Number(result.rows[result.rows.length-1].sequence_id):cursor;
    return response.json({success:true,changes:result.rows,cursor:nextCursor,hasMore:result.rows.length===limit});
  }catch(error){return next(error);}
});

router.post("/sync/collections/:id/mutations", async (request,response,next)=>{
  const client=await database.pool.connect();
  try{
    const tenant=scope(request);const deviceId=clean(request.body?.deviceId,128);const mutations=Array.isArray(request.body?.mutations)?request.body.mutations.slice(0,100):[];
    if(!deviceId||!mutations.length)return response.status(400).json({success:false,message:"Device ID and at least one mutation are required."});
    await client.query("BEGIN");
    const collectionResult=await client.query(`SELECT * FROM goodbase_sync_collections WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4 AND status='active' FOR UPDATE`,[request.params.id,tenant.organizationId,tenant.projectId,tenant.environmentId]);
    const collection=collectionResult.rows[0];if(!collection){await client.query("ROLLBACK");return response.status(404).json({success:false,message:"Sync collection was not found."});}
    const results=[];
    for(const input of mutations){
      const idempotencyKey=clean(input.idempotencyKey,128);const recordKey=clean(input.recordKey,300);const operation=input.operation==="delete"?"delete":"upsert";
      if(!idempotencyKey||!recordKey)throw Object.assign(new Error("Every mutation needs idempotencyKey and recordKey."),{statusCode:400});
      const duplicate=await client.query(`SELECT id,status,result_version,conflict_json FROM goodbase_sync_mutations WHERE user_id=$1 AND device_id=$2 AND idempotency_key=$3`,[request.user.id,deviceId,idempotencyKey]);
      if(duplicate.rows[0]){results.push({...duplicate.rows[0],idempotencyKey,duplicate:true});continue;}
      const currentResult=await client.query(`SELECT * FROM goodbase_sync_records WHERE collection_id=$1 AND record_key=$2 FOR UPDATE`,[collection.id,recordKey]);const current=currentResult.rows[0]||null;
      const expected=input.expectedVersion==null?null:Number(input.expectedVersion);const versionMatches=expected==null||expected===Number(current?.version||0);
      const mutation=await client.query(`INSERT INTO goodbase_sync_mutations(collection_id,user_id,device_id,idempotency_key,record_key,operation,expected_version,base_value_json,value_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING *`,[collection.id,request.user.id,deviceId,idempotencyKey,recordKey,operation,Number.isFinite(expected)?expected:null,JSON.stringify(input.baseValue??null),JSON.stringify(input.value??null)]);
      if(!versionMatches&&collection.conflict_policy==="reject"){
        const conflict={expectedVersion:expected,currentVersion:Number(current?.version||0),currentValue:current?.value_json||null};
        await client.query(`UPDATE goodbase_sync_mutations SET status='conflict',conflict_json=$2::jsonb,applied_at=NOW() WHERE id=$1`,[mutation.rows[0].id,JSON.stringify(conflict)]);results.push({id:mutation.rows[0].id,idempotencyKey,status:"conflict",conflict});continue;
      }
      let value=input.value??{};
      if(!versionMatches&&collection.conflict_policy==="merge"&&current?.value_json&&value&&typeof value==="object"&&!Array.isArray(value))value={...current.value_json,...value};
      const nextVersion=Number(current?.version||0)+1;const deleted=operation==="delete";
      await client.query(`INSERT INTO goodbase_sync_records(collection_id,record_key,version,value_json,deleted,changed_by,changed_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,NOW()) ON CONFLICT(collection_id,record_key) DO UPDATE SET version=EXCLUDED.version,value_json=EXCLUDED.value_json,deleted=EXCLUDED.deleted,changed_by=EXCLUDED.changed_by,changed_at=NOW()`,[collection.id,recordKey,nextVersion,JSON.stringify(deleted?{}:value),deleted,request.user.id]);
      await client.query(`INSERT INTO goodbase_sync_events(collection_id,record_key,version,operation,value_json,mutation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[collection.id,recordKey,nextVersion,operation,JSON.stringify(deleted?null:value),mutation.rows[0].id]);
      await client.query(`UPDATE goodbase_sync_mutations SET status='applied',result_version=$2,applied_at=NOW() WHERE id=$1`,[mutation.rows[0].id,nextVersion]);results.push({id:mutation.rows[0].id,idempotencyKey,status:"applied",recordKey,version:nextVersion});
    }
    await client.query(`INSERT INTO goodbase_sync_cursors(collection_id,user_id,device_id,last_sequence_id,last_seen_at) VALUES($1,$2,$3,0,NOW()) ON CONFLICT(collection_id,user_id,device_id) DO UPDATE SET last_seen_at=NOW()`,[collection.id,request.user.id,deviceId]);
    await client.query("COMMIT");return response.json({success:true,results});
  }catch(error){await client.query("ROLLBACK").catch(()=>null);return next(error);}finally{client.release();}
});

router.get("/controllers",async(_request,response,next)=>{try{const result=await database.query(`SELECT id,controller_type,name,base_url,secret_ref,mtls_secret_ref,capabilities,status,last_health_at,last_health_json,created_at,updated_at FROM goodbase_controller_registrations ORDER BY controller_type,name`);return response.json({success:true,controllers:result.rows});}catch(error){return next(error);}});

router.post("/controllers",mfaRequired,async(request,response,next)=>{try{const type=clean(request.body?.type,30);if(!["infrastructure","recovery","hosting","domain","preview","regional","cdn","distribution","embedding","import"].includes(type))return response.status(400).json({success:false,message:"Unsupported controller type."});const baseUrl=new URL(clean(request.body?.baseUrl,500));if(baseUrl.protocol!=="https:"&&!["127.0.0.1","localhost"].includes(baseUrl.hostname))return response.status(400).json({success:false,message:"Controllers must use HTTPS."});const secretRef=clean(request.body?.secretRef,128);if(!/^[A-Z][A-Z0-9_]{2,127}$/.test(secretRef))return response.status(400).json({success:false,message:"Controller secretRef must name a server environment variable."});const result=await database.query(`INSERT INTO goodbase_controller_registrations(controller_type,name,base_url,secret_ref,mtls_secret_ref,capabilities,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(controller_type,name) DO UPDATE SET base_url=EXCLUDED.base_url,secret_ref=EXCLUDED.secret_ref,mtls_secret_ref=EXCLUDED.mtls_secret_ref,capabilities=EXCLUDED.capabilities,status='unverified',updated_at=NOW() RETURNING *`,[type,clean(request.body?.name,120),baseUrl.toString().replace(/\/$/,""),secretRef,clean(request.body?.mtlsSecretRef,128)||null,Array.isArray(request.body?.capabilities)?request.body.capabilities.map((item)=>clean(item,80)).slice(0,100):[],request.user.id]);await audit(request,"goodbase.controller.register","controller",result.rows[0].id,{type});return response.status(201).json({success:true,controller:result.rows[0]});}catch(error){return next(error);}});

router.post("/controllers/:id/probe",mfaRequired,async(request,response,next)=>{try{const result=await database.query(`SELECT * FROM goodbase_controller_registrations WHERE id=$1`,[request.params.id]);const controller=result.rows[0];if(!controller)return response.status(404).json({success:false,message:"Controller was not found."});try{const health=await callController(controller,"/health",{method:"GET"});const updated=await database.query(`UPDATE goodbase_controller_registrations SET status='ready',last_health_at=NOW(),last_health_json=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,[controller.id,JSON.stringify(health.payload)]);return response.json({success:true,controller:updated.rows[0]});}catch(error){await database.query(`UPDATE goodbase_controller_registrations SET status='offline',last_health_at=NOW(),last_health_json=$2::jsonb,updated_at=NOW() WHERE id=$1`,[controller.id,JSON.stringify({error:String(error.message).slice(0,300)})]);return response.status(503).json({success:false,message:"Controller health verification failed."});}}catch(error){return next(error);}});

async function queueControllerOperation(request,controller,type,parameters){const tenant=scope(request);const idempotencyKey=clean(request.get("Idempotency-Key")||request.body?.idempotencyKey,128)||crypto.randomUUID();const result=await database.query(`INSERT INTO goodbase_controller_operations(controller_id,organization_id,project_id,environment_id,operation_type,idempotency_key,request_json,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(controller_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,[controller.id,tenant.organizationId,tenant.projectId,tenant.environmentId,type,idempotencyKey,JSON.stringify(parameters||{}),request.user.id]);await audit(request,"goodbase.controller.operation.queue","controller_operation",result.rows[0].id,{type});return result.rows[0];}

router.post("/controllers/:id/operations",mfaRequired,async(request,response,next)=>{try{const result=await database.query(`SELECT * FROM goodbase_controller_registrations WHERE id=$1 AND status='ready'`,[request.params.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Only a verified ready controller can receive operations."});const type=clean(request.body?.type,120);if(!type)return response.status(400).json({success:false,message:"Operation type is required."});const operation=await queueControllerOperation(request,result.rows[0],type,request.body?.parameters||{});return response.status(202).json({success:true,operation});}catch(error){return next(error);}});

module.exports = router;
