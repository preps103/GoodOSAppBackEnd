BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodbase_pool_transaction') THEN
    CREATE ROLE goodbase_pool_transaction LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodbase_pool_session') THEN
    CREATE ROLE goodbase_pool_session LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodbase_migrator') THEN
    CREATE ROLE goodbase_migrator NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE goodos_backend TO goodbase_pool_transaction, goodbase_pool_session;
GRANT goodos_anon, goodos_authenticated TO goodbase_pool_transaction, goodbase_pool_session;

CREATE TABLE IF NOT EXISTS backend_connection_budgets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES backend_projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES backend_project_environments(id) ON DELETE CASCADE,
  transaction_pool_size INTEGER NOT NULL DEFAULT 20 CHECK (transaction_pool_size BETWEEN 1 AND 500),
  session_pool_size INTEGER NOT NULL DEFAULT 10 CHECK (session_pool_size BETWEEN 1 AND 500),
  max_client_connections INTEGER NOT NULL DEFAULT 200 CHECK (max_client_connections BETWEEN 10 AND 10000),
  reserve_pool_size INTEGER NOT NULL DEFAULT 5 CHECK (reserve_pool_size BETWEEN 0 AND 100),
  query_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (query_timeout_seconds BETWEEN 1 AND 3600),
  idle_transaction_timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (idle_transaction_timeout_seconds BETWEEN 1 AND 3600),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, environment_id)
);

INSERT INTO backend_connection_budgets (
  id, project_id, environment_id, transaction_pool_size,
  session_pool_size, max_client_connections, reserve_pool_size,
  metadata_json
)
VALUES (
  'poolbudget_goodos_production', 'proj_goodos_platform', 'env_goodos_production',
  20, 10, 200, 5,
  '{"phase":4,"managedBy":"Goodbase"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  metadata_json = backend_connection_budgets.metadata_json || EXCLUDED.metadata_json,
  updated_at = NOW();

REVOKE ALL ON backend_connection_budgets FROM PUBLIC, goodos_anon, goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_connection_budgets TO goodapp_backend_user;

INSERT INTO backend_data_plane_components (
  id, component, version, status, endpoint, health_status,
  configuration_json, metadata_json
)
VALUES
  ('data_plane_pgbouncer_transaction', 'pgbouncer_transaction', '1.25.2', 'provisioning',
   'postgresql://base.goodos.app:6543/goodos_backend', 'unknown',
   '{"poolMode":"transaction","tlsRequired":true,"preparedStatements":true}'::jsonb,
   '{"phase":4,"managedBy":"Goodbase"}'::jsonb),
  ('data_plane_pgbouncer_session', 'pgbouncer_session', '1.25.2', 'provisioning',
   'postgresql://base.goodos.app:5433/goodos_backend', 'unknown',
   '{"poolMode":"session","tlsRequired":true}'::jsonb,
   '{"phase":4,"managedBy":"Goodbase"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  endpoint = EXCLUDED.endpoint,
  configuration_json = EXCLUDED.configuration_json,
  metadata_json = backend_data_plane_components.metadata_json || EXCLUDED.metadata_json,
  updated_at = NOW();

COMMIT;
