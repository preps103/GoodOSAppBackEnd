BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE apps
SET name='Goodbase',
    domain='base.goodos.app',
    description='Goodbase enterprise backend, authentication, data, storage, realtime, and developer platform.',
    updated_at=NOW()
WHERE id='goodbackend';

-- Phase 11: complete authentication product control plane and passwordless runtime.
CREATE TABLE IF NOT EXISTS goodbase_auth_channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('password','magic_link','email_otp','phone_otp','oauth','oidc','saml','passkey','anonymous')),
  provider TEXT NOT NULL DEFAULT 'native',
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled','disabled','misconfigured')),
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, project_id, environment_id, channel_type, provider)
);

CREATE TABLE IF NOT EXISTS goodbase_auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL CHECK (challenge_type IN ('magic_link','email_otp','phone_otp','passkey_registration','passkey_authentication','account_upgrade')),
  destination_hash TEXT,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','revoked','locked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  ip_hash TEXT,
  user_agent_hash TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goodbase_auth_challenge_lookup
  ON goodbase_auth_challenges(secret_hash, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_goodbase_auth_challenge_user
  ON goodbase_auth_challenges(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodbase_auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email_normalized TEXT,
  phone_e164 TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unlinked_at TIMESTAMPTZ,
  UNIQUE(provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS goodbase_passkey_credentials (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key_cose BYTEA NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  aaguid TEXT,
  nickname TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_auth_hooks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('pre_signup','password_validate','custom_claims','post_login','token_issued','user_deleted')),
  target_type TEXT NOT NULL CHECK (target_type IN ('https','edge_function','sql_function')),
  target_ref TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 3000 CHECK (timeout_ms BETWEEN 100 AND 10000),
  fail_mode TEXT NOT NULL DEFAULT 'closed' CHECK (fail_mode IN ('closed','open')),
  signing_secret_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, project_id, environment_id, event_type, target_ref)
);

CREATE TABLE IF NOT EXISTS goodbase_auth_security_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  captcha_provider TEXT,
  captcha_secret_ref TEXT,
  leaked_password_detection BOOLEAN NOT NULL DEFAULT TRUE,
  refresh_token_rotation BOOLEAN NOT NULL DEFAULT TRUE,
  refresh_token_reuse_detection BOOLEAN NOT NULL DEFAULT TRUE,
  max_login_attempts INTEGER NOT NULL DEFAULT 5,
  lockout_seconds INTEGER NOT NULL DEFAULT 900,
  session_limit INTEGER NOT NULL DEFAULT 20,
  anonymous_users_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  account_linking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  phone_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  passkeys_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, project_id, environment_id)
);

CREATE TABLE IF NOT EXISTS goodbase_auth_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','blocked','challenge')),
  provider TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 12: local development projects and linked CLI installations.
CREATE TABLE IF NOT EXISTS goodbase_local_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  linked_environment_id TEXT,
  project_ref TEXT NOT NULL UNIQUE,
  cli_version TEXT NOT NULL,
  stack_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','active','stopped','outdated','revoked')),
  last_seen_at TIMESTAMPTZ,
  compatibility_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 13: SDK release and compatibility registry.
CREATE TABLE IF NOT EXISTS goodbase_sdk_releases (
  id TEXT PRIMARY KEY,
  language TEXT NOT NULL CHECK (language IN ('javascript','typescript','python','dart','swift','kotlin','csharp')),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('preview','active','deprecated','retired')),
  minimum_platform_version TEXT NOT NULL,
  artifact_url TEXT,
  checksum_sha256 TEXT,
  capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  changelog TEXT,
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(language, version)
);

-- Phase 14: checksum-locked migration lifecycle and drift tracking.
CREATE TABLE IF NOT EXISTS goodbase_migration_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','approved','applying','applied','failed','rejected','rolled_back')),
  source_revision TEXT,
  schema_before_hash TEXT,
  schema_after_hash TEXT,
  destructive_change_count INTEGER NOT NULL DEFAULT 0,
  rls_warning_count INTEGER NOT NULL DEFAULT 0,
  index_warning_count INTEGER NOT NULL DEFAULT 0,
  validation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_migration_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES goodbase_migration_plans(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  rollback_guidance TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','applying','applied','failed','skipped')),
  execution_ms INTEGER,
  error_message TEXT,
  applied_at TIMESTAMPTZ,
  UNIQUE(plan_id, sequence),
  UNIQUE(plan_id, file_name)
);

CREATE TABLE IF NOT EXISTS goodbase_schema_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_sql TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local','remote','pre_migration','post_migration','preview')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_migration_locks (
  environment_id TEXT PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES goodbase_migration_plans(id) ON DELETE CASCADE,
  lock_token UUID NOT NULL DEFAULT gen_random_uuid(),
  locked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Phase 15: isolated preview environment lifecycle.
CREATE TABLE IF NOT EXISTS goodbase_preview_environments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  pull_request_ref TEXT,
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','provisioning','seeding','verifying','ready','paused','promoting','failed','deleting','deleted')),
  database_name TEXT NOT NULL UNIQUE,
  credential_secret_ref TEXT NOT NULL,
  api_url TEXT NOT NULL,
  auth_url TEXT NOT NULL,
  storage_namespace TEXT NOT NULL,
  realtime_tenant TEXT NOT NULL,
  function_namespace TEXT NOT NULL,
  custom_domain TEXT,
  cpu_limit_millicores INTEGER NOT NULL DEFAULT 500,
  memory_limit_mb INTEGER NOT NULL DEFAULT 512,
  storage_limit_mb INTEGER NOT NULL DEFAULT 1024,
  auto_pause_minutes INTEGER NOT NULL DEFAULT 60,
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ,
  health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(organization_id, project_id, slug)
);

CREATE TABLE IF NOT EXISTS goodbase_preview_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id TEXT NOT NULL REFERENCES goodbase_preview_environments(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('database','credentials','auth','storage','realtime','function','domain','secret')),
  resource_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(preview_id, resource_type, resource_ref)
);

CREATE TABLE IF NOT EXISTS goodbase_preview_events (
  id BIGSERIAL PRIMARY KEY,
  preview_id TEXT NOT NULL REFERENCES goodbase_preview_environments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_queues','goodbase_queue_messages','goodbase_schedules',
    'goodbase_backup_policies','goodbase_upload_sessions','goodbase_edge_functions',
    'goodbase_auth_channels','goodbase_auth_challenges','goodbase_auth_identities',
    'goodbase_passkey_credentials','goodbase_auth_hooks','goodbase_auth_security_policies',
    'goodbase_auth_events','goodbase_local_projects','goodbase_migration_plans',
    'goodbase_schema_snapshots','goodbase_preview_environments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY goodbase_tenant_isolation ON %I FOR ALL TO goodos_authenticated USING (organization_id = goodos_auth.organization_id()) WITH CHECK (organization_id = goodos_auth.organization_id())',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY goodbase_backend_service ON %I FOR ALL TO goodapp_backend_user USING (TRUE) WITH CHECK (TRUE)',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE,DELETE ON
  goodbase_auth_channels,goodbase_auth_challenges,goodbase_auth_identities,
  goodbase_passkey_credentials,goodbase_auth_hooks,goodbase_auth_security_policies,
  goodbase_auth_events,goodbase_local_projects,goodbase_sdk_releases,
  goodbase_migration_plans,goodbase_migration_steps,goodbase_schema_snapshots,
  goodbase_migration_locks,goodbase_preview_environments,goodbase_preview_resources,
  goodbase_preview_events TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE goodbase_auth_events_id_seq,goodbase_preview_events_id_seq TO goodapp_backend_user;

INSERT INTO goodbase_auth_channels (
  id,organization_id,project_id,environment_id,channel_type,provider,status,configuration_json
) VALUES
 ('auth_password_native','org_goodos','proj_goodos_platform','env_goodos_production','password','native','enabled','{"mfaOptionalByDefault":true}'::jsonb),
 ('auth_magic_link_native','org_goodos','proj_goodos_platform','env_goodos_production','magic_link','native','enabled','{"ttlSeconds":900,"singleUse":true}'::jsonb),
 ('auth_email_otp_native','org_goodos','proj_goodos_platform','env_goodos_production','email_otp','native','enabled','{"ttlSeconds":600,"digits":6}'::jsonb),
 ('auth_oidc_custom','org_goodos','proj_goodos_platform','env_goodos_production','oidc','custom','enabled','{"discovery":true,"pkce":true}'::jsonb),
 ('auth_saml_enterprise','org_goodos','proj_goodos_platform','env_goodos_production','saml','enterprise','enabled','{"scim":true}'::jsonb)
ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,configuration_json=EXCLUDED.configuration_json,updated_at=NOW();

INSERT INTO goodbase_auth_security_policies (
  id,organization_id,project_id,environment_id,leaked_password_detection,
  refresh_token_rotation,refresh_token_reuse_detection,max_login_attempts,lockout_seconds,session_limit
) VALUES (
  'auth_policy_goodos_production','org_goodos','proj_goodos_platform','env_goodos_production',
  TRUE,TRUE,TRUE,5,900,20
) ON CONFLICT(id) DO UPDATE SET
  leaked_password_detection=EXCLUDED.leaked_password_detection,
  refresh_token_rotation=EXCLUDED.refresh_token_rotation,
  refresh_token_reuse_detection=EXCLUDED.refresh_token_reuse_detection,
  updated_at=NOW();

INSERT INTO goodbase_sdk_releases (
  id,language,version,status,minimum_platform_version,artifact_url,capabilities_json,changelog
) VALUES (
  'sdk_javascript_1_1_0','javascript','1.1.0','active','1.0.0','https://base.goodos.app/sdk/goodos.js',
  '["auth","rest","graphql","realtime","storage","functions","queues","migrations","previews"]'::jsonb,
  'Adds Goodbase Phase 11-15 clients, cancellation, retries, and typed errors.'
) ON CONFLICT(id) DO UPDATE SET status='active',artifact_url=EXCLUDED.artifact_url,capabilities_json=EXCLUDED.capabilities_json;

INSERT INTO backend_jobs (
  id,name,display_name,description,job_type,handler_key,status,priority,
  schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,
  metadata_json,organization_id,project_id,environment_id,created_by
) VALUES
 ('job_goodbase_auth_maintenance','goodbase.auth.maintain','Maintain Authentication Challenges',
  'Expires single-use passwordless and passkey challenges and enforces challenge retention.',
  'scheduled','goodbase.auth.maintain','active',5,60,120,3,'goodbase.auth.maintain',NOW(),
  '{"phase":11}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_migration_maintenance','goodbase.migrations.maintain','Maintain Migration Lifecycle',
  'Releases expired migration locks and detects stale applying plans.',
  'scheduled','goodbase.migrations.maintain','active',6,60,120,3,'goodbase.migrations.maintain',NOW(),
  '{"phase":14}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_preview_reconcile','goodbase.previews.reconcile','Reconcile Preview Environments',
  'Dispatches requested previews, pauses inactive previews, and deletes expired previews.',
  'scheduled','goodbase.previews.reconcile','active',7,30,300,3,'goodbase.previews.reconcile',NOW(),
  '{"phase":15}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
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
FROM backend_jobs WHERE id IN (
  'job_goodbase_auth_maintenance','job_goodbase_migration_maintenance','job_goodbase_preview_reconcile'
)
ON CONFLICT(job_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,
  enabled=TRUE,next_run_at=EXCLUDED.next_run_at,metadata_json=EXCLUDED.metadata_json,updated_at=NOW();

INSERT INTO backend_data_plane_components (
  id,component,version,status,endpoint,health_status,configuration_json,metadata_json,created_at,updated_at
) VALUES
 ('goodbase_phase_11_auth','complete_auth','1.0.0','active','/api/auth/v3','healthy','{"passwordless":true,"oidc":true,"saml":true,"scim":true}'::jsonb,'{"phase":11,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_12_local','local_development','1.0.0','active','goodbase://cli','healthy','{"compose":true,"noninteractive":true}'::jsonb,'{"phase":12,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_13_sdk','sdk_ecosystem','1.1.0','active','/sdk/goodos.js','healthy','{"javascript":true,"typed":true}'::jsonb,'{"phase":13,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_14_migrations','migration_lifecycle','1.0.0','active','/api/goodbase/v1/developer/migrations','healthy','{"checksums":true,"locking":true,"drift":true}'::jsonb,'{"phase":14,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_15_previews','preview_environments','1.0.0','active','/api/goodbase/v1/developer/previews','healthy','{"isolatedResources":true,"autoPause":true,"promotionGates":true}'::jsonb,'{"phase":15,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW())
ON CONFLICT(id) DO UPDATE SET
  component=EXCLUDED.component,version=EXCLUDED.version,status=EXCLUDED.status,
  endpoint=EXCLUDED.endpoint,health_status=EXCLUDED.health_status,
  configuration_json=EXCLUDED.configuration_json,
  metadata_json=backend_data_plane_components.metadata_json || EXCLUDED.metadata_json,
  updated_at=NOW();

COMMIT;
