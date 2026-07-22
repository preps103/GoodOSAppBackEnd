"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { dataPlaneAdminRequired } = require("./data-plane.routes");
const alertService = require("../services/goodbase-alert-delivery.service");
const { logAudit } = require("../services/audit.service");

const receiverRouter = express.Router();
const adminRouter = express.Router();

receiverRouter.use(rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false}));
receiverRouter.post("/alerts", async (request,response,next) => {
  try {
    const body=JSON.stringify(request.body||{});
    const verification=alertService.verifySignature({
      timestamp:request.get("X-Goodbase-Timestamp"),nonce:request.get("X-Goodbase-Nonce"),signature:request.get("X-Goodbase-Signature"),body
    });
    if(!verification.ok)return response.status(verification.status).json({success:false,code:verification.code,message:"Alert delivery signature could not be verified."});
    const result=await alertService.receiveAlertmanagerPayload({payload:request.body,body,timestamp:request.get("X-Goodbase-Timestamp"),nonce:request.get("X-Goodbase-Nonce")});
    return response.status(result.duplicate?200:202).json({success:true,...result});
  } catch(error) {
    if(error.code==="23505"&&String(error.constraint||"").includes("signature_nonce"))return response.status(409).json({success:false,code:"GOODBASE_ALERT_REPLAY_DETECTED",message:"This signed alert nonce has already been used."});
    if(error.code==="23505")return response.status(200).json({success:true,duplicate:true,accepted:0});
    return next(error);
  }
});

function mfaRequired(request,response,next){
  if(!request.auth?.mfaVerified)return response.status(428).json({success:false,code:"GOODBASE_PRIVILEGED_MFA_REQUIRED",message:"Verify MFA before changing on-call delivery configuration."});
  return next();
}
function clean(value,max=500){return String(value??"").trim().replace(/[\u0000-\u001f\u007f]/g," ").slice(0,max);}

adminRouter.use(authRequired,tenantContext,dataPlaneAdminRequired);
adminRouter.get("/alerts",async(request,response,next)=>{try{return response.json({success:true,...await alertService.snapshot(Math.min(Math.max(Number(request.query.limit)||100,1),300))});}catch(error){return next(error);}});
adminRouter.put("/alerts/policies/:id",mfaRequired,async(request,response,next)=>{try{
  const timezone=clean(request.body?.timezone,100);try{new Intl.DateTimeFormat("en",{timeZone:timezone}).format();}catch{return response.status(400).json({success:false,message:"A valid IANA timezone is required."});}
  const quiet=request.body?.quietHours&&typeof request.body.quietHours==="object"?request.body.quietHours:{};
  const escalation=Array.isArray(request.body?.escalation)?request.body.escalation.slice(0,10):[];
  if(escalation.some(step=>!["email","in_app"].includes(step?.channel)||Number(step?.delayMinutes)<0||Number(step?.delayMinutes)>1440))return response.status(400).json({success:false,message:"Escalation steps require email or in_app and a delay from 0 to 1440 minutes."});
  const result=await database.query(`UPDATE goodbase_on_call_policies SET name=$2,status=$3,timezone=$4,quiet_hours_json=$5::jsonb,escalation_json=$6::jsonb,recipient_email=$7,updated_at=NOW() WHERE id=$1 RETURNING id,name,status,timezone,quiet_hours_json,routes_json,escalation_json,recipient_email,updated_at`,[request.params.id,clean(request.body?.name,120),request.body?.status==="paused"?"paused":"active",timezone,JSON.stringify(quiet),JSON.stringify(escalation),clean(request.body?.recipientEmail,320)||null]);
  if(!result.rows[0])return response.status(404).json({success:false,message:"On-call policy not found."});
  await logAudit({userId:request.user.id,appId:"goodbase",action:"goodbase.observability.on_call.update",entityType:"on_call_policy",entityId:request.params.id,ipAddress:request.ip,metadata:{organizationId:request.tenantContext.organizationId}});
  return response.json({success:true,policy:result.rows[0]});
}catch(error){return next(error);}});

adminRouter.post("/alerts/test",mfaRequired,async(request,response,next)=>{try{
  const now=Date.now(),nonce=crypto.randomUUID(),payload={version:"4",groupKey:`test:${now}`,status:"firing",receiver:"goodbase-alert-receiver",commonLabels:{alertname:"GoodbaseTestAlert",severity:request.body?.severity==="critical"?"critical":"warning"},alerts:[{status:"firing",labels:{alertname:"GoodbaseTestAlert",severity:request.body?.severity==="critical"?"critical":"warning",test:"true"},annotations:{summary:"Goodbase outbound alert test",description:"This is an operator-requested end-to-end test of signed alert delivery."},startsAt:new Date(now).toISOString(),endsAt:"0001-01-01T00:00:00Z",fingerprint:crypto.createHash("sha256").update(`test:${now}`).digest("hex")} ]};
  const body=JSON.stringify(payload);const key=process.env.GOODBASE_ALERT_WEBHOOK_SECRET||require("fs").readFileSync(process.env.GOODBASE_ALERT_WEBHOOK_SECRET_FILE||"/etc/goodbase/alert-webhook.secret","utf8").trim();
  const signature=crypto.createHmac("sha256",key).update(`${now}.${nonce}.${body}`).digest("hex");
  const result=await alertService.receiveAlertmanagerPayload({payload,body,timestamp:String(now),nonce});
  await logAudit({userId:request.user.id,appId:"goodbase",action:"goodbase.observability.alert.test",entityType:"alert_receipt",entityId:String(result.receiptId||"duplicate"),ipAddress:request.ip,metadata:{accepted:result.accepted}});
  return response.status(202).json({success:true,...result,message:"Test alert accepted; delivery is being tracked by the Goodbase worker."});
}catch(error){return next(error);}});

module.exports={receiverRouter,adminRouter};
