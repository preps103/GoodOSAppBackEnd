BEGIN;

CREATE TABLE IF NOT EXISTS backend_deployment_sites (
  id TEXT PRIMARY KEY,
  app_id TEXT,
  name TEXT NOT NULL,
  domain TEXT,
  repository_url TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  app_path TEXT,
  process_manager TEXT NOT NULL DEFAULT 'pm2',
  process_name TEXT,
  health_url TEXT,
  status TEXT NOT NULL DEFAULT 'setup_required',
  auto_rollback BOOLEAN NOT NULL DEFAULT true,
  install_dependencies BOOLEAN NOT NULL DEFAULT true,
  run_build BOOLEAN NOT NULL DEFAULT true,
  last_deployed_commit TEXT,
  last_deployed_at TIMESTAMPTZ,
  last_run_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_deployment_sites_app
ON backend_deployment_sites(app_id)
WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_backend_deployment_sites_status
ON backend_deployment_sites(status);

CREATE INDEX IF NOT EXISTS idx_backend_deployment_sites_project_env
ON backend_deployment_sites(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_deployment_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES backend_deployment_sites(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  requested_by UUID,
  previous_commit TEXT,
  target_commit TEXT,
  deployed_commit TEXT,
  rollback_commit TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_deployment_runs_site_created
ON backend_deployment_runs(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_deployment_runs_status
ON backend_deployment_runs(status);

CREATE TABLE IF NOT EXISTS backend_deployment_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backend_deployment_runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  step TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_deployment_events_run_created
ON backend_deployment_events(run_id, created_at ASC);

INSERT INTO backend_deployment_sites (
  id,
  app_id,
  name,
  domain,
  branch,
  process_manager,
  status,
  auto_rollback,
  organization_id,
  project_id,
  environment_id,
  created_by,
  metadata_json
)
SELECT
  'deploysite_' || md5(app.id),
  app.id,
  app.name,
  app.domain,
  'main',
  'pm2',
  'setup_required',
  true,
  COALESCE(app.organization_id, 'org_goodos'),
  COALESCE(app.project_id, 'proj_goodos_platform'),
  COALESCE(app.environment_id, 'env_goodos_production'),
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  jsonb_build_object('seededFromApps', true, 'phase', 19)
FROM apps app
ON CONFLICT (app_id) WHERE app_id IS NOT NULL DO UPDATE
SET
  name = EXCLUDED.name,
  domain = COALESCE(backend_deployment_sites.domain, EXCLUDED.domain),
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_deployment_sites TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_deployment_runs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_deployment_events TO goodapp_backend_user;

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
  'audit_phase_19_update_sites',
  'system',
  'deployment.update_sites.ready',
  'deployment_center',
  'backend_deployment_sites',
  '{"phase":19,"features":["saved-sites","github-update","build","restart","health-check","automatic-rollback","live-logs"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
