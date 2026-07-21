#!/usr/bin/env node
"use strict";

const database=require("../src/config/database");
const {runAssuranceSuite}=require("../src/services/goodbase-growth.service");

async function main(){
  const suiteId=process.argv[2]||"assurance_daily_security";
  const result=await runAssuranceSuite({suiteId});
  process.stdout.write(`${JSON.stringify({runId:result.run.id,status:result.run.status,commit:result.run.git_commit,checks:result.checks.map(item=>({key:item.key,status:item.status,latencyMs:Number(item.latencyMs.toFixed(3))}))},null,2)}\n`);
  if(result.run.status!=="passed")process.exitCode=1;
}

main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>database.pool.end());
