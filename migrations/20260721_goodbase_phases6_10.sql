BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Phase 6: durable PostgreSQL-native queues.
CREATE TABLE IF NOT EXISTS goodbase_queues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  visibility_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (visibility_timeout_seconds BETWEEN 1 AND 86400),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  max_payload_bytes INTEGER NOT NULL DEFAULT 262144 CHECK (max_payload_bytes BETWEEN 1024 AND 10485760),
  retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds BETWEEN 3600 AND 31536000),
  dead_letter_queue_id TEXT REFERENCES goodbase_queues(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, project_id, environment_id, name)
);

CREATE TABLE IF NOT EXISTS goodbase_queue_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id TEXT NOT NULL REFERENCES goodbase_queues(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','leased','completed','archived','dead_lettered')),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_bytes INTEGER NOT NULL,
  idempotency_key TEXT,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (queue_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_goodbase_queue_claim
  ON goodbase_queue_messages(queue_id, status, available_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_goodbase_queue_leases
  ON goodbase_queue_messages(lease_expires_at) WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS goodbase_queue_events (
  id BIGSERIAL PRIMARY KEY,
  queue_id TEXT NOT NULL,
  message_id UUID,
  event_type TEXT NOT NULL,
  consumer_id TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION goodbase_queue_send(
  p_queue_id TEXT,
  p_payload JSONB,
  p_idempotency_key TEXT DEFAULT NULL,
  p_delay_seconds INTEGER DEFAULT 0,
  p_priority INTEGER DEFAULT 100
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_queue goodbase_queues%ROWTYPE; v_id UUID;
BEGIN
  SELECT * INTO v_queue FROM goodbase_queues WHERE id = p_queue_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue is not active'; END IF;
  IF octet_length(p_payload::text) > v_queue.max_payload_bytes THEN RAISE EXCEPTION 'Queue payload exceeds configured limit'; END IF;
  INSERT INTO goodbase_queue_messages (
    queue_id, organization_id, project_id, environment_id, payload_json,
    payload_bytes, idempotency_key, priority, max_attempts, available_at
  ) VALUES (
    v_queue.id, v_queue.organization_id, v_queue.project_id, v_queue.environment_id,
    p_payload, octet_length(p_payload::text), NULLIF(p_idempotency_key,''),
    LEAST(GREATEST(p_priority,0),1000), v_queue.max_attempts,
    NOW() + make_interval(secs => LEAST(GREATEST(p_delay_seconds,0),31536000))
  ) ON CONFLICT (queue_id, idempotency_key) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_id;
  INSERT INTO goodbase_queue_events(queue_id,message_id,event_type) VALUES(v_queue.id,v_id,'sent');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION goodbase_queue_receive(
  p_queue_id TEXT,
  p_consumer_id TEXT,
  p_limit INTEGER DEFAULT 1,
  p_visibility_seconds INTEGER DEFAULT NULL
) RETURNS SETOF goodbase_queue_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_visibility INTEGER;
BEGIN
  SELECT COALESCE(p_visibility_seconds, visibility_timeout_seconds) INTO v_visibility
  FROM goodbase_queues WHERE id = p_queue_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue is not active'; END IF;
  RETURN QUERY
  WITH claim AS (
    SELECT id FROM goodbase_queue_messages
    WHERE queue_id = p_queue_id
      AND available_at <= NOW()
      AND (status = 'available' OR (status = 'leased' AND lease_expires_at <= NOW()))
      AND attempts < max_attempts
    ORDER BY priority, available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit,1),100)
  )
  UPDATE goodbase_queue_messages message SET
    status='leased', lease_owner=left(p_consumer_id,200), lease_token=gen_random_uuid(),
    lease_expires_at=NOW()+make_interval(secs=>LEAST(GREATEST(v_visibility,1),86400)),
    attempts=message.attempts+1, updated_at=NOW()
  FROM claim WHERE message.id=claim.id RETURNING message.*;
END $$;

CREATE OR REPLACE FUNCTION goodbase_queue_ack(p_message_id UUID, p_lease_token UUID, p_archive BOOLEAN DEFAULT TRUE)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE goodbase_queue_messages SET
    status=CASE WHEN p_archive THEN 'archived' ELSE 'completed' END,
    completed_at=NOW(), archived_at=CASE WHEN p_archive THEN NOW() ELSE NULL END,
    lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=NOW()
  WHERE id=p_message_id AND status='leased' AND lease_token=p_lease_token;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION goodbase_queue_nack(p_message_id UUID, p_lease_token UUID, p_error TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts INTEGER; v_max INTEGER; v_dlq TEXT;
BEGIN
  SELECT message.attempts,message.max_attempts,queue.dead_letter_queue_id
  INTO v_attempts,v_max,v_dlq FROM goodbase_queue_messages message
  JOIN goodbase_queues queue ON queue.id=message.queue_id
  WHERE message.id=p_message_id AND message.status='leased' AND message.lease_token=p_lease_token FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE goodbase_queue_messages SET
    queue_id=CASE WHEN v_attempts>=v_max AND v_dlq IS NOT NULL THEN v_dlq ELSE queue_id END,
    status=CASE WHEN v_attempts>=v_max AND v_dlq IS NULL THEN 'dead_lettered' ELSE 'available' END,
    available_at=CASE WHEN v_attempts>=v_max THEN available_at ELSE NOW()+make_interval(secs=>LEAST(3600,power(2,LEAST(v_attempts,11))::int)) END,
    last_error=left(p_error,2000), lease_owner=NULL, lease_token=NULL,
    lease_expires_at=NULL, updated_at=NOW()
  WHERE id=p_message_id;
  RETURN TRUE;
END $$;

-- Phase 7: PostgreSQL-native schedule control plane.
CREATE TABLE IF NOT EXISTS goodbase_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('sql_function','http','edge_function','queue')),
  target_ref TEXT NOT NULL,
  cron_expression TEXT,
  interval_seconds INTEGER CHECK (interval_seconds BETWEEN 10 AND 31536000),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit BETWEEN 1 AND 100),
  timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (timeout_seconds BETWEEN 1 AND 3600),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  headers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name),
  CHECK ((cron_expression IS NOT NULL) <> (interval_seconds IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS goodbase_schedule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id TEXT NOT NULL REFERENCES goodbase_schedules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','timed_out','skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  response_status INTEGER,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goodbase_schedules_due ON goodbase_schedules(status,next_run_at);

-- Phase 8: backup, PITR, replica, and DR governance.
CREATE TABLE IF NOT EXISTS goodbase_backup_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  daily_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  pitr_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  wal_archive_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  offsite_required BOOLEAN NOT NULL DEFAULT TRUE,
  restore_verify_hours INTEGER NOT NULL DEFAULT 24 CHECK (restore_verify_hours BETWEEN 1 AND 720),
  rpo_minutes INTEGER NOT NULL DEFAULT 5 CHECK (rpo_minutes BETWEEN 1 AND 1440),
  rto_minutes INTEGER NOT NULL DEFAULT 60 CHECK (rto_minutes BETWEEN 1 AND 10080),
  encryption_key_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id)
);

CREATE TABLE IF NOT EXISTS goodbase_recovery_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id TEXT NOT NULL REFERENCES goodbase_backup_policies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('base_backup','wal','logical','snapshot')),
  storage_provider TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  recoverable_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_dr_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id TEXT NOT NULL REFERENCES goodbase_backup_policies(id) ON DELETE CASCADE,
  exercise_type TEXT NOT NULL CHECK (exercise_type IN ('restore_verify','pitr','replica_promotion','regional_failover')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','running','passed','failed')),
  target_recovery_point TIMESTAMPTZ,
  measured_rpo_seconds INTEGER,
  measured_rto_seconds INTEGER,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_read_replicas (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES goodbase_backup_policies(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  replay_lag_bytes BIGINT,
  replay_lag_seconds INTEGER,
  last_checked_at TIMESTAMPTZ,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 9: resumable/multipart uploads, transformations, delivery, and scanning.
CREATE TABLE IF NOT EXISTS goodbase_upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  bucket_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('tus','s3_multipart')),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','uploading','completed','aborted','expired','quarantined')),
  content_type TEXT NOT NULL,
  upload_length BIGINT NOT NULL CHECK (upload_length BETWEEN 1 AND 53687091200),
  upload_offset BIGINT NOT NULL DEFAULT 0,
  part_size_bytes INTEGER NOT NULL DEFAULT 8388608,
  checksum_sha256 TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bucket_id,object_key,id)
);

CREATE TABLE IF NOT EXISTS goodbase_upload_parts (
  session_id UUID NOT NULL REFERENCES goodbase_upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  byte_start BIGINT NOT NULL,
  byte_end BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(session_id,part_number)
);

CREATE TABLE IF NOT EXISTS goodbase_image_transforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  width INTEGER CHECK (width BETWEEN 1 AND 8192),
  height INTEGER CHECK (height BETWEEN 1 AND 8192),
  fit TEXT NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover','contain','fill','inside','outside')),
  format TEXT CHECK (format IN ('jpeg','png','webp','avif')),
  quality INTEGER CHECK (quality BETWEEN 1 AND 100),
  signed BOOLEAN NOT NULL DEFAULT TRUE,
  cache_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  result_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_storage_security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('scan_requested','scan_clean','scan_infected','quarantined','released','orphan_detected')),
  scanner TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_cdn_events (
  id BIGSERIAL PRIMARY KEY,
  bucket_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('hit','miss','purge','invalidate')),
  edge_region TEXT,
  bytes_sent BIGINT NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 10: isolated edge function runtime control plane.
CREATE TABLE IF NOT EXISTS goodbase_edge_runtimes (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL DEFAULT 'deno',
  runtime_version TEXT NOT NULL,
  region TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  max_concurrency INTEGER NOT NULL DEFAULT 32,
  last_heartbeat_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_edge_functions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  active_version INTEGER,
  timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 100 AND 300000),
  memory_mb INTEGER NOT NULL DEFAULT 128 CHECK (memory_mb BETWEEN 32 AND 2048),
  cpu_ms INTEGER NOT NULL DEFAULT 1000 CHECK (cpu_ms BETWEEN 10 AND 300000),
  concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK (concurrency_limit BETWEEN 1 AND 1000),
  request_limit_bytes INTEGER NOT NULL DEFAULT 1048576,
  response_limit_bytes INTEGER NOT NULL DEFAULT 6291456,
  network_policy TEXT NOT NULL DEFAULT 'deny' CHECK (network_policy IN ('deny','allowlist')),
  network_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  secret_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_edge_versions (
  function_id TEXT NOT NULL REFERENCES goodbase_edge_functions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  immutable BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(function_id,version),
  UNIQUE(function_id,bundle_sha256)
);

CREATE TABLE IF NOT EXISTS goodbase_edge_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id TEXT NOT NULL REFERENCES goodbase_edge_functions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  region TEXT NOT NULL,
  traffic_percent INTEGER NOT NULL CHECK (traffic_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'deploying',
  rollback_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY(function_id,version) REFERENCES goodbase_edge_versions(function_id,version)
);

CREATE TABLE IF NOT EXISTS goodbase_edge_invocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  runtime_id TEXT REFERENCES goodbase_edge_runtimes(id) ON DELETE SET NULL,
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','timed_out','rejected')),
  region TEXT,
  cold_start BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms INTEGER,
  cpu_ms INTEGER,
  peak_memory_bytes BIGINT,
  request_bytes INTEGER,
  response_bytes INTEGER,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_goodbase_edge_invocations ON goodbase_edge_invocations(function_id,started_at DESC);

-- Tenant isolation for all client-relevant Phase 6-10 control tables.
DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'goodbase_queues','goodbase_queue_messages','goodbase_schedules',
    'goodbase_backup_policies','goodbase_upload_sessions','goodbase_edge_functions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I', relation_name);
    EXECUTE format(
      'CREATE POLICY goodbase_tenant_isolation ON %I FOR ALL TO goodos_authenticated USING (organization_id=goodos_auth.organization_id() AND project_id=goodos_auth.project_id() AND environment_id=goodos_auth.environment_id()) WITH CHECK (organization_id=goodos_auth.organization_id() AND project_id=goodos_auth.project_id() AND environment_id=goodos_auth.environment_id())',
      relation_name
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
  goodbase_queues,goodbase_queue_messages,goodbase_queue_events,
  goodbase_schedules,goodbase_schedule_runs,goodbase_backup_policies,
  goodbase_recovery_points,goodbase_dr_exercises,goodbase_read_replicas,
  goodbase_upload_sessions,goodbase_upload_parts,goodbase_image_transforms,
  goodbase_storage_security_events,goodbase_cdn_events,goodbase_edge_runtimes,
  goodbase_edge_functions,goodbase_edge_versions,goodbase_edge_deployments,
  goodbase_edge_invocations
TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE
  goodbase_queue_events_id_seq,goodbase_cdn_events_id_seq
TO goodapp_backend_user;
GRANT EXECUTE ON FUNCTION goodbase_queue_send(TEXT,JSONB,TEXT,INTEGER,INTEGER) TO goodapp_backend_user;
GRANT EXECUTE ON FUNCTION goodbase_queue_receive(TEXT,TEXT,INTEGER,INTEGER) TO goodapp_backend_user;
GRANT EXECUTE ON FUNCTION goodbase_queue_ack(UUID,UUID,BOOLEAN) TO goodapp_backend_user;
GRANT EXECUTE ON FUNCTION goodbase_queue_nack(UUID,UUID,TEXT) TO goodapp_backend_user;

INSERT INTO backend_jobs (
  id,name,display_name,description,job_type,handler_key,status,priority,
  schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,
  metadata_json,organization_id,project_id,environment_id,created_by
) VALUES
  ('job_goodbase_queue_maintenance','goodbase.queues.maintain','Maintain Durable Queues',
   'Recovers expired leases, moves exhausted messages to dead-letter state, and purges expired archives.',
   'scheduled','goodbase.queues.maintain','active',5,15,120,3,'goodbase.queues.maintain',NOW(),
   '{"phase":6}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
  ('job_goodbase_schedule_dispatch','goodbase.schedules.dispatch','Dispatch Goodbase Schedules',
   'Claims and executes due tenant-scoped schedules with concurrency and duration controls.',
   'scheduled','goodbase.schedules.dispatch','active',6,15,300,3,'goodbase.schedules.dispatch',NOW(),
   '{"phase":7}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
ON CONFLICT(id) DO UPDATE SET
  handler_key=EXCLUDED.handler_key,status='active',schedule_seconds=EXCLUDED.schedule_seconds,
  timeout_seconds=EXCLUDED.timeout_seconds,max_attempts=EXCLUDED.max_attempts,
  concurrency_key=EXCLUDED.concurrency_key,metadata_json=EXCLUDED.metadata_json,updated_at=NOW();

INSERT INTO backend_job_schedules (
  id,job_id,schedule_type,interval_seconds,enabled,next_run_at,metadata_json,
  organization_id,project_id,environment_id
)
SELECT 'schedule_'||id,id,'interval',schedule_seconds,TRUE,next_run_at,metadata_json,
       organization_id,project_id,environment_id
FROM backend_jobs WHERE id IN ('job_goodbase_queue_maintenance','job_goodbase_schedule_dispatch')
ON CONFLICT(job_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,
  enabled=TRUE,next_run_at=EXCLUDED.next_run_at,metadata_json=EXCLUDED.metadata_json,updated_at=NOW();

INSERT INTO backend_data_plane_components (
  id, component, version, status, endpoint, health_status,
  configuration_json, metadata_json, created_at, updated_at
)
VALUES
 ('goodbase_phase_6_queues','durable_queues','1.0.0','active','/api/goodbase/v1/platform/queues','healthy',
  '{"engine":"postgresql_skip_locked"}'::jsonb,'{"phase":6,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_7_schedules','scheduled_jobs','1.0.0','active','/api/goodbase/v1/platform/schedules','healthy',
  '{"engine":"goodbase_scheduler"}'::jsonb,'{"phase":7,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_8_recovery','backup_pitr_dr','1.0.0','active','/api/goodbase/v1/platform/recovery','healthy',
  '{"encrypted":true,"wal":true}'::jsonb,'{"phase":8,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_9_storage','storage_delivery','1.0.0','active','/api/goodbase/v1/platform/uploads','healthy',
  '{"tus":true,"multipart":true,"transforms":true}'::jsonb,'{"phase":9,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_10_edge','isolated_edge_runtime','2.8.1','active','http://127.0.0.1:8500','provisioning',
  '{"runtime":"deno","networkDefault":"deny"}'::jsonb,'{"phase":10,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW())
ON CONFLICT(id) DO UPDATE SET
 component=EXCLUDED.component,version=EXCLUDED.version,status=EXCLUDED.status,
 endpoint=EXCLUDED.endpoint,health_status=EXCLUDED.health_status,
 configuration_json=EXCLUDED.configuration_json,
 metadata_json=backend_data_plane_components.metadata_json || EXCLUDED.metadata_json,
 updated_at=NOW();

COMMIT;
