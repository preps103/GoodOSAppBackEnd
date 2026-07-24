BEGIN;

-- Phase 26: repeatable reliability, security, capacity, and incident evidence.
CREATE TABLE IF NOT EXISTS goodbase_assurance_suites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  suite_type TEXT NOT NULL CHECK (suite_type IN ('smoke','load','chaos','security','recovery','release')),
  schedule_seconds INTEGER,
  blocking BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_assurance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  suite_id TEXT NOT NULL REFERENCES goodbase_assurance_suites(id) ON DELETE RESTRICT,
  git_commit TEXT NOT NULL CHECK (git_commit ~ '^[0-9a-f]{7,64}$'),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('queued','running','passed','failed','blocked','cancelled')),
  target TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms BIGINT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_assurance_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES goodbase_assurance_runs(id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed','blocked','skipped')),
  critical BOOLEAN NOT NULL DEFAULT TRUE,
  latency_ms NUMERIC(14,3),
  observed_value NUMERIC,
  threshold_value NUMERIC,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id,check_key)
);

CREATE TABLE IF NOT EXISTS goodbase_capacity_baselines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  component TEXT NOT NULL,
  metric TEXT NOT NULL,
  safe_limit NUMERIC NOT NULL,
  rollback_threshold NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  measured_at TIMESTAMPTZ,
  evidence_run_id UUID REFERENCES goodbase_assurance_runs(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,component,metric)
);

CREATE TABLE IF NOT EXISTS goodbase_incident_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('SEV0','SEV1','SEV2','SEV3','SEV4')),
  scenario TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','passed','failed','cancelled')),
  commander_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  runbook_ref TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 27: versioned documentation, starters, and migration/import evidence.
CREATE TABLE IF NOT EXISTS goodbase_developer_assets (
  id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('guide','reference','starter','migration_tool','sample','runbook')),
  slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','deprecated')),
  supported_platforms TEXT[] NOT NULL DEFAULT '{}',
  checksum_sha256 TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('supabase','firebase_auth','firestore','firebase_storage','postgresql','environment')),
  status TEXT NOT NULL DEFAULT 'analyzing' CHECK (status IN ('analyzing','validated','ready','importing','completed','failed','rolled_back')),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  source_fingerprint TEXT NOT NULL,
  compatibility_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollback_ref TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_import_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES goodbase_import_runs(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','blocking')),
  category TEXT NOT NULL,
  source_ref TEXT,
  message TEXT NOT NULL,
  remediation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 28: consumer authentication provider and account lifecycle completion.
CREATE TABLE IF NOT EXISTS goodbase_consumer_auth_providers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('password','magic_link','email_otp','phone_otp','anonymous','google','apple','microsoft','github','facebook','oauth','oidc','saml','passkey','sms_mfa')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled','disabled','misconfigured')),
  issuer_url TEXT,
  client_id TEXT,
  secret_ref TEXT,
  controller_url TEXT,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,provider_type,id)
);

CREATE TABLE IF NOT EXISTS goodbase_sms_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  destination_hash TEXT NOT NULL,
  encrypted_payload TEXT,
  provider_id TEXT REFERENCES goodbase_consumer_auth_providers(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('phone_otp','sms_mfa','phone_change')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','delivered','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_message_id TEXT,
  error_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_account_link_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES goodbase_consumer_auth_providers(id) ON DELETE RESTRICT,
  provider_subject_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','linked','rejected','expired')),
  challenge_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 29: short-lived app/device attestation and enforcement evidence.
CREATE TABLE IF NOT EXISTS goodbase_attestation_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android','web','flutter','custom')),
  provider TEXT NOT NULL CHECK (provider IN ('apple_app_attest','apple_devicecheck','play_integrity','recaptcha_enterprise','debug','custom')),
  mode TEXT NOT NULL DEFAULT 'audit' CHECK (mode IN ('disabled','audit','enforce')),
  token_ttl_seconds INTEGER NOT NULL DEFAULT 300 CHECK (token_ttl_seconds BETWEEN 60 AND 3600),
  provider_url TEXT,
  secret_ref TEXT,
  allowed_endpoints TEXT[] NOT NULL DEFAULT '{}',
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,app_id,platform)
);

CREATE TABLE IF NOT EXISTS goodbase_attestation_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES goodbase_attestation_policies(id) ON DELETE CASCADE,
  nonce_hash TEXT NOT NULL UNIQUE,
  device_key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','rejected')),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_attestation_tokens (
  jti TEXT PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES goodbase_attestation_policies(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES goodbase_attestation_challenges(id) ON DELETE CASCADE,
  device_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired','compromised')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_attestation_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT,
  policy_id UUID REFERENCES goodbase_attestation_policies(id) ON DELETE SET NULL,
  jti TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected','audit','replay','compromised')),
  reason_code TEXT,
  endpoint TEXT,
  latency_ms NUMERIC(12,3),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 30: provider-backed, queued cross-platform messaging.
CREATE TABLE IF NOT EXISTS goodbase_messaging_providers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('apns','fcm','web_push','custom')),
  status TEXT NOT NULL DEFAULT 'misconfigured' CHECK (status IN ('ready','misconfigured','disabled','degraded')),
  endpoint_url TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_health_at TIMESTAMPTZ,
  last_health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,provider_type)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES goodbase_messaging_providers(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android','web','flutter')),
  token_hash TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  locale TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','revoked','suppressed')),
  attestation_jti TEXT REFERENCES goodbase_attestation_tokens(jti) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,token_hash)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_topic_members (
  topic_id UUID NOT NULL REFERENCES goodbase_messaging_topics(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES goodbase_messaging_devices(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(topic_id,device_id)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rule_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  default_locale TEXT NOT NULL DEFAULT 'en',
  content_json JSONB NOT NULL,
  localization_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,template_key)
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  template_id UUID REFERENCES goodbase_messaging_templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN ('device','user','topic','segment','all')),
  audience_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ,
  timezone_mode TEXT NOT NULL DEFAULT 'utc' CHECK (timezone_mode IN ('utc','device_local')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','dispatching','completed','cancelled','failed')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_messaging_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES goodbase_messaging_campaigns(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES goodbase_messaging_devices(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','delivered','failed','suppressed','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS goodbase_messaging_delivery_queue_idx ON goodbase_messaging_deliveries(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS goodbase_messaging_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID REFERENCES goodbase_messaging_devices(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR device_id IS NOT NULL)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_assurance_suites','goodbase_assurance_runs','goodbase_capacity_baselines','goodbase_incident_exercises',
    'goodbase_import_runs','goodbase_consumer_auth_providers','goodbase_sms_deliveries',
    'goodbase_attestation_policies','goodbase_attestation_events','goodbase_messaging_providers',
    'goodbase_messaging_devices','goodbase_messaging_topics','goodbase_messaging_segments','goodbase_messaging_templates','goodbase_messaging_campaigns'
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
  goodbase_assurance_suites,goodbase_assurance_runs,goodbase_assurance_checks,goodbase_capacity_baselines,goodbase_incident_exercises,
  goodbase_developer_assets,goodbase_import_runs,goodbase_import_findings,
  goodbase_consumer_auth_providers,goodbase_sms_deliveries,goodbase_account_link_requests,
  goodbase_attestation_policies,goodbase_attestation_challenges,goodbase_attestation_tokens,goodbase_attestation_events,
  goodbase_messaging_providers,goodbase_messaging_devices,goodbase_messaging_topics,goodbase_messaging_topic_members,goodbase_messaging_segments,
  goodbase_messaging_templates,goodbase_messaging_campaigns,goodbase_messaging_deliveries,goodbase_messaging_suppressions
TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE goodbase_attestation_events_id_seq TO goodapp_backend_user;

INSERT INTO goodbase_assurance_suites(id,organization_id,project_id,environment_id,name,suite_type,schedule_seconds,blocking,configuration_json)
VALUES
 ('assurance_daily_security','org_goodos','proj_goodos_platform','env_goodos_production','Daily Security Boundary','security',86400,TRUE,'{"safe":true,"destructive":false}'::jsonb),
 ('assurance_release_gate','org_goodos','proj_goodos_platform','env_goodos_production','Release Reliability Gate','release',NULL,TRUE,'{"requiresSmoke":true,"requiresSecurity":true}'::jsonb),
 ('assurance_monthly_capacity','org_goodos','proj_goodos_platform','env_goodos_production','Monthly Capacity Baseline','load',2592000,FALSE,'{"productionLoadDisabled":true}'::jsonb)
ON CONFLICT(id) DO UPDATE SET enabled=TRUE,blocking=EXCLUDED.blocking,configuration_json=EXCLUDED.configuration_json,updated_at=NOW();

INSERT INTO goodbase_developer_assets(id,asset_type,slug,version,source_ref,status,supported_platforms,published_at)
VALUES
 ('asset_goodbase_handbook','guide','handbook','1.0.0','docs/goodbase/README.md','published',ARRAY['web','node','flutter','ios','android','python'],NOW()),
 ('asset_goodbase_migrate','migration_tool','migration-cli','1.0.0','scripts/goodbase-import.js','published',ARRAY['supabase','firebase','postgresql'],NOW()),
 ('asset_goodbase_starters','starter','starter-apps','1.0.0','starters/README.md','published',ARRAY['react','nextjs','flutter','swift','kotlin'],NOW())
ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,source_ref=EXCLUDED.source_ref,status='published',published_at=NOW();

INSERT INTO goodbase_consumer_auth_providers(id,organization_id,project_id,environment_id,provider_type,display_name,status,configuration_json)
VALUES
 ('auth_consumer_google','org_goodos','proj_goodos_platform','env_goodos_production','google','Google','misconfigured','{"pkce":true}'::jsonb),
 ('auth_consumer_apple','org_goodos','proj_goodos_platform','env_goodos_production','apple','Apple','misconfigured','{"pkce":true}'::jsonb),
 ('auth_consumer_microsoft','org_goodos','proj_goodos_platform','env_goodos_production','microsoft','Microsoft','misconfigured','{"pkce":true}'::jsonb),
 ('auth_consumer_github','org_goodos','proj_goodos_platform','env_goodos_production','github','GitHub','misconfigured','{"pkce":true}'::jsonb),
 ('auth_consumer_facebook','org_goodos','proj_goodos_platform','env_goodos_production','facebook','Facebook','misconfigured','{"pkce":true}'::jsonb),
 ('auth_consumer_phone','org_goodos','proj_goodos_platform','env_goodos_production','phone_otp','Phone OTP','misconfigured','{"digits":6,"ttlSeconds":600}'::jsonb),
 ('auth_consumer_passkey','org_goodos','proj_goodos_platform','env_goodos_production','passkey','Passkeys','misconfigured','{"userVerification":"required"}'::jsonb),
 ('auth_consumer_anonymous','org_goodos','proj_goodos_platform','env_goodos_production','anonymous','Anonymous accounts','disabled','{"upgradeRequired":true}'::jsonb)
ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,configuration_json=EXCLUDED.configuration_json,updated_at=NOW();

INSERT INTO backend_jobs(id,name,display_name,description,job_type,handler_key,status,priority,schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by)
VALUES
 ('job_goodbase_assurance_daily','goodbase.assurance.daily','Run Goodbase Assurance','Runs non-destructive production security and reliability gates.','scheduled','goodbase.assurance.daily','active',3,86400,600,2,'goodbase.assurance.daily',NOW(),'{"phase":26}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_sms_dispatch','goodbase.auth.sms.dispatch','Dispatch Authentication SMS','Dispatches encrypted OTP payloads through the configured SMS provider.','scheduled','goodbase.auth.sms.dispatch','active',5,10,120,5,'goodbase.auth.sms.dispatch',NOW(),'{"phase":28}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_messaging_dispatch','goodbase.messaging.dispatch','Dispatch Push Messaging','Dispatches queued APNs, FCM and Web Push messages.','scheduled','goodbase.messaging.dispatch','active',5,5,180,5,'goodbase.messaging.dispatch',NOW(),'{"phase":30}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,display_name=EXCLUDED.display_name,description=EXCLUDED.description,status='active',schedule_seconds=EXCLUDED.schedule_seconds;

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,timezone,enabled,next_run_at,organization_id,project_id,environment_id)
VALUES
 ('schedule_goodbase_assurance_daily','job_goodbase_assurance_daily','interval',86400,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_sms_dispatch','job_goodbase_sms_dispatch','interval',10,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_messaging_dispatch','job_goodbase_messaging_dispatch','interval',5,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production')
ON CONFLICT(id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,enabled=TRUE,organization_id=EXCLUDED.organization_id,project_id=EXCLUDED.project_id,environment_id=EXCLUDED.environment_id;

COMMIT;
