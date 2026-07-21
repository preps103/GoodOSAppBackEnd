BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodbase_realtime') THEN
    CREATE ROLE goodbase_realtime LOGIN REPLICATION NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE goodbase_realtime WITH LOGIN REPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS backend_realtime_publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES backend_projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES backend_project_environments(id) ON DELETE CASCADE,
  publication_name TEXT NOT NULL UNIQUE,
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  operations_json JSONB NOT NULL DEFAULT '["INSERT","UPDATE","DELETE"]'::jsonb,
  row_filter TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  max_payload_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (max_payload_bytes BETWEEN 1024 AND 10485760),
  events_per_second INTEGER NOT NULL DEFAULT 100 CHECK (events_per_second BETWEEN 1 AND 10000),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, environment_id, source_schema, source_table)
);

CREATE TABLE IF NOT EXISTS backend_realtime_replication_health (
  id TEXT PRIMARY KEY,
  publication_name TEXT NOT NULL,
  slot_name TEXT,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  retained_wal_bytes BIGINT NOT NULL DEFAULT 0,
  lag_bytes BIGINT NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'goodbase_goodos_production') THEN
    CREATE PUBLICATION goodbase_goodos_production
      FOR TABLE public.public_goodos_demo_items
      WITH (publish = 'insert, update, delete, truncate');
  END IF;
END;
$$;

INSERT INTO backend_realtime_publications (
  id, project_id, environment_id, publication_name, source_schema,
  source_table, operations_json, status, metadata_json
)
VALUES (
  'rtpub_goodos_demo_items', 'proj_goodos_platform', 'env_goodos_production',
  'goodbase_goodos_production', 'public', 'public_goodos_demo_items',
  '["INSERT","UPDATE","DELETE"]'::jsonb, 'active',
  '{"phase":5,"delivery":"at-most-once; clients must tolerate duplicates and reconnect","managedBy":"Goodbase"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  operations_json = EXCLUDED.operations_json,
  status = 'active',
  metadata_json = backend_realtime_publications.metadata_json || EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT CONNECT ON DATABASE goodos_backend TO goodbase_realtime;
GRANT CREATE ON DATABASE goodos_backend TO goodbase_realtime;
CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION goodbase_realtime;
GRANT ALL ON SCHEMA _realtime TO goodbase_realtime;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION goodbase_realtime;
GRANT ALL ON SCHEMA realtime TO goodbase_realtime;
GRANT USAGE ON SCHEMA public TO goodbase_realtime;
GRANT SELECT ON public_goodos_demo_items TO goodbase_realtime;
REVOKE ALL ON backend_realtime_publications, backend_realtime_replication_health
  FROM PUBLIC, goodos_anon, goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_publications TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_replication_health TO goodapp_backend_user;

UPDATE backend_data_plane_components
SET
  status = 'provisioning',
  endpoint = 'https://base.goodos.app/realtime/v1',
  configuration_json = configuration_json || '{
    "publication":"goodbase_goodos_production",
    "optIn":true,
    "operations":["INSERT","UPDATE","DELETE"],
    "privateChannels":true,
    "walProtection":true
  }'::jsonb,
  metadata_json = metadata_json || '{"phase":5,"managedBy":"Goodbase"}'::jsonb,
  updated_at = NOW()
WHERE component = 'supabase_realtime';

COMMIT;
