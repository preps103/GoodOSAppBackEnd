BEGIN;

-- Phase 31: privacy-aware product analytics.
CREATE TABLE IF NOT EXISTS goodbase_analytics_events (
  id BIGSERIAL PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE SET NULL, subject_hash TEXT NOT NULL,
  anonymous_id TEXT, session_id TEXT, event_name TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT 'custom',
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), consent_state TEXT NOT NULL,
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb, user_properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_json JSONB NOT NULL DEFAULT '{}'::jsonb, revenue_amount NUMERIC(18,4), currency TEXT,
  source TEXT NOT NULL DEFAULT 'client', request_id TEXT, CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL),
  CHECK (consent_state IN ('granted','essential','denied')), CHECK (event_type IN ('custom','session','screen','conversion','revenue','campaign','exposure','server'))
);
CREATE INDEX IF NOT EXISTS goodbase_analytics_events_lookup_idx ON goodbase_analytics_events(app_id,event_name,occurred_at DESC);
CREATE TABLE IF NOT EXISTS goodbase_analytics_sessions (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT, platform TEXT, country_code TEXT, language TEXT, app_version TEXT,
  started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, event_count INTEGER NOT NULL DEFAULT 0,
  consent_state TEXT NOT NULL CHECK (consent_state IN ('granted','essential','denied')), properties_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS goodbase_analytics_audiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, rule_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','disabled')), estimated_size BIGINT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_analytics_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK(destination_type IN ('s3','bigquery','snowflake','postgresql','https')),
  destination_ref TEXT NOT NULL, secret_ref TEXT, status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled','failing')),
  cursor_received_at TIMESTAMPTZ, last_export_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_analytics_daily_metrics (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL, event_name TEXT NOT NULL, event_count BIGINT NOT NULL, unique_users BIGINT NOT NULL,
  revenue_amount NUMERIC(18,4) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(organization_id,project_id,environment_id,app_id,metric_date,event_name)
);

-- Phase 32: crash reporting and client performance.
CREATE TABLE IF NOT EXISTS goodbase_client_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, platform TEXT NOT NULL, version TEXT NOT NULL, build_number TEXT NOT NULL,
  commit_sha TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','retired')),
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,platform,version,build_number)
);
CREATE TABLE IF NOT EXISTS goodbase_crash_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, platform TEXT NOT NULL,
  exception_type TEXT, title TEXT NOT NULL, first_release TEXT, last_release TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored','regressed')),
  occurrence_count BIGINT NOT NULL DEFAULT 0, impacted_users BIGINT NOT NULL DEFAULT 0, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, UNIQUE(app_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS goodbase_crash_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), issue_id UUID NOT NULL REFERENCES goodbase_crash_issues(id) ON DELETE CASCADE,
  release_id UUID REFERENCES goodbase_client_releases(id) ON DELETE SET NULL, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id TEXT, fatal BOOLEAN NOT NULL DEFAULT TRUE, error_message TEXT, stack_trace TEXT, breadcrumbs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_keys_json JSONB NOT NULL DEFAULT '{}'::jsonb, device_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_performance_traces (
  id BIGSERIAL PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, release_id UUID REFERENCES goodbase_client_releases(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL, trace_type TEXT NOT NULL CHECK(trace_type IN ('startup','screen','network','custom','anr')),
  name TEXT NOT NULL, duration_ms NUMERIC(14,3) NOT NULL, success BOOLEAN NOT NULL DEFAULT TRUE,
  platform TEXT, device_class TEXT, os_version TEXT, network_type TEXT, attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_symbol_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), release_id UUID NOT NULL REFERENCES goodbase_client_releases(id) ON DELETE CASCADE,
  symbol_type TEXT NOT NULL CHECK(symbol_type IN ('dsym','proguard','sourcemap','flutter')), checksum_sha256 TEXT NOT NULL,
  storage_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(release_id,symbol_type,checksum_sha256)
);

-- Phase 33: typed, versioned Remote Config.
CREATE TABLE IF NOT EXISTS goodbase_config_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  published_version INTEGER, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), template_id UUID NOT NULL REFERENCES goodbase_config_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','published','superseded','rolled_back','rejected')),
  parameters_json JSONB NOT NULL, conditions_json JSONB NOT NULL DEFAULT '[]'::jsonb, checksum_sha256 TEXT NOT NULL,
  change_summary TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ, UNIQUE(template_id,version_number)
);
CREATE TABLE IF NOT EXISTS goodbase_config_audit (
  id BIGSERIAL PRIMARY KEY, template_id UUID NOT NULL REFERENCES goodbase_config_templates(id) ON DELETE CASCADE,
  version_id UUID REFERENCES goodbase_config_versions(id) ON DELETE SET NULL, action TEXT NOT NULL, actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 34: sticky experiments and controlled rollouts.
CREATE TABLE IF NOT EXISTS goodbase_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, hypothesis TEXT,
  experiment_type TEXT NOT NULL CHECK(experiment_type IN ('feature_flag','remote_config','messaging')),
  audience_rule_json JSONB NOT NULL DEFAULT '{}'::jsonb, allocation_percent NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK(allocation_percent BETWEEN 0 AND 100),
  primary_metric TEXT NOT NULL, guardrail_metrics TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','completed','rolled_back','cancelled')),
  winning_variant_id UUID, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_experiment_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES goodbase_experiments(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, is_baseline BOOLEAN NOT NULL DEFAULT FALSE, weight NUMERIC(7,4) NOT NULL CHECK(weight>0), payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(experiment_id,key)
);
ALTER TABLE goodbase_experiments DROP CONSTRAINT IF EXISTS goodbase_experiments_winning_variant_id_fkey;
ALTER TABLE goodbase_experiments ADD CONSTRAINT goodbase_experiments_winning_variant_id_fkey FOREIGN KEY(winning_variant_id) REFERENCES goodbase_experiment_variants(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS goodbase_experiment_assignments (
  experiment_id UUID NOT NULL REFERENCES goodbase_experiments(id) ON DELETE CASCADE, subject_hash TEXT NOT NULL,
  variant_id UUID NOT NULL REFERENCES goodbase_experiment_variants(id) ON DELETE CASCADE, assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(experiment_id,subject_hash)
);
CREATE TABLE IF NOT EXISTS goodbase_experiment_exposures (
  id BIGSERIAL PRIMARY KEY, experiment_id UUID NOT NULL REFERENCES goodbase_experiments(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES goodbase_experiment_variants(id) ON DELETE CASCADE, subject_hash TEXT NOT NULL,
  session_id TEXT, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(experiment_id,subject_hash,session_id)
);
CREATE TABLE IF NOT EXISTS goodbase_experiment_results (
  experiment_id UUID NOT NULL REFERENCES goodbase_experiments(id) ON DELETE CASCADE, variant_id UUID NOT NULL REFERENCES goodbase_experiment_variants(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL, sample_size BIGINT NOT NULL DEFAULT 0, conversion_rate NUMERIC(12,8), lift_percent NUMERIC(12,6),
  confidence_low NUMERIC(12,8), confidence_high NUMERIC(12,8), significance NUMERIC(12,8), calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(experiment_id,variant_id,metric_key)
);

-- Phase 35: governed app distribution and external device-lab orchestration.
CREATE TABLE IF NOT EXISTS goodbase_distribution_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('apple','google_play','browserstack','aws_device_farm','custom')),
  endpoint_url TEXT NOT NULL, secret_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'misconfigured' CHECK(status IN ('ready','misconfigured','disabled','degraded')),
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb, last_health_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,provider_type)
);
CREATE TABLE IF NOT EXISTS goodbase_distribution_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('apk','aab','ipa')), version TEXT NOT NULL, build_number TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL, storage_ref TEXT NOT NULL, release_notes TEXT, expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','expired','revoked','failed')),
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,platform,version,build_number)
);
CREATE TABLE IF NOT EXISTS goodbase_tester_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_testers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES goodbase_tester_groups(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL, encrypted_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','removed')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ, UNIQUE(group_id,email_hash)
);
CREATE TABLE IF NOT EXISTS goodbase_distribution_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), build_id UUID NOT NULL REFERENCES goodbase_distribution_builds(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES goodbase_tester_groups(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','distributing','available','failed','expired','revoked')),
  provider_id UUID REFERENCES goodbase_distribution_providers(id) ON DELETE SET NULL, idempotency_key TEXT NOT NULL UNIQUE,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS goodbase_device_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  build_id UUID NOT NULL REFERENCES goodbase_distribution_builds(id) ON DELETE CASCADE, provider_id UUID NOT NULL REFERENCES goodbase_distribution_providers(id) ON DELETE RESTRICT,
  test_type TEXT NOT NULL CHECK(test_type IN ('instrumentation','robo','crawler','ui','performance')),
  matrix_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','passed','failed','flaky','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, result_json JSONB NOT NULL DEFAULT '{}'::jsonb, artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);

-- Phase 36: verified CDN, replication, transformations, scanning and moderation.
CREATE TABLE IF NOT EXISTS goodbase_cdn_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('cloudflare','fastly','cloudfront','bunny','custom')),
  endpoint_url TEXT NOT NULL, secret_ref TEXT NOT NULL, signing_secret_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'misconfigured' CHECK(status IN ('ready','misconfigured','disabled','degraded')),
  regions TEXT[] NOT NULL DEFAULT '{}', last_health_at TIMESTAMPTZ, configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id,provider_type)
);
CREATE TABLE IF NOT EXISTS goodbase_storage_replications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  bucket_id TEXT NOT NULL, source_region TEXT NOT NULL, target_region TEXT NOT NULL, provider_id UUID NOT NULL REFERENCES goodbase_cdn_providers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','replicating','ready','lagging','failed','disabled')),
  lag_seconds INTEGER, last_verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(bucket_id,target_region)
);
CREATE TABLE IF NOT EXISTS goodbase_media_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
  operations_json JSONB NOT NULL, allowed_formats TEXT[] NOT NULL DEFAULT '{}', max_output_bytes BIGINT, quota_per_day BIGINT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_cdn_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES goodbase_cdn_providers(id) ON DELETE RESTRICT,
  operation_type TEXT NOT NULL CHECK(operation_type IN ('purge_url','purge_tag','transform','replicate','scan','moderate','video_thumbnail')),
  idempotency_key TEXT NOT NULL UNIQUE, request_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb, error_message TEXT, requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);

-- Phase 37: regional deployments, global traffic and capacity evidence.
CREATE TABLE IF NOT EXISTS goodbase_regional_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES goodbase_regions(id) ON DELETE RESTRICT, service_type TEXT NOT NULL,
  desired_instances INTEGER NOT NULL CHECK(desired_instances BETWEEN 0 AND 10000), ready_instances INTEGER NOT NULL DEFAULT 0,
  min_instances INTEGER NOT NULL DEFAULT 1, max_instances INTEGER NOT NULL DEFAULT 10, maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  release_commit TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','provisioning','ready','degraded','failed','draining','maintenance')),
  last_health_at TIMESTAMPTZ, configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,region_id,service_type)
);
CREATE TABLE IF NOT EXISTS goodbase_global_traffic_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  hostname TEXT NOT NULL, routing_mode TEXT NOT NULL CHECK(routing_mode IN ('latency','weighted','geo','failover')),
  health_check_path TEXT NOT NULL, drain_seconds INTEGER NOT NULL DEFAULT 30, routes_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','degraded','disabled')),
  last_verified_at TIMESTAMPTZ, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(hostname)
);
CREATE TABLE IF NOT EXISTS goodbase_regional_exercises (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  exercise_type TEXT NOT NULL CHECK(exercise_type IN ('traffic_shift','region_loss','replica_promotion','queue_failover','storage_failover')),
  primary_region_id TEXT NOT NULL REFERENCES goodbase_regions(id), secondary_region_id TEXT NOT NULL REFERENCES goodbase_regions(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','running','passed','failed','cancelled')),
  rto_seconds INTEGER, rpo_seconds INTEGER, evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 38: immutable metering, entitlements, spend controls, support and public status.
CREATE TABLE IF NOT EXISTS goodbase_meter_catalog (
  metric_key TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, aggregation TEXT NOT NULL CHECK(aggregation IN ('sum','max','unique','duration')),
  billable BOOLEAN NOT NULL DEFAULT TRUE, source TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_meter_ledger (
  id BIGSERIAL PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  metric_key TEXT NOT NULL REFERENCES goodbase_meter_catalog(metric_key), quantity NUMERIC(22,6) NOT NULL CHECK(quantity>=0),
  idempotency_key TEXT NOT NULL UNIQUE, source_ref TEXT, dimensions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_plan_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), plan_id TEXT NOT NULL REFERENCES backend_billing_plans(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL, value_json JSONB NOT NULL, enforcement_mode TEXT NOT NULL CHECK(enforcement_mode IN ('informational','soft','hard')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(plan_id,entitlement_key)
);
CREATE TABLE IF NOT EXISTS goodbase_spend_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  monthly_limit NUMERIC(18,2) NOT NULL CHECK(monthly_limit>=0), warning_percent INTEGER NOT NULL DEFAULT 80 CHECK(warning_percent BETWEEN 1 AND 100),
  hard_stop BOOLEAN NOT NULL DEFAULT FALSE, current_spend NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','warning','exceeded','suspended','disabled')),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id)
);
CREATE TABLE IF NOT EXISTS goodbase_billing_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), customer_id TEXT NOT NULL REFERENCES backend_billing_customers(id) ON DELETE CASCADE,
  amount NUMERIC(18,2) NOT NULL CHECK(amount>0), currency TEXT NOT NULL, remaining_amount NUMERIC(18,2) NOT NULL CHECK(remaining_amount>=0),
  reason TEXT NOT NULL, expires_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_support_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  requester_id UUID REFERENCES users(id) ON DELETE SET NULL, severity TEXT NOT NULL CHECK(severity IN ('low','normal','high','urgent')),
  subject TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','waiting_customer','resolved','closed')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, sla_due_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_status_components (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'operational' CHECK(status IN ('operational','degraded','partial_outage','major_outage','maintenance')),
  region_id TEXT REFERENCES goodbase_regions(id) ON DELETE SET NULL, description TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_public_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL, impact TEXT NOT NULL CHECK(impact IN ('none','minor','major','critical')),
  status TEXT NOT NULL CHECK(status IN ('investigating','identified','monitoring','resolved')), message TEXT NOT NULL,
  component_ids TEXT[] NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_analytics_events','goodbase_analytics_sessions','goodbase_analytics_audiences','goodbase_analytics_exports','goodbase_analytics_daily_metrics',
    'goodbase_client_releases','goodbase_crash_issues','goodbase_performance_traces','goodbase_config_templates','goodbase_experiments',
    'goodbase_distribution_providers','goodbase_distribution_builds','goodbase_tester_groups','goodbase_device_test_runs',
    'goodbase_cdn_providers','goodbase_storage_replications','goodbase_media_presets','goodbase_cdn_operations',
    'goodbase_regional_deployments','goodbase_global_traffic_policies','goodbase_regional_exercises',
    'goodbase_meter_ledger','goodbase_spend_limits','goodbase_support_cases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true)) WITH CHECK (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true))',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
  END LOOP;
END $$;

DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('goodbase_crash_occurrences','EXISTS(SELECT 1 FROM goodbase_crash_issues parent WHERE parent.id=issue_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_symbol_files','EXISTS(SELECT 1 FROM goodbase_client_releases parent WHERE parent.id=release_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_config_versions','EXISTS(SELECT 1 FROM goodbase_config_templates parent WHERE parent.id=template_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_config_audit','EXISTS(SELECT 1 FROM goodbase_config_templates parent WHERE parent.id=template_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_experiment_variants','EXISTS(SELECT 1 FROM goodbase_experiments parent WHERE parent.id=experiment_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_experiment_assignments','EXISTS(SELECT 1 FROM goodbase_experiments parent WHERE parent.id=experiment_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_experiment_exposures','EXISTS(SELECT 1 FROM goodbase_experiments parent WHERE parent.id=experiment_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_experiment_results','EXISTS(SELECT 1 FROM goodbase_experiments parent WHERE parent.id=experiment_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_testers','EXISTS(SELECT 1 FROM goodbase_tester_groups parent WHERE parent.id=group_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_distribution_releases','EXISTS(SELECT 1 FROM goodbase_distribution_builds parent WHERE parent.id=build_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))'),
    ('goodbase_billing_credits','EXISTS(SELECT 1 FROM backend_billing_customers parent WHERE parent.id=customer_id AND parent.organization_id=current_setting(''app.organization_id'',true) AND parent.project_id=current_setting(''app.project_id'',true) AND parent.environment_id=current_setting(''app.environment_id'',true))')
  ) AS policies(table_name,predicate)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_parent_tenant_isolation ON %I',item.table_name);
    EXECUTE format('CREATE POLICY goodbase_parent_tenant_isolation ON %I USING (%s) WITH CHECK (%s)',item.table_name,item.predicate,item.predicate);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',item.table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',item.table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON
  goodbase_analytics_events,goodbase_analytics_sessions,goodbase_analytics_audiences,goodbase_analytics_exports,goodbase_analytics_daily_metrics,
  goodbase_client_releases,goodbase_crash_issues,goodbase_crash_occurrences,goodbase_performance_traces,goodbase_symbol_files,
  goodbase_config_templates,goodbase_config_versions,goodbase_config_audit,goodbase_experiments,goodbase_experiment_variants,
  goodbase_experiment_assignments,goodbase_experiment_exposures,goodbase_experiment_results,goodbase_distribution_providers,
  goodbase_distribution_builds,goodbase_tester_groups,goodbase_testers,goodbase_distribution_releases,goodbase_device_test_runs,
  goodbase_cdn_providers,goodbase_storage_replications,goodbase_media_presets,goodbase_cdn_operations,goodbase_regional_deployments,
  goodbase_global_traffic_policies,goodbase_regional_exercises,goodbase_meter_catalog,goodbase_meter_ledger,goodbase_plan_entitlements,
  goodbase_spend_limits,goodbase_billing_credits,goodbase_support_cases,goodbase_status_components,goodbase_public_incidents
TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE goodbase_analytics_events_id_seq,goodbase_config_audit_id_seq,goodbase_experiment_exposures_id_seq,
  goodbase_meter_ledger_id_seq,goodbase_performance_traces_id_seq TO goodapp_backend_user;

INSERT INTO goodbase_meter_catalog(metric_key,name,unit,aggregation,source) VALUES
 ('api.requests','API Requests','requests','sum','api_gateway'),('database.bytes','Database Storage','bytes','max','postgresql'),
 ('storage.bytes','Object Storage','bytes','max','storage'),('egress.bytes','Network Egress','bytes','sum','gateway'),
 ('functions.compute_ms','Function Compute','milliseconds','sum','edge_functions'),('realtime.connection_seconds','Realtime Connections','seconds','sum','realtime'),
 ('queues.operations','Queue Operations','operations','sum','queues'),('logs.bytes','Log Ingestion','bytes','sum','observability')
ON CONFLICT(metric_key) DO UPDATE SET active=TRUE,name=EXCLUDED.name;

INSERT INTO goodbase_status_components(id,name,public_name,status,description) VALUES
 ('status_goodbase_api','Goodbase API','API','operational','Automatic REST, GraphQL and management APIs.'),
 ('status_goodbase_auth','Goodbase Auth','Authentication','operational','Authentication and session services.'),
 ('status_goodbase_storage','Goodbase Storage','Storage and CDN','operational','Object storage and delivery.'),
 ('status_goodbase_realtime','Goodbase Realtime','Realtime','operational','Realtime changes, presence and broadcast.'),
 ('status_goodbase_functions','Goodbase Functions','Functions','operational','Edge Functions runtime.')
ON CONFLICT(id) DO NOTHING;

INSERT INTO backend_jobs(id,name,display_name,description,job_type,handler_key,status,priority,schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by) VALUES
 ('job_goodbase_analytics_rollup','goodbase.analytics.rollup','Roll Up Product Analytics','Builds daily privacy-safe analytics aggregates.','scheduled','goodbase.analytics.rollup','active',20,300,180,3,'goodbase.analytics.rollup',NOW(),' {"phase":31}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_telemetry_regressions','goodbase.telemetry.regressions','Detect Client Regressions','Updates crash and performance release regressions.','scheduled','goodbase.telemetry.regressions','active',20,300,180,3,'goodbase.telemetry.regressions',NOW(),' {"phase":32}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_experiments_evaluate','goodbase.experiments.evaluate','Evaluate Experiments','Calculates experiment conversion and guardrail results.','scheduled','goodbase.experiments.evaluate','active',20,300,180,3,'goodbase.experiments.evaluate',NOW(),' {"phase":34}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_distribution_dispatch','goodbase.distribution.dispatch','Dispatch Distribution Work','Dispatches distribution and device-lab work to verified providers.','scheduled','goodbase.distribution.dispatch','active',20,15,300,5,'goodbase.distribution.dispatch',NOW(),' {"phase":35}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_cdn_dispatch','goodbase.cdn.dispatch','Dispatch CDN Work','Dispatches CDN, replication, transformation and scanning work.','scheduled','goodbase.cdn.dispatch','active',20,10,300,5,'goodbase.cdn.dispatch',NOW(),' {"phase":36}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_commercial_reconcile','goodbase.commercial.reconcile','Reconcile Commercial Controls','Reconciles immutable meters, quotas, spend and service status.','scheduled','goodbase.commercial.reconcile','active',20,300,300,3,'goodbase.commercial.reconcile',NOW(),' {"phase":38}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,status='active',schedule_seconds=EXCLUDED.schedule_seconds,description=EXCLUDED.description;

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,timezone,enabled,next_run_at,organization_id,project_id,environment_id) VALUES
 ('schedule_goodbase_analytics_rollup','job_goodbase_analytics_rollup','interval',300,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_telemetry_regressions','job_goodbase_telemetry_regressions','interval',300,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_experiments_evaluate','job_goodbase_experiments_evaluate','interval',300,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_distribution_dispatch','job_goodbase_distribution_dispatch','interval',15,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_cdn_dispatch','job_goodbase_cdn_dispatch','interval',10,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production'),
 ('schedule_goodbase_commercial_reconcile','job_goodbase_commercial_reconcile','interval',300,'UTC',TRUE,NOW(),'org_goodos','proj_goodos_platform','env_goodos_production')
ON CONFLICT(id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,enabled=TRUE,organization_id=EXCLUDED.organization_id,project_id=EXCLUDED.project_id,environment_id=EXCLUDED.environment_id;

COMMIT;
