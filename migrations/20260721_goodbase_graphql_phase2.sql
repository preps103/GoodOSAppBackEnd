BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pg_graphql'
  ) THEN
    RAISE EXCEPTION 'pg_graphql is not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_graphql'
  ) THEN
    CREATE EXTENSION pg_graphql;
  END IF;
END;
$$;

GRANT USAGE
ON SCHEMA graphql
TO goodos_authenticated;

GRANT EXECUTE
ON FUNCTION graphql.resolve(TEXT, JSONB, TEXT, JSONB)
TO goodos_authenticated;

REVOKE ALL
ON SCHEMA graphql
FROM PUBLIC, goodos_anon;

REVOKE ALL
ON FUNCTION graphql.resolve(TEXT, JSONB, TEXT, JSONB)
FROM PUBLIC, goodos_anon;

CREATE TABLE IF NOT EXISTS backend_graphql_settings (
  id TEXT PRIMARY KEY,
  introspection_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_depth INTEGER NOT NULL DEFAULT 12
    CHECK (max_depth BETWEEN 1 AND 50),
  max_complexity INTEGER NOT NULL DEFAULT 500
    CHECK (max_complexity BETWEEN 1 AND 5000),
  max_aliases INTEGER NOT NULL DEFAULT 50
    CHECK (max_aliases BETWEEN 0 AND 500),
  max_query_bytes INTEGER NOT NULL DEFAULT 102400
    CHECK (max_query_bytes BETWEEN 1024 AND 1048576),
  max_variable_bytes INTEGER NOT NULL DEFAULT 262144
    CHECK (max_variable_bytes BETWEEN 1024 AND 4194304),
  execution_timeout_ms INTEGER NOT NULL DEFAULT 15000
    CHECK (execution_timeout_ms BETWEEN 1000 AND 120000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO backend_graphql_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS backend_graphql_operation_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  query_hash TEXT NOT NULL,
  operation_name TEXT,
  operation_type TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  response_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  complexity INTEGER NOT NULL DEFAULT 0,
  alias_count INTEGER NOT NULL DEFAULT 0,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  introspection BOOLEAN NOT NULL DEFAULT FALSE,
  has_errors BOOLEAN NOT NULL DEFAULT FALSE,
  error_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_graphql_logs_created
ON backend_graphql_operation_logs (created_at DESC);

REVOKE ALL
ON backend_graphql_settings
FROM PUBLIC, goodos_anon, goodos_authenticated;

REVOKE ALL
ON backend_graphql_operation_logs
FROM PUBLIC, goodos_anon, goodos_authenticated;

COMMENT ON SCHEMA goodos_api IS
  E'@graphql({"inflect_names": true, "introspection": false})';

INSERT INTO backend_data_plane_components (
  id,
  component,
  version,
  status,
  endpoint,
  health_status,
  configuration_json,
  metadata_json,
  created_at,
  updated_at
)
VALUES (
  'data_plane_pg_graphql',
  'pg_graphql',
  '1.6.1',
  'active',
  '/graphql/v1',
  'healthy',
  '{
    "schema":"goodos_api",
    "optIn":true,
    "introspection":false,
    "authorization":"postgres_rls"
  }'::jsonb,
  '{
    "purpose":"automatic_graphql",
    "managedBy":"Goodbase"
  }'::jsonb,
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE
SET
  version = EXCLUDED.version,
  status = EXCLUDED.status,
  endpoint = EXCLUDED.endpoint,
  health_status = EXCLUDED.health_status,
  configuration_json = EXCLUDED.configuration_json,
  metadata_json =
    backend_data_plane_components.metadata_json ||
    EXCLUDED.metadata_json,
  updated_at = NOW();

COMMIT;
