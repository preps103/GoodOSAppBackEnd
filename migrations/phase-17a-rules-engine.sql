BEGIN;

CREATE TABLE IF NOT EXISTS backend_policy_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '*',
  operation TEXT NOT NULL DEFAULT '*',
  effect TEXT NOT NULL DEFAULT 'allow',
  priority INTEGER NOT NULL DEFAULT 100,
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  metadata_json JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_target
ON backend_policy_rules(target_type, target_id, operation);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_status
ON backend_policy_rules(status);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_priority
ON backend_policy_rules(priority);

CREATE INDEX IF NOT EXISTS idx_backend_policy_rules_project_env
ON backend_policy_rules(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_policy_evaluations (
  id TEXT PRIMARY KEY,
  policy_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  api_key_id TEXT,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  context_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_policy_evaluations_created
ON backend_policy_evaluations(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_policy_evaluations_target
ON backend_policy_evaluations(target_type, target_id, operation);

CREATE INDEX IF NOT EXISTS idx_backend_policy_evaluations_api_key
ON backend_policy_evaluations(api_key_id);

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
    'pol_db_api_read_allow',
    'Allow published database API reads',
    'Allows API keys with read:db to read published Database API tables.',
    'db_api',
    '*',
    'read',
    'allow',
    100,
    '{"requiredScopes":["read:db"]}'::jsonb,
    'Database API read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_db_api_insert_allow',
    'Allow published database API inserts',
    'Allows API keys with write:db to insert into write-enabled Database API tables.',
    'db_api',
    '*',
    'insert',
    'allow',
    100,
    '{"requiredScopes":["write:db"]}'::jsonb,
    'Database API insert allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_db_api_update_allow',
    'Allow published database API updates',
    'Allows API keys with write:db to update write-enabled Database API rows.',
    'db_api',
    '*',
    'update',
    'allow',
    100,
    '{"requiredScopes":["write:db"]}'::jsonb,
    'Database API update allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_db_api_delete_allow',
    'Allow published database API deletes',
    'Allows API keys with write:db to delete or soft-delete write-enabled Database API rows.',
    'db_api',
    '*',
    'delete',
    'allow',
    100,
    '{"requiredScopes":["write:db"]}'::jsonb,
    'Database API delete allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_functions_execute_allow',
    'Allow public function execution',
    'Allows API keys with execute:functions to execute HTTP Edge Functions.',
    'function',
    '*',
    'execute',
    'allow',
    100,
    '{"requiredScopes":["execute:functions"]}'::jsonb,
    'Function execution allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_storage_read_allow',
    'Allow public storage reads',
    'Allows API keys with read:storage to list storage buckets and files.',
    'storage',
    '*',
    'read',
    'allow',
    100,
    '{"requiredScopes":["read:storage"]}'::jsonb,
    'Storage read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_admin_owner_allow',
    'Allow owner admin controls',
    'Baseline admin policy for owner-level console access.',
    'admin',
    '*',
    '*',
    'allow',
    100,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Admin owner policy ready.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded":true,"phase":"17A"}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  target_type = EXCLUDED.target_type,
  target_id = EXCLUDED.target_id,
  operation = EXCLUDED.operation,
  effect = EXCLUDED.effect,
  priority = EXCLUDED.priority,
  condition_json = EXCLUDED.condition_json,
  message = EXCLUDED.message,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_rules TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_policy_evaluations TO goodapp_backend_user;

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
  'audit_phase_17a_rules_engine',
  'system',
  'rules.engine.ready',
  'policy_engine',
  'backend_policy_rules',
  '{"phase":"17A","policyRulesSeeded":7,"enforcedTargets":["db_api","function","storage"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
