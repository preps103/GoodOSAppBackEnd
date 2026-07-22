"use strict";

const database = require("../src/config/database");

async function main(){
  const policies=await database.query(`SELECT * FROM goodbase_telemetry_retention_policies WHERE status='active' ORDER BY organization_id,project_id,environment_id`);
  let passed=0,blocked=0,failed=0;
  for(const policy of policies.rows){
    const client=await database.pool.connect();let runId;
    try{
      const started=await client.query(`INSERT INTO goodbase_telemetry_retention_runs(organization_id,project_id,environment_id,status,evidence_json) VALUES($1,$2,$3,'running',jsonb_build_object('policyId',$4,'startedBy','scheduled-retention')) RETURNING id`,[policy.organization_id,policy.project_id,policy.environment_id,policy.id]);runId=started.rows[0].id;
      const hold=await client.query(`SELECT id FROM backend_legal_holds WHERE organization_id=$1 AND status='active' AND scope_type='organization' LIMIT 1`,[policy.organization_id]);
      if(hold.rows[0]){await client.query(`UPDATE goodbase_telemetry_retention_runs SET status='blocked',evidence_json=evidence_json||jsonb_build_object('legalHoldId',$2),completed_at=NOW() WHERE id=$1`,[runId,hold.rows[0].id]);blocked++;continue;}
      await client.query("BEGIN");
      const args=[policy.organization_id,policy.project_id,policy.environment_id];
      const analytics=await client.query(`DELETE FROM goodbase_analytics_events event WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND received_at<NOW()-($4::text||' days')::interval AND NOT EXISTS(SELECT 1 FROM backend_legal_holds hold WHERE hold.organization_id=event.organization_id AND hold.status='active' AND hold.scope_type='user' AND hold.scope_id=event.user_id::text)`,[...args,policy.analytics_days]);
      const sessions=await client.query(`DELETE FROM goodbase_analytics_sessions session WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND started_at<NOW()-($4::text||' days')::interval AND NOT EXISTS(SELECT 1 FROM backend_legal_holds hold WHERE hold.organization_id=session.organization_id AND hold.status='active' AND hold.scope_type='user' AND hold.scope_id=session.user_id::text)`,[...args,policy.session_days]);
      const crashes=await client.query(`DELETE FROM goodbase_crash_occurrences occurrence USING goodbase_crash_issues issue WHERE issue.id=occurrence.issue_id AND issue.organization_id=$1 AND issue.project_id=$2 AND issue.environment_id=$3 AND occurrence.received_at<NOW()-($4::text||' days')::interval AND NOT EXISTS(SELECT 1 FROM backend_legal_holds hold WHERE hold.organization_id=issue.organization_id AND hold.status='active' AND hold.scope_type='user' AND hold.scope_id=occurrence.user_id::text)`,[...args,policy.crash_days]);
      const traces=await client.query(`DELETE FROM goodbase_performance_traces trace WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND received_at<NOW()-($4::text||' days')::interval AND NOT EXISTS(SELECT 1 FROM backend_legal_holds hold WHERE hold.organization_id=trace.organization_id AND hold.status='active' AND hold.scope_type='user' AND hold.scope_id=trace.user_id::text)`,[...args,policy.trace_days]);
      await client.query(`DELETE FROM goodbase_crash_issues issue WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND NOT EXISTS(SELECT 1 FROM goodbase_crash_occurrences occurrence WHERE occurrence.issue_id=issue.id)`,args);
      const sizes=await client.query(`SELECT jsonb_object_agg(name,bytes) sizes FROM (VALUES ('analytics',pg_total_relation_size('goodbase_analytics_events')),('sessions',pg_total_relation_size('goodbase_analytics_sessions')),('crashes',pg_total_relation_size('goodbase_crash_occurrences')),('browser',pg_total_relation_size('goodbase_performance_traces'))) size(name,bytes)`);
      const counts={analytics:analytics.rowCount,sessions:sessions.rowCount,crashes:crashes.rowCount,browser:traces.rowCount};
      await client.query(`UPDATE goodbase_telemetry_retention_runs SET status='passed',deleted_counts_json=$2::jsonb,storage_usage_json=$3::jsonb,evidence_json=evidence_json||jsonb_build_object('immutableSecurityDays',$4,'storageLimitBytes',$5),completed_at=NOW() WHERE id=$1`,[runId,JSON.stringify(counts),JSON.stringify(sizes.rows[0]?.sizes||{}),policy.immutable_security_days,policy.storage_limit_bytes]);
      await client.query("COMMIT");passed++;
    }catch(error){try{await client.query("ROLLBACK");if(runId)await client.query(`UPDATE goodbase_telemetry_retention_runs SET status='failed',evidence_json=evidence_json||jsonb_build_object('errorCode',$2),completed_at=NOW() WHERE id=$1`,[runId,String(error.code||"RETENTION_FAILED").slice(0,100)]);}catch{}failed++;console.error(`Retention failed for ${policy.organization_id}: ${error.code||error.message}`);}finally{client.release();}
  }
  console.log(JSON.stringify({policies:policies.rowCount,passed,blocked,failed}));if(failed)process.exitCode=1;
}

main().finally(()=>database.close?.()).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
