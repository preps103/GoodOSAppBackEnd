BEGIN;

CREATE TABLE IF NOT EXISTS backend_secret_vaults (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'local_encrypted',
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_secrets (
  id TEXT PRIMARY KEY,
  vault_id TEXT,
  secret_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  provider TEXT NOT NULL DEFAULT 'local_encrypted',
  secret_ref TEXT NOT NULL UNIQUE,
  current_version_id TEXT,
  value_prefix TEXT,
  value_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(secret_key, environment_id)
);

CREATE INDEX IF NOT EXISTS idx_backend_secrets_key ON backend_secrets(secret_key);
CREATE INDEX IF NOT EXISTS idx_backend_secrets_status ON backend_secrets(status);
CREATE INDEX IF NOT EXISTS idx_backend_secrets_category ON backend_secrets(category);

CREATE TABLE IF NOT EXISTS backend_secret_versions (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  encrypted_value TEXT,
  value_hash TEXT,
  value_prefix TEXT,
  encryption_method TEXT NOT NULL DEFAULT 'aes-256-gcm',
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_from_version_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(secret_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_backend_secret_versions_secret ON backend_secret_versions(secret_id, status);

CREATE TABLE IF NOT EXISTS backend_provider_credentials (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE,
  provider_name TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'generic',
  status TEXT NOT NULL DEFAULT 'active',
  secret_refs_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at TIMESTAMPTZ,
  verification_status TEXT NOT NULL DEFAULT 'not_verified',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_secret_access_logs (
  id TEXT PRIMARY KEY,
  secret_id TEXT,
  secret_ref TEXT,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_id TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  ip_address TEXT,
  user_agent TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_secret_access_logs_secret ON backend_secret_access_logs(secret_id, created_at DESC);

INSERT INTO backend_secret_vaults (
  id, name, provider, status, description, config_json, metadata_json,
  organization_id, project_id, environment_id, created_by
)
VALUES (
  'vault_goodos_local',
  'GoodOS Local Encrypted Vault',
  'local_encrypted',
  'active',
  'Local encrypted vault using server-side encryption key material.',
  '{"storage":"postgres","rawValuesReturned":false}'::jsonb,
  '{"phase":"25A"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status, updated_at = NOW();

INSERT INTO backend_provider_credentials (
  id, provider_key, provider_name, provider_type, status, secret_refs_json, config_json,
  verification_status, metadata_json, organization_id, project_id, environment_id, created_by
)
VALUES
  ('provider_smtp_goodos', 'smtp.goodos', 'GoodOS SMTP Email Provider', 'email', 'configured_pending_secrets', '{"host":"secret://SMTP_HOST","user":"secret://SMTP_USER","pass":"secret://SMTP_PASS"}'::jsonb, '{"port":587,"secure":false}'::jsonb, 'not_verified', '{"phase":"25A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('provider_stripe_goodos', 'stripe.goodos', 'GoodOS Stripe Provider', 'billing', 'planned', '{"secretKey":"secret://STRIPE_SECRET_KEY","webhookSecret":"secret://STRIPE_WEBHOOK_SECRET"}'::jsonb, '{}'::jsonb, 'not_verified', '{"phase":"25A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('provider_storage_s3_goodos', 'storage.s3.goodos', 'GoodOS S3-Compatible Storage Provider', 'storage', 'planned', '{"accessKey":"secret://S3_ACCESS_KEY","secretKey":"secret://S3_SECRET_KEY"}'::jsonb, '{}'::jsonb, 'not_verified', '{"phase":"25A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET provider_name = EXCLUDED.provider_name,
    provider_type = EXCLUDED.provider_type,
    secret_refs_json = EXCLUDED.secret_refs_json,
    config_json = EXCLUDED.config_json,
    updated_at = NOW();

INSERT INTO backend_policy_rules (
  id, name, description, target_type, target_id, operation, effect, priority,
  condition_json, message, status, organization_id, project_id, environment_id, metadata_json, created_by
)
VALUES
  ('pol_secrets_read_owner_admin', 'Allow secret metadata reads', 'Allows owner/admin users to read secret metadata only.', 'secret', '*', 'read', 'allow', 100, '{"requiredRoles":["owner","admin"]}'::jsonb, 'Secret metadata read allowed.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"25A"}'::jsonb, (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('pol_secrets_manage_owner_admin', 'Allow secret management', 'Allows owner/admin users to create and rotate secret references.', 'secret', '*', 'manage', 'allow', 100, '{"requiredRoles":["owner","admin"]}'::jsonb, 'Secret management allowed.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"25A"}'::jsonb, (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET condition_json = EXCLUDED.condition_json,
    status = EXCLUDED.status,
    updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_secret_vaults TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_secrets TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_secret_versions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_provider_credentials TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_secret_access_logs TO goodapp_backend_user;

COMMIT;
