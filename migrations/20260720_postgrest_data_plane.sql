BEGIN;

CREATE SCHEMA IF NOT EXISTS goodos_auth;
CREATE SCHEMA IF NOT EXISTS goodos_api;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodos_anon') THEN
    CREATE ROLE goodos_anon NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodos_authenticated') THEN
    CREATE ROLE goodos_authenticated NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.jwt()
RETURNS JSONB
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION goodos_auth.uid()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(goodos_auth.jwt()->>'sub', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.session_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(goodos_auth.jwt()->>'sid', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.platform_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(goodos_auth.jwt()->>'platformRole', '');
$$;

CREATE OR REPLACE FUNCTION goodos_auth.organization_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT membership.organization_id
  FROM backend_organization_memberships AS membership
  WHERE membership.user_id = goodos_auth.uid()
    AND membership.status = 'active'
  ORDER BY
    CASE membership.role
      WHEN 'owner' THEN 1
      WHEN 'admin' THEN 2
      ELSE 3
    END,
    membership.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.check_session()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF goodos_auth.uid() IS NULL THEN
    RETURN;
  END IF;

  IF goodos_auth.uid() IS NULL OR goodos_auth.session_id() IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'A current GoodOS session is required.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM sessions AS session
    JOIN users AS account
      ON account.id = session.user_id
    WHERE session.id = goodos_auth.session_id()
      AND session.user_id = goodos_auth.uid()
      AND session.revoked_at IS NULL
      AND session.expires_at > NOW()
      AND account.status = 'active'
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'The GoodOS session is expired or revoked.';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS backend_data_plane_components (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL UNIQUE,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  endpoint TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_check_at TIMESTAMPTZ,
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A restricted compatibility view proves the data plane without exposing the
-- control-plane schema. New project tables must be explicitly published into
-- goodos_api with security_invoker enabled and RLS on the source table.
ALTER TABLE public_goodos_demo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goodos_demo_items_authenticated
  ON public_goodos_demo_items;

CREATE POLICY goodos_demo_items_authenticated
  ON public_goodos_demo_items
  FOR ALL
  TO goodos_authenticated
  USING (
    organization_id = goodos_auth.organization_id()
  )
  WITH CHECK (
    organization_id = goodos_auth.organization_id()
  );

DROP POLICY IF EXISTS goodos_demo_items_backend_service
  ON public_goodos_demo_items;

CREATE POLICY goodos_demo_items_backend_service
  ON public_goodos_demo_items
  FOR ALL
  TO goodapp_backend_user
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE VIEW goodos_api.demo_items
WITH (security_invoker = true, security_barrier = true)
AS
SELECT
  id,
  title,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_at,
  updated_at
FROM public_goodos_demo_items;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public_goodos_demo_items TO goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON goodos_api.demo_items TO goodos_authenticated;
REVOKE ALL ON goodos_api.demo_items FROM goodos_anon;

INSERT INTO backend_data_plane_components (
  id, component, version, status, endpoint, configuration_json, metadata_json
)
VALUES
  (
    'data_plane_postgrest',
    'postgrest',
    '14.12',
    'provisioning',
    'http://127.0.0.1:8300',
    '{"schema":"goodos_api","jwtRole":"goodos_authenticated","anonymousRole":"goodos_anon"}'::jsonb,
    '{"purpose":"automatic_rest","managedBy":"GoodOS"}'::jsonb
  ),
  (
    'data_plane_pg_graphql',
    'pg_graphql',
    '1.6.1',
    'planned',
    '/graphql/v1',
    '{"schema":"goodos_api","optIn":true}'::jsonb,
    '{"purpose":"automatic_graphql","managedBy":"GoodOS"}'::jsonb
  ),
  (
    'data_plane_realtime',
    'supabase_realtime',
    '2.100.0',
    'planned',
    'http://127.0.0.1:8400',
    '{"transport":"websocket","cdc":"logical_replication","walLevelRequired":"logical"}'::jsonb,
    '{"purpose":"postgres_changes_broadcast_presence","managedBy":"GoodOS"}'::jsonb
  )
ON CONFLICT (id) DO UPDATE
SET
  version = EXCLUDED.version,
  endpoint = EXCLUDED.endpoint,
  configuration_json = EXCLUDED.configuration_json,
  metadata_json = backend_data_plane_components.metadata_json || EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT USAGE ON SCHEMA goodos_api TO goodos_anon, goodos_authenticated;
REVOKE ALL ON SCHEMA goodos_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA goodos_auth TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.jwt() TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.uid() TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.session_id() TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.platform_role() TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.organization_id() TO goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.check_session() TO goodos_anon, goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_data_plane_components TO goodapp_backend_user;

COMMIT;
