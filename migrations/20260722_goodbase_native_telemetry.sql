BEGIN;

-- Native crash artifacts, real client sessions, issue intelligence, and privacy evidence.
ALTER TABLE goodbase_symbol_files
  DROP CONSTRAINT IF EXISTS goodbase_symbol_files_symbol_type_check;
ALTER TABLE goodbase_symbol_files
  ADD CONSTRAINT goodbase_symbol_files_symbol_type_check
  CHECK (symbol_type IN ('sourcemap','dsym','proguard','ndk','flutter','unity'));
ALTER TABLE goodbase_symbol_files
  ADD COLUMN IF NOT EXISTS original_filename TEXT,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS processing_tool TEXT,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

ALTER TABLE goodbase_analytics_sessions
  ADD COLUMN IF NOT EXISTS release_id UUID REFERENCES goodbase_client_releases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS build_number TEXT,
  ADD COLUMN IF NOT EXISTS distribution_track TEXT,
  ADD COLUMN IF NOT EXISTS installation_hash TEXT,
  ADD COLUMN IF NOT EXISTS subject_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS crash_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crashed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;
CREATE INDEX IF NOT EXISTS goodbase_analytics_sessions_stability_idx
  ON goodbase_analytics_sessions(organization_id,project_id,environment_id,app_id,started_at DESC,release_id,crashed);

ALTER TABLE goodbase_crash_occurrences
  ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES goodbase_analytics_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS release_version TEXT,
  ADD COLUMN IF NOT EXISTS build_number TEXT,
  ADD COLUMN IF NOT EXISTS variant_key TEXT,
  ADD COLUMN IF NOT EXISTS subject_hash TEXT,
  ADD COLUMN IF NOT EXISTS symbolicated BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS goodbase_crash_occurrences_session_idx
  ON goodbase_crash_occurrences(session_id,occurred_at DESC);

ALTER TABLE goodbase_performance_traces
  ADD COLUMN IF NOT EXISTS subject_hash TEXT;

ALTER TABLE goodbase_crash_issues
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS previous_window_occurrences BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS growth_percent NUMERIC(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impacted_sessions BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impact_score NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_classified_at TIMESTAMPTZ;
ALTER TABLE goodbase_crash_issues
  DROP CONSTRAINT IF EXISTS goodbase_crash_issues_classification_check;
ALTER TABLE goodbase_crash_issues
  ADD CONSTRAINT goodbase_crash_issues_classification_check
  CHECK (classification IN ('new','stable','growing','regressed'));

CREATE TABLE IF NOT EXISTS goodbase_crash_issue_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  issue_id UUID NOT NULL REFERENCES goodbase_crash_issues(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  normalized_stack_hash TEXT NOT NULL,
  representative_stack TEXT,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  impacted_users BIGINT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(issue_id,variant_key)
);

CREATE TABLE IF NOT EXISTS goodbase_telemetry_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  plan_key TEXT NOT NULL DEFAULT 'enterprise',
  analytics_days INTEGER NOT NULL DEFAULT 365 CHECK(analytics_days BETWEEN 1 AND 3650),
  session_days INTEGER NOT NULL DEFAULT 365 CHECK(session_days BETWEEN 1 AND 3650),
  crash_days INTEGER NOT NULL DEFAULT 730 CHECK(crash_days BETWEEN 1 AND 3650),
  trace_days INTEGER NOT NULL DEFAULT 90 CHECK(trace_days BETWEEN 1 AND 3650),
  immutable_security_days INTEGER NOT NULL DEFAULT 2555 CHECK(immutable_security_days BETWEEN 365 AND 3650),
  storage_limit_bytes BIGINT NOT NULL DEFAULT 10737418240 CHECK(storage_limit_bytes>0),
  consent_required BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id)
);

CREATE TABLE IF NOT EXISTS goodbase_telemetry_privacy_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('export','delete')),
  subject_hash TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','blocked','completed','failed')),
  legal_hold_id TEXT REFERENCES backend_legal_holds(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  target_stores TEXT[] NOT NULL DEFAULT ARRAY['analytics','sessions','crashes','browser','prometheus','loki','tempo'],
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_ref TEXT,
  checksum_sha256 TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK(subject_hash IS NOT NULL OR user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS goodbase_telemetry_retention_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','passed','failed','blocked')),
  deleted_counts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_telemetry_alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  alert_id UUID NOT NULL REFERENCES goodbase_telemetry_alerts(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  measured_value NUMERIC(18,6) NOT NULL,
  client_volume BIGINT NOT NULL,
  threshold NUMERIC(18,6) NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'firing' CHECK(status IN ('firing','resolved')),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(alert_id,window_started_at)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_crash_issue_variants','goodbase_telemetry_retention_policies',
    'goodbase_telemetry_privacy_requests','goodbase_telemetry_retention_runs',
    'goodbase_telemetry_alert_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true)) WITH CHECK (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true))',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON
  goodbase_crash_issue_variants,goodbase_telemetry_retention_policies,
  goodbase_telemetry_privacy_requests,goodbase_telemetry_retention_runs,
  goodbase_telemetry_alert_events
TO goodapp_backend_user;

INSERT INTO goodbase_telemetry_retention_policies(organization_id,project_id,environment_id)
VALUES('org_goodos','proj_goodos_platform','env_goodos_production')
ON CONFLICT(organization_id,project_id,environment_id) DO NOTHING;

COMMIT;
