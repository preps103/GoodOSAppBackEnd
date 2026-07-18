BEGIN;

CREATE TABLE IF NOT EXISTS backend_policy_rule_sets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
  evaluation_mode TEXT NOT NULL DEFAULT 'enforce'
    CHECK (evaluation_mode IN ('enforce', 'monitor')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID,
  published_by UUID,
  published_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rule_sets_org_status
ON backend_policy_rule_sets (organization_id, status);

CREATE TABLE IF NOT EXISTS backend_policy_rule_revisions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  rule_set_id TEXT,
  version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  change_note TEXT,
  published_by UUID,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, version)
);

CREATE INDEX IF NOT EXISTS idx_backend_policy_revisions_rule
ON backend_policy_rule_revisions (rule_id, version DESC);

CREATE TABLE IF NOT EXISTS backend_policy_engine_settings (
  organization_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  evaluation_mode TEXT NOT NULL DEFAULT 'enforce'
    CHECK (evaluation_mode IN ('enforce', 'monitor', 'disabled')),
  default_effect TEXT NOT NULL DEFAULT 'allow'
    CHECK (default_effect IN ('allow', 'deny')),
  fail_mode TEXT NOT NULL DEFAULT 'allow'
    CHECK (fail_mode IN ('allow', 'deny')),
  trace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE backend_policy_rules
  ADD COLUMN IF NOT EXISTS rule_set_id TEXT,
  ADD COLUMN IF NOT EXISTS match_mode TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS rollout_percentage INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS checksum TEXT,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_rule_set
ON backend_policy_rules (rule_set_id, status, priority);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_schedule
ON backend_policy_rules (starts_at, ends_at);

ALTER TABLE backend_policy_evaluations
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS rule_set_id TEXT,
  ADD COLUMN IF NOT EXISTS matched_policy_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS trace_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS engine_version TEXT NOT NULL DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS idx_backend_policy_evaluations_request
ON backend_policy_evaluations (request_id);

CREATE INDEX IF NOT EXISTS idx_backend_policy_evaluations_engine
ON backend_policy_evaluations (engine_version, created_at DESC);

INSERT INTO backend_policy_rule_sets (
  id, organization_id, name, description, status, evaluation_mode,
  version, created_by, published_by, published_at, metadata_json
)
VALUES (
  'ruleset_legacy_v1',
  'org_goodos',
  'Legacy Rules Engine V1',
  'Existing GoodOS policy rules migrated into a managed rule set.',
  'active',
  'enforce',
  1,
  (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
  (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
  NOW(),
  '{"phase":17,"source":"legacy-v1"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backend_policy_rule_sets (
  id, organization_id, name, description, status, evaluation_mode,
  version, created_by, published_by, published_at, metadata_json
)
VALUES (
  'ruleset_phase17_gateway_v2',
  'org_goodos',
  'Enterprise API Gateway Rules',
  'Central policy enforcement for GoodOS Enterprise API Gateway V2.',
  'active',
  'enforce',
  1,
  (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
  (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
  NOW(),
  '{"phase":17,"engine":"v2"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

UPDATE backend_policy_rules
SET
  rule_set_id = 'ruleset_legacy_v1',
  published_at = COALESCE(published_at, created_at),
  version = GREATEST(COALESCE(version, 1), 1)
WHERE rule_set_id IS NULL;

INSERT INTO backend_policy_engine_settings (
  organization_id, status, evaluation_mode, default_effect, fail_mode,
  trace_enabled, updated_by, metadata_json
)
VALUES (
  'org_goodos',
  'active',
  'enforce',
  'allow',
  'allow',
  TRUE,
  (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
  '{"phase":17,"engineVersion":"v2"}'::jsonb
)
ON CONFLICT (organization_id)
DO UPDATE SET
  status = EXCLUDED.status,
  evaluation_mode = EXCLUDED.evaluation_mode,
  trace_enabled = EXCLUDED.trace_enabled,
  metadata_json = COALESCE(backend_policy_engine_settings.metadata_json, '{}'::jsonb)
                  || EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_rule_sets TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_rule_revisions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_engine_settings TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_rules TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_evaluations TO goodapp_backend_user;

COMMIT;
