#!/usr/bin/env node
"use strict";

const fs=require("fs");const path=require("path");
const database=require("../src/config/database");const {preserveEvidence,validCommit}=require("./lib/goodbase-evidence");
const root=path.resolve(__dirname,"..");
const findings=[];
function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(["node_modules",".git"].includes(entry.name))continue;const full=path.join(directory,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|cjs|json|yml|yaml|sql)$/.test(entry.name))scan(full);}}
function scan(file){const source=fs.readFileSync(file,"utf8");const relative=path.relative(root,file);const rules=[
  [/(?:password|token|secret|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/gi,"possible-hardcoded-secret"],
  [/child_process\.(?:exec|execSync)\s*\(/g,"shell-command-execution"],
  [/\bBYPASSRLS\b/gi,"bypassrls-reference"],
  [/rejectUnauthorized\s*:\s*false/g,"tls-verification-disabled"]
];for(const [pattern,rule] of rules){for(const match of source.matchAll(pattern)){const line=source.slice(0,match.index).split("\n").length;if(rule==="bypassrls-reference"&&(relative.startsWith("migrations/")||relative==="scripts/goodbase-security-gate.js"))continue;findings.push({rule,file:relative,line});}}}
walk(path.join(root,"src"));walk(path.join(root,"scripts"));
const route=fs.readFileSync(path.join(root,"src/routes/goodbase-growth.routes.js"),"utf8");if(!/authenticatedRouter\.use\(authRequired,tenantContext\)/.test(route))findings.push({rule:"missing-auth-boundary",file:"src/routes/goodbase-growth.routes.js"});if(!/dataPlaneAdminRequired/.test(route))findings.push({rule:"missing-admin-boundary",file:"src/routes/goodbase-growth.routes.js"});
const report={status:findings.length?"failed":"passed",releaseCommit:process.env.GOODBASE_RELEASE_COMMIT||"unknown",findings};
(async()=>{if(validCommit(report.releaseCommit))report.evidence=await preserveEvidence({type:"security",commit:report.releaseCommit,status:report.status,report,database:process.env.DATABASE_URL?database:null});process.stdout.write(`${JSON.stringify(report,null,2)}\n`);if(findings.length)process.exitCode=1;})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>database.pool.end().catch(()=>null));
