BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_password_reset_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_level TEXT NOT NULL DEFAULT 'password';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_token_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_label TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_country TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS environment_id TEXT;

CREATE TABLE IF NOT EXISTS backend_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  level INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_permissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'platform',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_role_permissions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS backend_user_roles (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  role_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'platform',
  scope_id TEXT NOT NULL DEFAULT '*',
  status TEXT NOT NULL DEFAULT 'active',
  assigned_by UUID,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, role_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS backend_mfa_factors (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'totp',
  label TEXT NOT NULL DEFAULT 'Authenticator App',
  status TEXT NOT NULL DEFAULT 'pending',
  secret_hash TEXT,
  secret_prefix TEXT,
  secret_encrypted TEXT,
  verified_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  recovery_codes_hash JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_mfa_factors_user
ON backend_mfa_factors(user_id);

CREATE INDEX IF NOT EXISTS idx_backend_mfa_factors_status
ON backend_mfa_factors(status);

CREATE TABLE IF NOT EXISTS backend_mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  factor_id TEXT,
  challenge_type TEXT NOT NULL DEFAULT 'totp',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  verified_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_mfa_challenges_user
ON backend_mfa_challenges(user_id);

CREATE INDEX IF NOT EXISTS idx_backend_mfa_challenges_status
ON backend_mfa_challenges(status);

CREATE TABLE IF NOT EXISTS backend_password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  requested_by TEXT,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
  used_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_password_reset_tokens_hash
ON backend_password_reset_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_backend_password_reset_tokens_user
ON backend_password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS backend_auth_refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  revoked_at TIMESTAMPTZ,
  rotated_to_token_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_auth_refresh_tokens_hash
ON backend_auth_refresh_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_backend_auth_refresh_tokens_user
ON backend_auth_refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS backend_auth_audit_events (
  id TEXT PRIMARY KEY,
  user_id UUID,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  ip_address TEXT,
  user_agent TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_auth_audit_events_user
ON backend_auth_audit_events(user_id);

CREATE INDEX IF NOT EXISTS idx_backend_auth_audit_events_type
ON backend_auth_audit_events(event_type);

INSERT INTO backend_roles (id, name, display_name, description, level, metadata_json, organization_id, project_id, environment_id, created_by)
VALUES
  ('role_owner', 'owner', 'Owner', 'Full platform owner access.', 1, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('role_admin', 'admin', 'Admin', 'Administrative access.', 10, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('role_manager', 'manager', 'Manager', 'Management access.', 30, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('role_developer', 'developer', 'Developer', 'Developer platform access.', 40, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('role_user', 'user', 'User', 'Standard user access.', 70, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('role_viewer', 'viewer', 'Viewer', 'Read-only viewer access.', 90, '{"phase":"21A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  level = EXCLUDED.level,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_permissions (id, name, category, description, metadata_json)
VALUES
  ('perm_auth_read', 'auth:read', 'auth', 'Read auth users, sessions, roles, and MFA state.', '{"phase":"21A"}'::jsonb),
  ('perm_auth_manage', 'auth:manage', 'auth', 'Manage users, sessions, roles, invites, password resets, and MFA.', '{"phase":"21A"}'::jsonb),
  ('perm_apps_manage', 'apps:manage', 'apps', 'Manage application registry and memberships.', '{"phase":"21A"}'::jsonb),
  ('perm_db_manage', 'db:manage', 'database', 'Manage database APIs and table permissions.', '{"phase":"21A"}'::jsonb),
  ('perm_storage_manage', 'storage:manage', 'storage', 'Manage storage buckets and objects.', '{"phase":"21A"}'::jsonb),
  ('perm_functions_manage', 'functions:manage', 'functions', 'Manage Edge Functions.', '{"phase":"21A"}'::jsonb),
  ('perm_realtime_manage', 'realtime:manage', 'realtime', 'Manage Realtime channels and messages.', '{"phase":"21A"}'::jsonb),
  ('perm_webhooks_manage', 'webhooks:manage', 'webhooks', 'Manage webhooks.', '{"phase":"21A"}'::jsonb),
  ('perm_settings_manage', 'settings:manage', 'settings', 'Manage platform settings.', '{"phase":"21A"}'::jsonb)
ON CONFLICT (id) DO UPDATE
SET
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_role_permissions (id, role_id, permission_id)
SELECT
  'rp_' || r.id || '_' || p.id,
  r.id,
  p.id
FROM backend_roles r
JOIN backend_permissions p ON (
  r.name IN ('owner', 'admin')
  OR (r.name = 'developer' AND p.name IN ('auth:read','apps:manage','db:manage','storage:manage','functions:manage','realtime:manage','webhooks:manage'))
  OR (r.name = 'manager' AND p.name IN ('auth:read','apps:manage','storage:manage','realtime:manage','webhooks:manage'))
  OR (r.name IN ('user','viewer') AND p.name = 'auth:read')
)
ON CONFLICT (role_id, permission_id) DO UPDATE
SET status = 'active';

INSERT INTO backend_user_roles (
  id,
  user_id,
  role_id,
  role_name,
  scope_type,
  scope_id,
  status,
  assigned_by,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
SELECT
  'userrole_' || replace(u.id::text, '-', '') || '_' || COALESCE(NULLIF(u.platform_role, ''), 'user'),
  u.id,
  CASE COALESCE(NULLIF(u.platform_role, ''), 'user')
    WHEN 'owner' THEN 'role_owner'
    WHEN 'admin' THEN 'role_admin'
    WHEN 'manager' THEN 'role_manager'
    WHEN 'developer' THEN 'role_developer'
    WHEN 'viewer' THEN 'role_viewer'
    ELSE 'role_user'
  END,
  COALESCE(NULLIF(u.platform_role, ''), 'user'),
  'platform',
  '*',
  'active',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  '{"seededFromUsersPlatformRole":true,"phase":"21A"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users u
ON CONFLICT (user_id, role_id, scope_type, scope_id) DO UPDATE
SET
  role_name = EXCLUDED.role_name,
  status = 'active',
  updated_at = NOW();

UPDATE sessions
SET
  organization_id = COALESCE(organization_id, 'org_goodos'),
  project_id = COALESCE(project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(environment_id, 'env_goodos_production'),
  last_seen_at = COALESCE(last_seen_at, created_at, NOW()),
  metadata_json = COALESCE(metadata_json, '{}'::jsonb);

INSERT INTO backend_policy_rules (
  id,
  name,
  description,
  target_type,
  target_id,
  operation,
  effect,
  priority,
  condition_json,
  message,
  status,
  organization_id,
  project_id,
  environment_id,
  metadata_json,
  created_by
)
VALUES
  (
    'pol_auth_read_owner_admin',
    'Allow auth read for owner/admin',
    'Allows owner/admin users to read Auth V2 records.',
    'auth',
    '*',
    'read',
    'allow',
    90,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Auth read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"21A","authV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_auth_manage_owner',
    'Allow auth management for owner',
    'Allows owner users to manage Auth V2 records.',
    'auth',
    '*',
    'manage',
    'allow',
    90,
    '{"requiredRoles":["owner"]}'::jsonb,
    'Auth management allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"21A","authV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_session_manage_owner_admin',
    'Allow session management for owner/admin',
    'Allows owner/admin users to revoke and inspect sessions.',
    'session',
    '*',
    'manage',
    'allow',
    90,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Session management allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"21A","authV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  condition_json = EXCLUDED.condition_json,
  message = EXCLUDED.message,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_auth_audit_events (
  id,
  user_id,
  event_type,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'authevt_phase21a_ready',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'auth.v2.ready',
  'recorded',
  '{"phase":"21A","features":["roles","permissions","mfa","password-reset","refresh-tokens","session-metadata"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_roles TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_permissions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_role_permissions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_user_roles TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_mfa_factors TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_mfa_challenges TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_password_reset_tokens TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_auth_refresh_tokens TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_auth_audit_events TO goodapp_backend_user;

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
  'audit_phase_21a_auth_v2',
  'system',
  'auth.v2.ready',
  'auth',
  'backend_roles',
  '{"phase":"21A","features":["sessions","roles","permissions","mfa","password-reset","refresh-tokens"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
