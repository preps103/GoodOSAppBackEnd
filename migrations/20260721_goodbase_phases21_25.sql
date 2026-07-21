BEGIN;

-- Phase 21: immutable production verification evidence tied to a release commit.
CREATE TABLE IF NOT EXISTS goodbase_verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  git_commit TEXT NOT NULL CHECK (git_commit ~ '^[0-9a-f]{7,64}$'),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('deployment','daily','manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','blocked')),
  critical_failures INTEGER NOT NULL DEFAULT 0 CHECK (critical_failures >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_verification_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES goodbase_verification_runs(id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  category TEXT NOT NULL,
  target TEXT NOT NULL,
  critical BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN ('passed','failed','blocked','skipped')),
  status_code INTEGER,
  latency_ms NUMERIC(12,3),
  version TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, check_key)
);
CREATE INDEX IF NOT EXISTS goodbase_verification_runs_scope_idx ON goodbase_verification_runs(organization_id,project_id,environment_id,created_at DESC);

-- Phase 22: executable backup, restore, replica, PITR, and DR evidence.
CREATE TABLE IF NOT EXISTS goodbase_recovery_policies_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  full_backup_cron TEXT NOT NULL DEFAULT '0 2 * * *',
  wal_archive_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  offsite_provider TEXT NOT NULL,
  secondary_provider TEXT,
  encryption_key_ref TEXT NOT NULL,
  rpo_minutes INTEGER NOT NULL DEFAULT 15 CHECK (rpo_minutes BETWEEN 0 AND 10080),
  rto_minutes INTEGER NOT NULL DEFAULT 60 CHECK (rto_minutes BETWEEN 1 AND 10080),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','misconfigured')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id)
);

CREATE TABLE IF NOT EXISTS goodbase_backup_artifacts_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  backup_type TEXT NOT NULL CHECK (backup_type IN ('full','incremental','wal','storage','configuration')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','verified','failed','expired')),
  object_ref TEXT,
  secondary_object_ref TEXT,
  checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_restore_exercises_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  backup_id UUID REFERENCES goodbase_backup_artifacts_v2(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('isolated_verification','current_project','new_project','point_in_time','dr_server')),
  target_ref TEXT,
  requested_point_in_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','provisioning','restoring','verifying','passed','failed','destroyed')),
  integrity_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  smoke_report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms BIGINT,
  error_message TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_replication_targets_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  endpoint_ref TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'streaming' CHECK (mode IN ('streaming','logical','archive_restore')),
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','streaming','lagging','failed','promoted','paused')),
  replay_lsn TEXT,
  lag_bytes BIGINT,
  lag_seconds NUMERIC(12,3),
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,region_id)
);

-- Phase 23: official SDK release and compatibility governance.
CREATE TABLE IF NOT EXISTS goodbase_sdk_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sdk TEXT NOT NULL CHECK (sdk IN ('javascript','node','react','nextjs','dart','swift','kotlin','python','csharp')),
  version TEXT NOT NULL,
  package_ref TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','published','deprecated','revoked')),
  minimum_platform_version TEXT,
  capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  signed BOOLEAN NOT NULL DEFAULT FALSE,
  test_report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sdk,version)
);

CREATE TABLE IF NOT EXISTS goodbase_sdk_compatibility_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id UUID NOT NULL REFERENCES goodbase_sdk_releases(id) ON DELETE CASCADE,
  platform_version TEXT NOT NULL,
  local_stack_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed')),
  results_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 24: durable, versioned offline records and mutation/conflict history.
CREATE TABLE IF NOT EXISTS goodbase_sync_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  conflict_policy TEXT NOT NULL DEFAULT 'reject' CHECK (conflict_policy IN ('reject','last_write_wins','merge')),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_sync_records (
  collection_id UUID NOT NULL REFERENCES goodbase_sync_collections(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id,record_key)
);

CREATE TABLE IF NOT EXISTS goodbase_sync_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES goodbase_sync_collections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  expected_version BIGINT,
  base_value_json JSONB,
  value_json JSONB,
  result_version BIGINT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','conflict','rejected')),
  conflict_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  UNIQUE(user_id,device_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS goodbase_sync_events (
  sequence_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES goodbase_sync_collections(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  version BIGINT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  value_json JSONB,
  mutation_id UUID REFERENCES goodbase_sync_mutations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection_id,record_key,version)
);
CREATE INDEX IF NOT EXISTS goodbase_sync_events_cursor_idx ON goodbase_sync_events(collection_id,sequence_id);

CREATE TABLE IF NOT EXISTS goodbase_sync_cursors (
  collection_id UUID NOT NULL REFERENCES goodbase_sync_collections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_sequence_id BIGINT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(collection_id,user_id,device_id)
);

-- Phase 25: active, health-checked external controller registry and operations.
CREATE TABLE IF NOT EXISTS goodbase_controller_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  controller_type TEXT NOT NULL CHECK (controller_type IN ('infrastructure','domain','preview','embedding','recovery')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  mtls_secret_ref TEXT,
  capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','ready','degraded','offline','disabled')),
  last_health_at TIMESTAMPTZ,
  last_health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(controller_type,name)
);

CREATE TABLE IF NOT EXISTS goodbase_controller_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  controller_id UUID NOT NULL REFERENCES goodbase_controller_registrations(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  controller_request_id TEXT,
  error_message TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(controller_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS goodbase_controller_operations_queue_idx ON goodbase_controller_operations(status,next_attempt_at);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_verification_runs','goodbase_recovery_policies_v2','goodbase_backup_artifacts_v2',
    'goodbase_restore_exercises_v2','goodbase_replication_targets_v2','goodbase_sync_collections',
    'goodbase_controller_operations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id = current_setting(''app.organization_id'', true) AND project_id = current_setting(''app.project_id'', true) AND environment_id = current_setting(''app.environment_id'', true)) WITH CHECK (organization_id = current_setting(''app.organization_id'', true) AND project_id = current_setting(''app.project_id'', true) AND environment_id = current_setting(''app.environment_id'', true))',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I', table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodbase_backend_service USING (TRUE) WITH CHECK (TRUE)', table_name);
  END LOOP;
END $$;

INSERT INTO backend_jobs(id,handler_key,name,description,job_type,handler,status,priority,max_concurrency,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by)
SELECT 'job_goodbase_production_verify','goodbase.production.verify','Verify Goodbase Production','Runs daily endpoint, authorization, controller, and recovery readiness checks.','scheduled','goodbase.production.verify','active',5,1,300,3,'goodbase.production.verify',NOW(),'{"phase":21}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)
WHERE EXISTS(SELECT 1 FROM users)
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,name=EXCLUDED.name,description=EXCLUDED.description,status='active';

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,timezone,enabled,next_run_at)
VALUES('schedule_goodbase_production_verify','job_goodbase_production_verify','interval',86400,'UTC',TRUE,NOW())
ON CONFLICT(id) DO UPDATE SET interval_seconds=86400,enabled=TRUE;

INSERT INTO backend_jobs(id,handler_key,name,description,job_type,handler,status,priority,max_concurrency,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by)
SELECT 'job_goodbase_controllers_dispatch','goodbase.controllers.dispatch','Dispatch Goodbase Controllers','Dispatches signed idempotent operations to verified external controllers.','scheduled','goodbase.controllers.dispatch','active',5,4,300,5,'goodbase.controllers.dispatch',NOW(),'{"phase":25}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)
WHERE EXISTS(SELECT 1 FROM users)
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,name=EXCLUDED.name,description=EXCLUDED.description,status='active';

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,timezone,enabled,next_run_at)
VALUES('schedule_goodbase_controllers_dispatch','job_goodbase_controllers_dispatch','interval',30,'UTC',TRUE,NOW())
ON CONFLICT(id) DO UPDATE SET interval_seconds=30,enabled=TRUE;

COMMIT;
