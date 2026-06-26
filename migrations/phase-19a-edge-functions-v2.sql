BEGIN;

ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS source_code TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS handler_name TEXT NOT NULL DEFAULT 'handler';
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS runtime_version TEXT NOT NULL DEFAULT 'node-v22';
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS runtime_profile TEXT NOT NULL DEFAULT 'controlled';
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS sandbox_mode TEXT NOT NULL DEFAULT 'goodos-controlled';
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS timeout_ms INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS memory_mb INTEGER NOT NULL DEFAULT 128;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS max_input_bytes INTEGER NOT NULL DEFAULT 262144;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS network_access_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS secrets_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS public_invocation_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS require_api_key BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS environment_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS permissions_json JSONB NOT NULL DEFAULT '{"network":false,"storage":false,"database":false,"webhooks":false}'::jsonb;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS limits_json JSONB NOT NULL DEFAULT '{"timeoutMs":5000,"memoryMb":128,"maxInputBytes":262144}'::jsonb;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS deployment_id TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS current_version_id TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS deployed_by UUID;
ALTER TABLE backend_edge_functions ADD COLUMN IF NOT EXISTS log_level TEXT NOT NULL DEFAULT 'info';

ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS runtime_version TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS runtime_profile TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS sandbox_mode TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS memory_mb INTEGER;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS memory_used_mb INTEGER;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS cold_start_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS logs_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS context_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS policy_decision_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS deployment_id TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS version_id TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS invocation_source TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS caller_ip TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS error_stack TEXT;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS exit_code INTEGER;
ALTER TABLE backend_edge_function_runs ADD COLUMN IF NOT EXISTS timed_out BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS backend_edge_function_versions (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  version_label TEXT NOT NULL DEFAULT 'v1',
  runtime TEXT NOT NULL DEFAULT 'node',
  runtime_version TEXT NOT NULL DEFAULT 'node-v22',
  runtime_profile TEXT NOT NULL DEFAULT 'controlled',
  sandbox_mode TEXT NOT NULL DEFAULT 'goodos-controlled',
  handler_name TEXT NOT NULL DEFAULT 'handler',
  source_code TEXT,
  code_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  deployment_status TEXT NOT NULL DEFAULT 'deployed',
  environment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  deployed_by UUID,
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_versions_function
ON backend_edge_function_versions(function_id);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_versions_status
ON backend_edge_function_versions(status);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_versions_project_env
ON backend_edge_function_versions(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_edge_function_deployments (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL,
  version_id TEXT,
  deployment_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'deployed',
  source TEXT NOT NULL DEFAULT 'console',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  logs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_deployments_function
ON backend_edge_function_deployments(function_id);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_deployments_status
ON backend_edge_function_deployments(status);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_deployments_project_env
ON backend_edge_function_deployments(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_edge_function_secrets (
  id TEXT PRIMARY KEY,
  function_id TEXT,
  secret_key TEXT NOT NULL,
  secret_prefix TEXT,
  value_hash TEXT,
  secret_ref TEXT,
  scope TEXT NOT NULL DEFAULT 'function',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_secrets_function
ON backend_edge_function_secrets(function_id);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_secrets_key
ON backend_edge_function_secrets(secret_key);

CREATE INDEX IF NOT EXISTS idx_backend_edge_function_secrets_status
ON backend_edge_function_secrets(status);

UPDATE backend_edge_functions
SET
  source_code = COALESCE(source_code, '// GoodOS controlled runtime template for ' || id),
  handler_name = COALESCE(handler_name, 'handler'),
  runtime_version = COALESCE(runtime_version, 'node-v22'),
  runtime_profile = COALESCE(runtime_profile, 'controlled'),
  sandbox_mode = COALESCE(sandbox_mode, 'goodos-controlled'),
  timeout_ms = COALESCE(timeout_ms, COALESCE(timeout_seconds, 5) * 1000),
  memory_mb = COALESCE(memory_mb, 128),
  max_input_bytes = COALESCE(max_input_bytes, 262144),
  network_access_enabled = COALESCE(network_access_enabled, false),
  secrets_enabled = COALESCE(secrets_enabled, true),
  public_invocation_enabled = COALESCE(public_invocation_enabled, CASE WHEN type = 'http' THEN true ELSE false END),
  require_api_key = COALESCE(require_api_key, true),
  environment_json = COALESCE(environment_json, '{}'::jsonb),
  permissions_json = COALESCE(permissions_json, '{"network":false,"storage":false,"database":false,"webhooks":false}'::jsonb),
  limits_json = COALESCE(limits_json, jsonb_build_object('timeoutMs', COALESCE(timeout_seconds, 5) * 1000, 'memoryMb', 128, 'maxInputBytes', 262144)),
  metadata_json = COALESCE(metadata_json, '{}'::jsonb),
  version_number = COALESCE(version_number, 1),
  code_hash = COALESCE(code_hash, md5(COALESCE(source_code, id || ':' || name))),
  current_version_id = COALESCE(current_version_id, 'fnver_' || id || '_v1'),
  deployment_id = COALESCE(deployment_id, 'fndeploy_' || id || '_initial'),
  deployed_at = COALESCE(deployed_at, NOW()),
  deployed_by = COALESCE(deployed_by, (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  log_level = COALESCE(log_level, 'info'),
  organization_id = COALESCE(organization_id, 'org_goodos'),
  project_id = COALESCE(project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(environment_id, 'env_goodos_production'),
  updated_at = NOW();

INSERT INTO backend_edge_function_versions (
  id,
  function_id,
  version_number,
  version_label,
  runtime,
  runtime_version,
  runtime_profile,
  sandbox_mode,
  handler_name,
  source_code,
  code_hash,
  status,
  deployment_status,
  environment_json,
  permissions_json,
  limits_json,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by,
  deployed_by,
  deployed_at
)
SELECT
  'fnver_' || id || '_v1',
  id,
  1,
  'v1',
  runtime,
  runtime_version,
  runtime_profile,
  sandbox_mode,
  handler_name,
  source_code,
  code_hash,
  'active',
  'deployed',
  environment_json,
  permissions_json,
  limits_json,
  jsonb_build_object('seeded', true, 'phase', '19A'),
  organization_id,
  project_id,
  environment_id,
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  deployed_by,
  deployed_at
FROM backend_edge_functions
ON CONFLICT (id) DO UPDATE
SET
  source_code = EXCLUDED.source_code,
  code_hash = EXCLUDED.code_hash,
  runtime_version = EXCLUDED.runtime_version,
  runtime_profile = EXCLUDED.runtime_profile,
  sandbox_mode = EXCLUDED.sandbox_mode,
  limits_json = EXCLUDED.limits_json,
  updated_at = NOW();

INSERT INTO backend_edge_function_deployments (
  id,
  function_id,
  version_id,
  deployment_number,
  status,
  source,
  completed_at,
  duration_ms,
  logs_json,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
SELECT
  'fndeploy_' || id || '_initial',
  id,
  'fnver_' || id || '_v1',
  1,
  'deployed',
  'phase-19a-seed',
  NOW(),
  0,
  '[{"level":"info","message":"Initial Edge Functions V2 deployment record seeded."}]'::jsonb,
  jsonb_build_object('seeded', true, 'phase', '19A'),
  organization_id,
  project_id,
  environment_id,
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
FROM backend_edge_functions
ON CONFLICT (id) DO UPDATE
SET
  status = EXCLUDED.status,
  completed_at = EXCLUDED.completed_at,
  metadata_json = EXCLUDED.metadata_json;

INSERT INTO backend_edge_function_secrets (
  id,
  function_id,
  secret_key,
  secret_prefix,
  value_hash,
  secret_ref,
  scope,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES (
  'fnsecret_global_goodos_runtime',
  NULL,
  'GOODOS_RUNTIME_TOKEN',
  'goodos_runtime_',
  md5('phase-19a-runtime-token'),
  'internal://goodos/runtime-token',
  'project',
  'active',
  '{"seeded":true,"phase":"19A","note":"Placeholder secret reference. Raw value is not stored."}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE
SET
  status = 'active',
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

UPDATE backend_edge_function_runs r
SET
  created_at = COALESCE(r.created_at, r.started_at, NOW()),
  runtime_version = COALESCE(r.runtime_version, f.runtime_version),
  runtime_profile = COALESCE(r.runtime_profile, f.runtime_profile),
  sandbox_mode = COALESCE(r.sandbox_mode, f.sandbox_mode),
  timeout_ms = COALESCE(r.timeout_ms, f.timeout_ms),
  memory_mb = COALESCE(r.memory_mb, f.memory_mb),
  context_json = COALESCE(r.context_json, '{}'::jsonb),
  logs_json = COALESCE(r.logs_json, '[]'::jsonb),
  metrics_json = COALESCE(r.metrics_json, '{}'::jsonb),
  deployment_id = COALESCE(r.deployment_id, f.deployment_id),
  version_id = COALESCE(r.version_id, f.current_version_id),
  code_hash = COALESCE(r.code_hash, f.code_hash),
  invocation_source = COALESCE(r.invocation_source, r.trigger_type),
  organization_id = COALESCE(r.organization_id, f.organization_id, 'org_goodos'),
  project_id = COALESCE(r.project_id, f.project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(r.environment_id, f.environment_id, 'env_goodos_production')
FROM backend_edge_functions f
WHERE f.id = r.function_id;

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
VALUES (
  'pol_functions_v2_runtime_allow',
  'Allow Edge Functions V2 runtime execution',
  'Allows controlled Edge Functions V2 runtime execution for keys with execute:functions.',
  'function',
  '*',
  'execute',
  'allow',
  90,
  '{"requiredScopes":["execute:functions"],"runtimeProfile":"controlled"}'::jsonb,
  'Edge Functions V2 runtime execution allowed by policy.',
  'active',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  '{"phase":"19A","edgeFunctionsV2":true}'::jsonb,
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
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_edge_function_versions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_edge_function_deployments TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_edge_function_secrets TO goodapp_backend_user;

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
  'audit_phase_19a_edge_functions_v2',
  'system',
  'edge.functions.v2.ready',
  'edge_functions',
  'backend_edge_functions',
  '{"phase":"19A","features":["versions","deployments","secrets","runtime-limits","secure-run-logs"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
