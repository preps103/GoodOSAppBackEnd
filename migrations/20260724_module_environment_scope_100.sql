BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM backend_project_environments
    WHERE id = 'env_goodos_production'
      AND project_id = 'proj_goodos_platform'
      AND type = 'production'
  ) THEN
    RAISE EXCEPTION 'Canonical GoodOS production environment is missing';
  END IF;
END
$$;

UPDATE apps
SET
  organization_id = COALESCE(organization_id, 'org_goodos'),
  project_id = COALESCE(project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(environment_id, 'env_goodos_production'),
  updated_at = NOW()
WHERE environment_id IS NULL;

UPDATE backend_edge_function_runs AS runs
SET
  organization_id = COALESCE(runs.organization_id, functions.organization_id, 'org_goodos'),
  project_id = COALESCE(runs.project_id, functions.project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(runs.environment_id, functions.environment_id, 'env_goodos_production')
FROM backend_edge_functions AS functions
WHERE runs.function_id = functions.id
  AND runs.environment_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM apps WHERE environment_id IS NULL) THEN
    RAISE EXCEPTION 'Application environment backfill is incomplete';
  END IF;

  IF EXISTS (SELECT 1 FROM backend_edge_function_runs WHERE environment_id IS NULL) THEN
    RAISE EXCEPTION 'Function-run environment backfill is incomplete';
  END IF;
END
$$;

ALTER TABLE apps
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN environment_id SET NOT NULL;

ALTER TABLE backend_edge_function_runs
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN environment_id SET NOT NULL;

COMMIT;
