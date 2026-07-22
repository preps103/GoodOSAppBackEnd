"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const product = require("../services/goodbase-product.service");
const symbolication = require("../services/goodbase-symbolication.service");

const publicRouter = express.Router();
const authenticatedRouter = express.Router();
const publicLimiter = rateLimit({ windowMs:60000,limit:120,standardHeaders:true,legacyHeaders:false });
const symbolUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1,fields:10}});
function scope(request){return request.tenantContext||product.DEFAULT_SCOPE;}
function values(tenant){return[tenant.organizationId,tenant.projectId,tenant.environmentId];}
function where(alias=""){const p=alias?`${alias}.`:"";return`${p}organization_id=$1 AND ${p}project_id=$2 AND ${p}environment_id=$3`;}
function clean(value,max=200){return product.clean(value,max);}
function bounded(value,max=65536){return product.boundedJson(value,max);}
function mfaRequired(request,response,next){if(!request.auth?.mfaVerified)return response.status(428).json({success:false,code:"GOODBASE_PRIVILEGED_MFA_REQUIRED",message:"Verify MFA before changing production controls."});return next();}

publicRouter.get("/in-app/:appId",publicLimiter,async(request,response,next)=>{try{
  const tenant=product.DEFAULT_SCOPE,subject=clean(request.query.subject,200)||request.ip,subjectHash=crypto.createHash("sha256").update(`${request.params.appId}:${subject}`).digest("hex");
  const result=await database.query(`SELECT campaign.id,campaign.name,campaign.message_type,campaign.content_json,campaign.localization_json,campaign.deep_link,campaign.conversion_event,campaign.frequency_cap,campaign.ends_at
    FROM goodbase_in_app_campaigns campaign WHERE ${where("campaign")} AND campaign.app_id=$4 AND campaign.status='active'
    AND (campaign.starts_at IS NULL OR campaign.starts_at<=NOW()) AND (campaign.ends_at IS NULL OR campaign.ends_at>NOW())
    AND NOT EXISTS(SELECT 1 FROM goodbase_in_app_suppressions suppression WHERE suppression.campaign_id=campaign.id AND suppression.subject_hash=$5 AND (suppression.expires_at IS NULL OR suppression.expires_at>NOW()))
    ORDER BY campaign.created_at DESC LIMIT 10`,[...values(tenant),clean(request.params.appId,100),subjectHash]);
  response.set("Cache-Control","private, no-store");return response.json({success:true,subjectHash,campaigns:result.rows});
}catch(error){return next(error);}});

publicRouter.get("/evidence/releases/:commit",publicLimiter,async(request,response,next)=>{try{
  const commit=clean(request.params.commit,64);if(!/^[0-9a-f]{7,64}$/.test(commit))return response.status(400).json({success:false,message:"A valid release commit is required."});
  const result=await database.query(`SELECT evidence_type,release_commit,status,checksum_sha256,verified_at,expires_at FROM goodbase_release_evidence WHERE release_commit=$1 ORDER BY evidence_type,verified_at DESC`,[commit]);
  return response.json({success:true,releaseCommit:commit,evidence:result.rows});
}catch(error){return next(error);}});

authenticatedRouter.use(authRequired,tenantContext);
authenticatedRouter.post("/in-app/:campaignId/events",publicLimiter,async(request,response,next)=>{try{
  const tenant=scope(request),eventType=clean(request.body?.eventType,30);if(!["eligible","impression","click","dismiss","conversion"].includes(eventType))return response.status(400).json({success:false,message:"Invalid message event type."});
  const campaign=await database.query(`SELECT id,app_id FROM goodbase_in_app_campaigns WHERE id=$4 AND ${where()}`,[...values(tenant),request.params.campaignId]);if(!campaign.rows[0])return response.status(404).json({success:false,message:"Campaign not found."});
  const subjectHash=product.subjectHash({appId:campaign.rows[0].app_id,userId:request.user.id});await database.query(`INSERT INTO goodbase_in_app_impressions(organization_id,project_id,environment_id,campaign_id,subject_hash,event_type,context_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[...values(tenant),campaign.rows[0].id,subjectHash,eventType,JSON.stringify(bounded(request.body?.context,16384))]);
  return response.status(202).json({success:true,recorded:true});
}catch(error){return next(error);}});

authenticatedRouter.use(dataPlaneAdminRequired);
authenticatedRouter.post("/telemetry/symbol-files",mfaRequired,symbolUpload.single("sourceMap"),async(request,response,next)=>{try{
  if(!request.file)return response.status(400).json({success:false,message:"A Source Map v3 file is required."});
  const symbolFile=await symbolication.saveSourceMap({scope:scope(request),releaseId:request.body?.releaseId,contents:request.file.buffer});
  return response.status(201).json({success:true,symbolFile});
}catch(error){return next(error);}});
authenticatedRouter.get("/studio/overview",async(request,response,next)=>{try{
  const tenant=scope(request),params=values(tenant),result=await database.query(`SELECT
    (SELECT COUNT(*)::int FROM goodbase_distribution_providers WHERE ${where()} AND status='ready') ready_distribution_providers,
    (SELECT COUNT(*)::int FROM goodbase_device_test_runs WHERE ${where()} AND status='passed') passed_device_tests,
    (SELECT COUNT(*)::int FROM goodbase_analytics_events WHERE ${where()}) analytics_events,
    (SELECT COUNT(*)::int FROM goodbase_crash_issues WHERE ${where()} AND status IN('open','regressed')) open_crashes,
    (SELECT COUNT(*)::int FROM goodbase_performance_traces WHERE ${where()}) performance_traces,
    (SELECT COUNT(*)::int FROM goodbase_in_app_campaigns WHERE ${where()} AND status='active') active_in_app_campaigns,
    (SELECT COUNT(*)::int FROM goodbase_hosting_projects WHERE ${where()} AND status='ready') ready_hosting_projects,
    (SELECT COUNT(*)::int FROM goodbase_controller_registrations WHERE status='ready') ready_controllers`,params);
  const metrics=result.rows[0];return response.json({success:true,scope:tenant,metrics,readiness:{distribution:metrics.ready_distribution_providers>0&&metrics.passed_device_tests>0,telemetry:metrics.analytics_events>0,personalization:metrics.active_in_app_campaigns>0,hosting:metrics.ready_hosting_projects>0&&metrics.ready_controllers>0}});
}catch(error){return next(error);}});

authenticatedRouter.get("/distribution/dashboard",async(request,response,next)=>{try{const tenant=scope(request),params=values(tenant);const [providers,builds,tests,feedback]=await Promise.all([
  database.query(`SELECT id,provider_type,status,capabilities_json,last_health_at FROM goodbase_distribution_providers WHERE ${where()} ORDER BY provider_type`,params),
  database.query(`SELECT id,app_id,platform,artifact_type,version,build_number,status,expires_at,created_at FROM goodbase_distribution_builds WHERE ${where()} ORDER BY created_at DESC LIMIT 100`,params),
  database.query(`SELECT id,build_id,test_type,matrix_json,status,attempts,result_json,artifacts_json,created_at,completed_at FROM goodbase_device_test_runs WHERE ${where()} ORDER BY created_at DESC LIMIT 100`,params),
  database.query(`SELECT id,build_id,rating,message,status,created_at FROM goodbase_tester_feedback WHERE ${where()} ORDER BY created_at DESC LIMIT 100`,params)]);
  return response.json({success:true,providers:providers.rows,builds:builds.rows,deviceTests:tests.rows,feedback:feedback.rows});}catch(error){return next(error);}});

authenticatedRouter.get("/analytics/dashboard",async(request,response,next)=>{try{const tenant=scope(request),params=values(tenant);const result=await database.query(`SELECT COUNT(*)::int events,COUNT(DISTINCT subject_hash)::int users,COUNT(DISTINCT session_id)::int sessions,COALESCE(SUM(revenue_amount),0) revenue,COUNT(*) FILTER(WHERE event_type='conversion')::int conversions,MIN(occurred_at) first_event_at,MAX(occurred_at) last_event_at FROM goodbase_analytics_events WHERE ${where()} AND occurred_at>=NOW()-INTERVAL '30 days'`,params);const exports=await database.query(`SELECT destination_type,status,last_export_at,last_error FROM goodbase_analytics_exports WHERE ${where()} ORDER BY updated_at DESC`,params);return response.json({success:true,windowDays:30,metrics:result.rows[0],warehouseExports:exports.rows});}catch(error){return next(error);}});
authenticatedRouter.get("/telemetry/dashboard",async(request,response,next)=>{try{const tenant=scope(request),params=values(tenant);const result=await database.query(`SELECT (SELECT COUNT(*)::int FROM goodbase_crash_issues WHERE ${where()} AND status IN('open','regressed')) open_issues,(SELECT COALESCE(SUM(occurrence_count),0)::int FROM goodbase_crash_issues WHERE ${where()}) crash_occurrences,(SELECT COUNT(*)::int FROM goodbase_performance_traces WHERE ${where()} AND occurred_at>=NOW()-INTERVAL '24 hours') traces_24h,(SELECT ROUND(AVG(duration_ms),2) FROM goodbase_performance_traces WHERE ${where()} AND occurred_at>=NOW()-INTERVAL '24 hours') average_duration_ms,(SELECT COUNT(*)::int FROM goodbase_symbol_files symbols JOIN goodbase_client_releases release ON release.id=symbols.release_id WHERE ${where("release")} AND symbols.status='ready') ready_symbol_files`,params);return response.json({success:true,metrics:result.rows[0]});}catch(error){return next(error);}});

authenticatedRouter.get("/in-app/campaigns",async(request,response,next)=>{try{const tenant=scope(request),result=await database.query(`SELECT campaign.*,COUNT(event.id) FILTER(WHERE event.event_type='impression')::int impressions,COUNT(event.id) FILTER(WHERE event.event_type='conversion')::int conversions FROM goodbase_in_app_campaigns campaign LEFT JOIN goodbase_in_app_impressions event ON event.campaign_id=campaign.id WHERE ${where("campaign")} GROUP BY campaign.id ORDER BY campaign.created_at DESC`,values(tenant));return response.json({success:true,campaigns:result.rows});}catch(error){return next(error);}});
authenticatedRouter.post("/in-app/campaigns",async(request,response,next)=>{try{const tenant=scope(request),type=clean(request.body?.messageType,20);if(!["banner","modal","image","card"].includes(type))return response.status(400).json({success:false,message:"Unsupported message type."});const result=await database.query(`INSERT INTO goodbase_in_app_campaigns(organization_id,project_id,environment_id,app_id,name,message_type,content_json,audience_rule_json,trigger_json,localization_json,deep_link,frequency_cap,quiet_hours_json,starts_at,ends_at,conversion_event,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,$17) RETURNING *`,[...values(tenant),clean(request.body?.appId,100),clean(request.body?.name,160),type,JSON.stringify(bounded(request.body?.content)),JSON.stringify(bounded(request.body?.audienceRules)),JSON.stringify(bounded(request.body?.trigger)),JSON.stringify(bounded(request.body?.localization)),clean(request.body?.deepLink,1000)||null,Number.isInteger(request.body?.frequencyCap)?request.body.frequencyCap:null,JSON.stringify(bounded(request.body?.quietHours)),request.body?.startsAt||null,request.body?.endsAt||null,clean(request.body?.conversionEvent,120)||null,request.user.id]);return response.status(201).json({success:true,campaign:result.rows[0]});}catch(error){return next(error);}});
authenticatedRouter.post("/in-app/campaigns/:id/publish",mfaRequired,async(request,response,next)=>{try{const tenant=scope(request),result=await database.query(`UPDATE goodbase_in_app_campaigns SET status=CASE WHEN starts_at>NOW() THEN 'scheduled' ELSE 'active' END,approved_by=$5,updated_at=NOW() WHERE id=$4 AND ${where()} AND status IN('draft','pending_approval','paused') RETURNING *`,[...values(tenant),request.params.id,request.user.id]);if(!result.rows[0])return response.status(409).json({success:false,message:"Campaign is not publishable."});return response.json({success:true,campaign:result.rows[0]});}catch(error){return next(error);}});

authenticatedRouter.get("/hosting/projects",async(request,response,next)=>{try{const tenant=scope(request),result=await database.query(`SELECT project.*,controller.status controller_status,controller.last_health_at FROM goodbase_hosting_projects project LEFT JOIN goodbase_controller_registrations controller ON controller.id=project.controller_id WHERE ${where("project")} ORDER BY project.created_at DESC`,values(tenant));return response.json({success:true,projects:result.rows});}catch(error){return next(error);}});
authenticatedRouter.post("/hosting/projects",mfaRequired,async(request,response,next)=>{try{const tenant=scope(request),runtime=clean(request.body?.runtimeType,20);if(!["static","spa","ssr","container"].includes(runtime))return response.status(400).json({success:false,message:"Unsupported hosting runtime."});let controller=null;if(request.body?.controllerId){const found=await database.query(`SELECT id,status,capabilities FROM goodbase_controller_registrations WHERE id=$1`,[request.body.controllerId]);controller=found.rows[0]||null;}const status=controller?.status==='ready'?'ready':'unconfigured';const result=await database.query(`INSERT INTO goodbase_hosting_projects(organization_id,project_id,environment_id,app_id,name,runtime_type,repository_url,default_branch,framework_preset,build_command,output_directory,environment_secret_refs,status,controller_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[...values(tenant),clean(request.body?.appId,100)||null,clean(request.body?.name,160),runtime,clean(request.body?.repositoryUrl,1000)||null,clean(request.body?.defaultBranch,100)||"main",clean(request.body?.frameworkPreset,100)||null,clean(request.body?.buildCommand,500)||null,clean(request.body?.outputDirectory,300)||null,Array.isArray(request.body?.environmentSecretRefs)?request.body.environmentSecretRefs.slice(0,100):[],status,controller?.id||null,request.user.id]);return response.status(201).json({success:true,project:result.rows[0],message:status==='ready'?"Hosting project is connected to a verified controller.":"Hosting project is unconfigured until a verified controller is attached."});}catch(error){return next(error);}});
authenticatedRouter.post("/hosting/projects/:id/releases",mfaRequired,async(request,response,next)=>{try{const tenant=scope(request),projectResult=await database.query(`SELECT project.*,controller.status controller_status FROM goodbase_hosting_projects project LEFT JOIN goodbase_controller_registrations controller ON controller.id=project.controller_id WHERE project.id=$4 AND ${where("project")}`,[...values(tenant),request.params.id]);const projectRow=projectResult.rows[0];if(!projectRow)return response.status(404).json({success:false,message:"Hosting project not found."});if(projectRow.controller_status!=="ready")return response.status(409).json({success:false,code:"GOODBASE_HOSTING_CONTROLLER_REQUIRED",message:"A verified ready hosting controller is required before a release can be queued."});const result=await database.query(`INSERT INTO goodbase_hosting_releases(organization_id,project_id,environment_id,hosting_project_id,commit_sha,source_ref,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[...values(tenant),projectRow.id,clean(request.body?.commitSha,64),clean(request.body?.sourceRef,1000),request.user.id]);return response.status(202).json({success:true,release:result.rows[0]});}catch(error){return next(error);}});

module.exports={publicRouter,authenticatedRouter};
