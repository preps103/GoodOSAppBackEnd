BEGIN;

-- Phase 3: make JWT tenant context authoritative without trusting raw claims.
-- Every helper validates the claimed scope against active control-plane rows.
CREATE OR REPLACE FUNCTION goodos_auth.claim_text(claim_name TEXT)
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(BTRIM(goodos_auth.jwt()->>claim_name), '');
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
  JOIN backend_organizations AS organization
    ON organization.id = membership.organization_id
  WHERE membership.user_id = goodos_auth.uid()
    AND membership.status = 'active'
    AND organization.status = 'active'
    AND (
      goodos_auth.claim_text('organizationId') IS NULL
      OR membership.organization_id = goodos_auth.claim_text('organizationId')
    )
  ORDER BY
    CASE membership.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
    membership.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.project_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT project.id
  FROM backend_projects AS project
  JOIN backend_project_memberships AS membership
    ON membership.project_id = project.id
  WHERE membership.user_id = goodos_auth.uid()
    AND membership.status = 'active'
    AND project.status = 'active'
    AND project.organization_id = goodos_auth.organization_id()
    AND (
      goodos_auth.claim_text('projectId') IS NULL
      OR project.id = goodos_auth.claim_text('projectId')
    )
  ORDER BY membership.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.environment_id()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT environment.id
  FROM backend_project_environments AS environment
  WHERE environment.project_id = goodos_auth.project_id()
    AND environment.status = 'active'
    AND (
      goodos_auth.claim_text('environmentId') IS NULL
      OR environment.id = goodos_auth.claim_text('environmentId')
    )
  ORDER BY
    CASE environment.type WHEN 'production' THEN 1 WHEN 'staging' THEN 2 ELSE 3 END,
    environment.created_at ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION goodos_auth.is_tenant_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM backend_organization_memberships AS membership
    WHERE membership.user_id = goodos_auth.uid()
      AND membership.organization_id = goodos_auth.organization_id()
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  );
$$;

CREATE TABLE IF NOT EXISTS backend_rls_policy_registry (
  id TEXT PRIMARY KEY,
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  template TEXT NOT NULL,
  operations_json JSONB NOT NULL DEFAULT '["SELECT"]'::jsonb,
  organization_column TEXT,
  project_column TEXT,
  environment_column TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_schema, source_table, policy_name),
  CHECK (template IN ('tenant', 'tenant_admin', 'public_read', 'service')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS backend_rls_audit_runs (
  id TEXT PRIMARY KEY,
  exposed_relations INTEGER NOT NULL DEFAULT 0,
  missing_rls INTEGER NOT NULL DEFAULT 0,
  unsafe_views INTEGER NOT NULL DEFAULT 0,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public_goodos_demo_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goodos_demo_items_authenticated ON public_goodos_demo_items;
CREATE POLICY goodos_demo_items_authenticated
  ON public_goodos_demo_items
  FOR ALL
  TO goodos_authenticated
  USING (
    organization_id = goodos_auth.organization_id()
    AND (project_id IS NULL OR project_id = goodos_auth.project_id())
    AND (environment_id IS NULL OR environment_id = goodos_auth.environment_id())
  )
  WITH CHECK (
    organization_id = goodos_auth.organization_id()
    AND (project_id IS NULL OR project_id = goodos_auth.project_id())
    AND (environment_id IS NULL OR environment_id = goodos_auth.environment_id())
  );

INSERT INTO backend_rls_policy_registry (
  id, source_schema, source_table, policy_name, template,
  operations_json, organization_column, project_column,
  environment_column, status, metadata_json
)
VALUES (
  'rlspol_demo_items_tenant', 'public', 'public_goodos_demo_items',
  'goodos_demo_items_authenticated', 'tenant',
  '["SELECT","INSERT","UPDATE","DELETE"]'::jsonb,
  'organization_id', 'project_id', 'environment_id', 'active',
  '{"phase":3,"managedBy":"Goodbase"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  operations_json = EXCLUDED.operations_json,
  status = 'active',
  metadata_json = backend_rls_policy_registry.metadata_json || EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT EXECUTE ON FUNCTION goodos_auth.claim_text(TEXT) TO goodos_anon, goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.project_id() TO goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.environment_id() TO goodos_authenticated;
GRANT EXECUTE ON FUNCTION goodos_auth.is_tenant_admin() TO goodos_authenticated;
REVOKE ALL ON backend_rls_policy_registry, backend_rls_audit_runs
  FROM PUBLIC, goodos_anon, goodos_authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_rls_policy_registry TO goodapp_backend_user;
GRANT SELECT, INSERT ON backend_rls_audit_runs TO goodapp_backend_user;

COMMIT;
