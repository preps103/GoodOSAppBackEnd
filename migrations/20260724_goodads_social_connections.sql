BEGIN;

CREATE TABLE IF NOT EXISTS goodads_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT,
  return_origin TEXT NOT NULL DEFAULT 'https://ads.goodos.app',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodads_oauth_states_expiry
  ON goodads_oauth_states (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_tag TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  refresh_token_tag TEXT,
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'expired', 'disconnected', 'error')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id, provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_goodads_social_connections_tenant
  ON goodads_social_connections (organization_id, user_id, provider, status);

CREATE TABLE IF NOT EXISTS goodads_publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  content JSONB NOT NULL,
  requested_providers TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'partial', 'failed')),
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_oauth_states TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_social_connections TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE ON goodads_publish_jobs TO goodapp_backend_user;

COMMIT;
