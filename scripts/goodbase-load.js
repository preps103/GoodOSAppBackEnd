#!/usr/bin/env node
"use strict";

const {performance}=require("perf_hooks");
const target=String(process.env.GOODBASE_LOAD_TARGET||"");const approved=process.env.GOODBASE_LOAD_APPROVED==="true";const production=target==="https://base.goodos.app";
if(!approved||!/^https:\/\//.test(target)||production&&process.env.GOODBASE_PRODUCTION_LOAD_APPROVED!=="true"){console.error("Load testing requires an HTTPS target and explicit approval; production requires separate approval.");process.exit(2);}
const concurrency=Math.min(Math.max(Number(process.env.GOODBASE_LOAD_CONCURRENCY)||10,1),500);const requests=Math.min(Math.max(Number(process.env.GOODBASE_LOAD_REQUESTS)||100,1),100000);const path=process.env.GOODBASE_LOAD_PATH||"/api/health/live";
async function request(){const started=performance.now();const response=await fetch(`${target}${path}`,{headers:{"User-Agent":"Goodbase-Load/1.0"}});return{status:response.status,latency:performance.now()-started};}
(async()=>{const results=[];for(let offset=0;offset<requests;offset+=concurrency)results.push(...await Promise.all(Array.from({length:Math.min(concurrency,requests-offset)},request)));const sorted=results.map(r=>r.latency).sort((a,b)=>a-b);const percentile=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];const report={target,path,requests,concurrency,success:results.filter(r=>r.status>=200&&r.status<400).length,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99)};console.log(JSON.stringify(report,null,2));if(report.success!==requests)process.exitCode=1;})().catch(error=>{console.error(error.message);process.exitCode=1;});
