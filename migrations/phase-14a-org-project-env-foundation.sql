BEGIN;

CREATE TABLE IF NOT EXISTS backend_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'enterprise',
  status TEXT NOT NULL DEFAULT 'active',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES backend_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS backend_project_environments (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES backend_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'production',
  status TEXT NOT NULL DEFAULT 'active',
  api_base_url TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS backend_organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS backend_project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES backend_projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_backend_organizations_status
ON backend_organizations(status);

CREATE INDEX IF NOT EXISTS idx_backend_projects_org
ON backend_projects(organization_id);

CREATE INDEX IF NOT EXISTS idx_backend_projects_status
ON backend_projects(status);

CREATE INDEX IF NOT EXISTS idx_backend_project_environments_project
ON backend_project_environments(project_id);

CREATE INDEX IF NOT EXISTS idx_backend_project_environments_status
ON backend_project_environments(status);

CREATE INDEX IF NOT EXISTS idx_backend_org_memberships_user
ON backend_organization_memberships(user_id);

CREATE INDEX IF NOT EXISTS idx_backend_project_memberships_user
ON backend_project_memberships(user_id);

INSERT INTO backend_organizations (
  id,
  name,
  slug,
  plan,
  status,
  owner_user_id,
  metadata_json
)
SELECT
  'org_goodos',
  'GoodOS',
  'goodos',
  'enterprise',
  'active',
  id,
  '{"seeded": true, "source": "phase_14a"}'::jsonb
FROM users
ORDER BY created_at ASC
LIMIT 1
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  plan = EXCLUDED.plan,
  status = EXCLUDED.status,
  owner_user_id = COALESCE(backend_organizations.owner_user_id, EXCLUDED.owner_user_id),
  updated_at = NOW();

INSERT INTO backend_projects (
  id,
  organization_id,
  name,
  slug,
  status,
  description,
  metadata_json
)
VALUES (
  'proj_goodos_platform',
  'org_goodos',
  'GoodOS Platform',
  'goodos-platform',
  'active',
  'Primary GoodOS backend platform project.',
  '{"seeded": true, "source": "phase_14a"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  organization_id = EXCLUDED.organization_id,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  updated_at = NOW();

INSERT INTO backend_project_environments (
  id,
  project_id,
  name,
  slug,
  type,
  status,
  api_base_url,
  metadata_json
)
VALUES
  (
    'env_goodos_development',
    'proj_goodos_platform',
    'Development',
    'development',
    'development',
    'active',
    'https://base.goodos.app',
    '{"seeded": true, "source": "phase_14a"}'::jsonb
  ),
  (
    'env_goodos_staging',
    'proj_goodos_platform',
    'Staging',
    'staging',
    'staging',
    'active',
    'https://base.goodos.app',
    '{"seeded": true, "source": "phase_14a"}'::jsonb
  ),
  (
    'env_goodos_production',
    'proj_goodos_platform',
    'Production',
    'production',
    'production',
    'active',
    'https://base.goodos.app',
    '{"seeded": true, "source": "phase_14a"}'::jsonb
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  project_id = EXCLUDED.project_id,
  type = EXCLUDED.type,
  status = EXCLUDED.status,
  api_base_url = EXCLUDED.api_base_url,
  updated_at = NOW();

INSERT INTO backend_organization_memberships (
  id,
  organization_id,
  user_id,
  role,
  status
)
SELECT
  'orgmem_goodos_' || REPLACE(id::text, '-', ''),
  'org_goodos',
  id,
  'owner',
  'active'
FROM users
ORDER BY created_at ASC
LIMIT 1
ON CONFLICT (organization_id, user_id) DO UPDATE
SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO backend_project_memberships (
  id,
  project_id,
  user_id,
  role,
  status
)
SELECT
  'projmem_goodos_' || REPLACE(id::text, '-', ''),
  'proj_goodos_platform',
  id,
  'owner',
  'active'
FROM users
ORDER BY created_at ASC
LIMIT 1
ON CONFLICT (project_id, user_id) DO UPDATE
SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = NOW();

ALTER TABLE apps ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE app_memberships ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_api_keys ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_api_keys ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_api_keys ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_webhooks ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_webhooks ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_webhooks ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_webhook_deliveries ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_webhook_deliveries ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_webhook_deliveries ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_database_backups ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_database_backups ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_database_backups ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_platform_settings ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_platform_settings ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_platform_settings ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_admin_audit_logs ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_admin_audit_logs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_admin_audit_logs ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_system_logs ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_system_logs ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_system_logs ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_events ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_events ADD COLUMN IF NOT EXISTS environment_id TEXT;

ALTER TABLE backend_user_invites ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_user_invites ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_user_invites ADD COLUMN IF NOT EXISTS environment_id TEXT;

UPDATE apps SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE app_memberships SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_api_keys SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_storage_buckets SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_storage_files SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_storage_signed_urls SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_webhooks SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_webhook_deliveries SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_realtime_events SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_edge_functions SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_edge_function_runs SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_database_backups SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_platform_settings SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_admin_audit_logs SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_system_logs SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_events SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;
UPDATE backend_user_invites SET organization_id = 'org_goodos', project_id = 'proj_goodos_platform', environment_id = 'env_goodos_production' WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_apps_project_env ON apps(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_app_memberships_project_env ON app_memberships(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_api_keys_project_env ON backend_api_keys(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_storage_buckets_project_env ON backend_storage_buckets(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_storage_files_project_env ON backend_storage_files(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_storage_signed_urls_project_env ON backend_storage_signed_urls(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_webhooks_project_env ON backend_webhooks(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_webhook_deliveries_project_env ON backend_webhook_deliveries(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_realtime_events_project_env ON backend_realtime_events(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_edge_functions_project_env ON backend_edge_functions(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_edge_function_runs_project_env ON backend_edge_function_runs(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_database_backups_project_env ON backend_database_backups(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_platform_settings_project_env ON backend_platform_settings(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_admin_audit_logs_project_env ON backend_admin_audit_logs(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_system_logs_project_env ON backend_system_logs(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_events_project_env ON backend_events(project_id, environment_id);
CREATE INDEX IF NOT EXISTS idx_backend_user_invites_project_env ON backend_user_invites(project_id, environment_id);

INSERT INTO backend_admin_audit_logs (
  id,
  actor,
  action,
  target_type,
  target_id,
  after_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'audit_phase_14a_org_project_env_foundation',
  'system',
  'projects.foundation.ready',
  'project_environment',
  'env_goodos_production',
  '{"phase":"14A","organization":"org_goodos","project":"proj_goodos_platform","environment":"env_goodos_production"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
