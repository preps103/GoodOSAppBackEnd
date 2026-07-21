#!/usr/bin/env node
"use strict";

const crypto=require("crypto");
const target=String(process.env.GOODBASE_CHAOS_CONTROLLER_URL||"");const secret=String(process.env.GOODBASE_CHAOS_CONTROLLER_SECRET||"");const environment=String(process.env.GOODBASE_CHAOS_ENVIRONMENT||"");const scenario=String(process.argv[2]||"");
const allowed=new Set(["restart-postgrest","restart-graphql","restart-realtime","restart-pgbouncer","storage-delay","controller-unavailable","deployment-rollback"]);
if(environment==="production"||!target.startsWith("https://")||secret.length<32||!allowed.has(scenario)||process.env.GOODBASE_CHAOS_APPROVED!=="true"){console.error("Chaos tests require an approved non-production environment, controller, secret, and supported scenario.");process.exit(2);}
const payload=JSON.stringify({scenario,environment,idempotencyKey:crypto.randomUUID()});const timestamp=String(Date.now());const signature=crypto.createHmac("sha256",secret).update(`${timestamp}.${payload}`).digest("hex");
fetch(target,{method:"POST",headers:{"Content-Type":"application/json","X-Goodbase-Timestamp":timestamp,"X-Goodbase-Signature":`sha256=${signature}`},body:payload}).then(async response=>{const body=await response.json().catch(()=>({}));console.log(JSON.stringify({statusCode:response.status,...body},null,2));if(!response.ok||body.completed!==true)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
