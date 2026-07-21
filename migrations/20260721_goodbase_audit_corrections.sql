BEGIN;

ALTER TABLE goodbase_sdk_releases ADD COLUMN IF NOT EXISTS signature_ref TEXT;
ALTER TABLE goodbase_sdk_releases ADD COLUMN IF NOT EXISTS sbom_ref TEXT;
ALTER TABLE goodbase_sdk_releases ADD COLUMN IF NOT EXISTS changelog_ref TEXT;
ALTER TABLE goodbase_sdk_releases ADD COLUMN IF NOT EXISTS compatibility_matrix_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS client_platform TEXT;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS artifact_ref TEXT;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS device_model TEXT;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS os_version TEXT;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS encrypted_cache_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE goodbase_sdk_compatibility_runs ADD COLUMN IF NOT EXISTS scenario_report_json JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Governed infrastructure-as-code state, locking, drift, import, export, and execution evidence.
CREATE TABLE IF NOT EXISTS goodbase_iac_stacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('terraform','pulumi')), source_repository TEXT, source_path TEXT,
  state_backend_ref TEXT NOT NULL, desired_state_json JSONB NOT NULL DEFAULT '{}'::jsonb, observed_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_applied_commit TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','planning','applying','drifted','failed','disabled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_iac_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  stack_id UUID NOT NULL REFERENCES goodbase_iac_stacks(id) ON DELETE CASCADE, lock_token_hash TEXT NOT NULL, holder TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS goodbase_iac_active_lock_idx ON goodbase_iac_locks(stack_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS goodbase_iac_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  stack_id UUID NOT NULL REFERENCES goodbase_iac_stacks(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK(run_type IN ('validate','plan','apply','drift','export','import','destroy')),
  source_commit TEXT NOT NULL CHECK(source_commit ~ '^[0-9a-f]{7,64}$'), idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled')),
  plan_checksum_sha256 TEXT, artifact_ref TEXT, rollback_ref TEXT, input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb, drift_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  controller_operation_id UUID REFERENCES goodbase_controller_operations(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
  UNIQUE(stack_id,idempotency_key)
);

-- Signed, reviewed, permission-bounded extension marketplace.
CREATE TABLE IF NOT EXISTS goodbase_extension_publishers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, signing_identity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','suspended','revoked')),
  verification_json JSONB NOT NULL DEFAULT '{}'::jsonb, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_extension_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  publisher_id UUID NOT NULL REFERENCES goodbase_extension_publishers(id) ON DELETE RESTRICT, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewing','published','suspended','retired')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,slug)
);
CREATE TABLE IF NOT EXISTS goodbase_extension_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  package_id UUID NOT NULL REFERENCES goodbase_extension_packages(id) ON DELETE CASCADE, version TEXT NOT NULL,
  artifact_ref TEXT NOT NULL, checksum_sha256 TEXT NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'), signature TEXT NOT NULL,
  sbom_ref TEXT NOT NULL, permission_manifest_json JSONB NOT NULL, secret_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  migration_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb, rollback_manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  security_review_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','reviewing','approved','published','rejected','revoked')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ,
  UNIQUE(package_id,version)
);
CREATE TABLE IF NOT EXISTS goodbase_extension_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  package_id UUID NOT NULL REFERENCES goodbase_extension_packages(id) ON DELETE RESTRICT,
  version_id UUID NOT NULL REFERENCES goodbase_extension_versions(id) ON DELETE RESTRICT,
  previous_version_id UUID REFERENCES goodbase_extension_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','installing','active','failed','rolling_back','disabled')),
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb, secret_refs TEXT[] NOT NULL DEFAULT '{}', metering_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  controller_operation_id UUID REFERENCES goodbase_controller_operations(id) ON DELETE SET NULL,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL, installed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,package_id)
);

-- Provider-neutral, attested, quota-bounded AI application layer.
CREATE TABLE IF NOT EXISTS goodbase_ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, provider_type TEXT NOT NULL CHECK(provider_type IN ('openai_compatible','anthropic_compatible','vertex_compatible','bedrock_compatible','custom')),
  base_url TEXT NOT NULL, secret_ref TEXT NOT NULL, capabilities TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','ready','degraded','disabled')),
  last_health_at TIMESTAMPTZ, health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_ai_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES goodbase_ai_providers(id) ON DELETE CASCADE, alias TEXT NOT NULL, provider_model TEXT NOT NULL,
  modality TEXT[] NOT NULL DEFAULT ARRAY['text'], context_window INTEGER, input_cost_per_million NUMERIC(18,6), output_cost_per_million NUMERIC(18,6),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','deprecated')), routing_weight INTEGER NOT NULL DEFAULT 100 CHECK(routing_weight BETWEEN 0 AND 10000),
  UNIQUE(organization_id,project_id,environment_id,alias,provider_id)
);
CREATE TABLE IF NOT EXISTS goodbase_ai_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, app_id TEXT REFERENCES apps(id) ON DELETE CASCADE, require_attestation BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_model_aliases TEXT[] NOT NULL DEFAULT '{}', allowed_tools TEXT[] NOT NULL DEFAULT '{}', max_input_tokens INTEGER NOT NULL DEFAULT 8192,
  max_output_tokens INTEGER NOT NULL DEFAULT 2048, requests_per_minute INTEGER NOT NULL DEFAULT 60, tokens_per_day BIGINT NOT NULL DEFAULT 1000000,
  safety_json JSONB NOT NULL DEFAULT '{}'::jsonb, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);
CREATE TABLE IF NOT EXISTS goodbase_ai_prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, system_template TEXT, user_template TEXT NOT NULL,
  input_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb, output_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id,name,version)
);
CREATE TABLE IF NOT EXISTS goodbase_ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE SET NULL, subject_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','deleted')), metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS goodbase_ai_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES goodbase_ai_conversations(id) ON DELETE SET NULL, policy_id UUID REFERENCES goodbase_ai_policies(id) ON DELETE SET NULL,
  model_id UUID REFERENCES goodbase_ai_models(id) ON DELETE SET NULL, prompt_template_id UUID REFERENCES goodbase_ai_prompt_templates(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','blocked','cancelled')),
  input_hash TEXT NOT NULL, request_json JSONB NOT NULL DEFAULT '{}'::jsonb, response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, cost_microunits BIGINT NOT NULL DEFAULT 0,
  safety_json JSONB NOT NULL DEFAULT '{}'::jsonb, error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
  UNIQUE(organization_id,project_id,environment_id,user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS goodbase_ai_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  name TEXT NOT NULL, model_alias TEXT NOT NULL, dataset_ref TEXT NOT NULL, source_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','passed','failed','cancelled')),
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb, artifact_ref TEXT, requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);

DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_iac_stacks','goodbase_iac_locks','goodbase_iac_runs','goodbase_extension_publishers','goodbase_extension_packages',
    'goodbase_extension_versions','goodbase_extension_installations','goodbase_ai_providers','goodbase_ai_models','goodbase_ai_policies',
    'goodbase_ai_prompt_templates','goodbase_ai_conversations','goodbase_ai_runs','goodbase_ai_evaluation_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true)) WITH CHECK (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true))',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO goodapp_backend_user',table_name);
  END LOOP;
END $$;

COMMIT;
