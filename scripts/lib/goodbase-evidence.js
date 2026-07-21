"use strict";
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const scope=Object.freeze({organizationId:"org_goodos",projectId:"proj_goodos_platform",environmentId:"env_goodos_production"});
function validCommit(value){return /^[0-9a-f]{7,64}$/.test(String(value||"").toLowerCase());}
function checksum(value){return crypto.createHash("sha256").update(value).digest("hex");}
function safeType(value){return String(value||"evidence").replace(/[^a-z0-9_-]/gi,"-").toLowerCase();}
async function preserveEvidence({type,commit,status,report,database=null}){
  if(!validCommit(commit))throw new Error("Evidence requires an exact Git commit.");
  const body=JSON.stringify(report,null,2)+"\n",digest=checksum(body),directory=process.env.GOODBASE_EVIDENCE_DIR||"";let artifactRef=`sha256:${digest}`;
  if(directory){fs.mkdirSync(directory,{recursive:true,mode:0o750});const filename=`${safeType(type)}-${String(commit).toLowerCase()}-${digest.slice(0,16)}.json`,destination=path.join(directory,filename),temporary=`${destination}.${process.pid}.tmp`;fs.writeFileSync(temporary,body,{encoding:"utf8",mode:0o640});fs.renameSync(temporary,destination);artifactRef=destination;}
  if(database)await database.query(`INSERT INTO goodbase_release_evidence(organization_id,project_id,environment_id,evidence_type,release_commit,status,artifact_ref,checksum_sha256,report_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(evidence_type,release_commit,checksum_sha256) DO UPDATE SET artifact_ref=EXCLUDED.artifact_ref,status=EXCLUDED.status,report_json=EXCLUDED.report_json,verified_at=NOW()`,[scope.organizationId,scope.projectId,scope.environmentId,type,String(commit).toLowerCase(),status,artifactRef,digest,JSON.stringify(report)]);
  return{artifactRef,checksumSha256:digest};
}
module.exports={preserveEvidence,validCommit};
