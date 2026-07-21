BEGIN;

-- Phase 46: governed app distribution, tester lifecycle, downloads, feedback, and device-test evidence.
ALTER TABLE goodbase_distribution_providers DROP CONSTRAINT IF EXISTS goodbase_distribution_providers_provider_type_check;
ALTER TABLE goodbase_distribution_providers ADD CONSTRAINT goodbase_distribution_providers_provider_type_check
  CHECK(provider_type IN ('apple','google_play','browserstack','aws_device_farm','firebase_test_lab','internal_device_pool','direct','custom'));
CREATE TABLE IF NOT EXISTS goodbase_tester_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  release_id UUID NOT NULL REFERENCES goodbase_distribution_releases(id) ON DELETE CASCADE, tester_id UUID NOT NULL REFERENCES goodbase_testers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','accepted','expired','revoked','failed')),
  expires_at TIMESTAMPTZ NOT NULL, delivered_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_distribution_downloads (
  id BIGSERIAL PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  build_id UUID NOT NULL REFERENCES goodbase_distribution_builds(id) ON DELETE CASCADE, tester_id UUID REFERENCES goodbase_testers(id) ON DELETE SET NULL,
  platform TEXT NOT NULL, ip_hash TEXT, user_agent TEXT, downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_tester_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  build_id UUID NOT NULL REFERENCES goodbase_distribution_builds(id) ON DELETE CASCADE, tester_id UUID REFERENCES goodbase_testers(id) ON DELETE SET NULL,
  rating SMALLINT CHECK(rating BETWEEN 1 AND 5), message TEXT NOT NULL, attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','resolved','closed')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 47: analytics, privacy, crash symbolication, performance alerts, and warehouse export evidence.
CREATE TABLE IF NOT EXISTS goodbase_analytics_funnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, steps_json JSONB NOT NULL,
  conversion_window_seconds INTEGER NOT NULL DEFAULT 604800 CHECK(conversion_window_seconds>0), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_analytics_retention_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, entry_event TEXT NOT NULL, return_event TEXT NOT NULL,
  interval_type TEXT NOT NULL CHECK(interval_type IN ('daily','weekly','monthly')), periods INTEGER NOT NULL CHECK(periods BETWEEN 1 AND 365),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_subject_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL, request_type TEXT NOT NULL CHECK(request_type IN ('delete','export')), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb, requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS goodbase_symbolication_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  issue_id UUID NOT NULL REFERENCES goodbase_crash_issues(id) ON DELETE CASCADE, symbol_file_id UUID REFERENCES goodbase_symbol_files(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS goodbase_telemetry_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, signal_type TEXT NOT NULL CHECK(signal_type IN ('crash_rate','anr_rate','startup','screen','network','custom')),
  threshold NUMERIC(18,6) NOT NULL, comparison TEXT NOT NULL CHECK(comparison IN ('gt','gte','lt','lte')), window_minutes INTEGER NOT NULL CHECK(window_minutes BETWEEN 1 AND 10080),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), notification_targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 48: in-app messaging, personalization, suppression, conversion, and approval evidence.
CREATE TABLE IF NOT EXISTS goodbase_in_app_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, name TEXT NOT NULL, message_type TEXT NOT NULL CHECK(message_type IN ('banner','modal','image','card')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','scheduled','active','paused','completed','rejected')),
  content_json JSONB NOT NULL, audience_rule_json JSONB NOT NULL DEFAULT '{}'::jsonb, trigger_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  localization_json JSONB NOT NULL DEFAULT '{}'::jsonb, deep_link TEXT, frequency_cap INTEGER, quiet_hours_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, conversion_event TEXT, experiment_id UUID REFERENCES goodbase_experiments(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(app_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_in_app_impressions (
  id BIGSERIAL PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES goodbase_in_app_campaigns(id) ON DELETE CASCADE, subject_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('eligible','impression','click','dismiss','conversion')), occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS goodbase_in_app_suppressions (
  organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES goodbase_in_app_campaigns(id) ON DELETE CASCADE, subject_hash TEXT NOT NULL,
  reason TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(campaign_id,subject_hash)
);

-- Phase 49 is the evidence-backed Goodbase Studio served by the application; its panels read these production tables directly.

-- Phase 50: generalized application hosting with immutable releases and controlled traffic.
CREATE TABLE IF NOT EXISTS goodbase_hosting_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL, name TEXT NOT NULL, runtime_type TEXT NOT NULL CHECK(runtime_type IN ('static','spa','ssr','container')),
  repository_url TEXT, default_branch TEXT NOT NULL DEFAULT 'main', framework_preset TEXT, build_command TEXT, output_directory TEXT,
  environment_secret_refs TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'unconfigured' CHECK(status IN ('unconfigured','ready','disabled','degraded')),
  controller_id UUID REFERENCES goodbase_controller_registrations(id) ON DELETE SET NULL, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_hosting_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  hosting_project_id UUID NOT NULL REFERENCES goodbase_hosting_projects(id) ON DELETE CASCADE, commit_sha TEXT NOT NULL, source_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','building','testing','deploying','ready','failed','rolled_back','cancelled')),
  preview_url TEXT, artifact_checksum TEXT, health_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb, logs_ref TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS goodbase_hosting_traffic_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  hosting_project_id UUID NOT NULL REFERENCES goodbase_hosting_projects(id) ON DELETE CASCADE, hostname TEXT NOT NULL,
  allocations_json JSONB NOT NULL, strategy TEXT NOT NULL CHECK(strategy IN ('primary','canary','weighted','blue_green')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','failed','disabled')), verified_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_tester_invitations','goodbase_distribution_downloads','goodbase_tester_feedback','goodbase_analytics_funnels',
    'goodbase_analytics_retention_definitions','goodbase_subject_deletion_requests','goodbase_symbolication_jobs','goodbase_telemetry_alerts',
    'goodbase_in_app_campaigns','goodbase_in_app_impressions','goodbase_in_app_suppressions','goodbase_hosting_projects',
    'goodbase_hosting_releases','goodbase_hosting_traffic_splits'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true)) WITH CHECK (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true))',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON goodbase_tester_invitations,goodbase_distribution_downloads,goodbase_tester_feedback,
  goodbase_analytics_funnels,goodbase_analytics_retention_definitions,goodbase_subject_deletion_requests,goodbase_symbolication_jobs,
  goodbase_telemetry_alerts,goodbase_in_app_campaigns,goodbase_in_app_impressions,goodbase_in_app_suppressions,
  goodbase_hosting_projects,goodbase_hosting_releases,goodbase_hosting_traffic_splits TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE goodbase_distribution_downloads_id_seq,goodbase_in_app_impressions_id_seq TO goodapp_backend_user;

COMMIT;
