BEGIN;

CREATE TABLE IF NOT EXISTS backend_table_api_rules (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  api_slug TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  read_enabled BOOLEAN NOT NULL DEFAULT false,
  write_enabled BOOLEAN NOT NULL DEFAULT false,
  insert_enabled BOOLEAN NOT NULL DEFAULT false,
  update_enabled BOOLEAN NOT NULL DEFAULT false,
  delete_enabled BOOLEAN NOT NULL DEFAULT false,
  exposed_columns TEXT[],
  searchable_columns TEXT[],
  allowed_api_key_scopes TEXT[] NOT NULL DEFAULT ARRAY['read:db'],
  allowed_app_ids TEXT[] NOT NULL DEFAULT ARRAY['*'],
  max_rows INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_table_api_rules_table_name
ON backend_table_api_rules(table_name);

CREATE INDEX IF NOT EXISTS idx_backend_table_api_rules_api_slug
ON backend_table_api_rules(api_slug);

CREATE INDEX IF NOT EXISTS idx_backend_table_api_rules_status
ON backend_table_api_rules(status);

CREATE INDEX IF NOT EXISTS idx_backend_table_api_rules_project_env
ON backend_table_api_rules(project_id, environment_id);

CREATE TABLE IF NOT EXISTS public_goodos_demo_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB,
  organization_id TEXT DEFAULT 'org_goodos',
  project_id TEXT DEFAULT 'proj_goodos_platform',
  environment_id TEXT DEFAULT 'env_goodos_production',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public_goodos_demo_items (
  id,
  title,
  status,
  metadata_json
)
VALUES (
  'demo_item_welcome',
  'Welcome to the GoodOS generated Database API',
  'active',
  '{"seeded": true, "source": "phase_16a"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET
  title = EXCLUDED.title,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_table_api_rules (
  id,
  table_name,
  api_slug,
  display_name,
  description,
  read_enabled,
  write_enabled,
  insert_enabled,
  update_enabled,
  delete_enabled,
  exposed_columns,
  searchable_columns,
  allowed_api_key_scopes,
  allowed_app_ids,
  max_rows,
  status,
  organization_id,
  project_id,
  environment_id,
  metadata_json
)
VALUES
  (
    'tblapi_apps_read',
    'apps',
    'apps',
    'Apps',
    'Read-only public API for registered GoodOS apps.',
    true,
    false,
    false,
    false,
    false,
    ARRAY['id','name','domain','status','description','created_at','updated_at'],
    ARRAY['id','name','domain','status','description'],
    ARRAY['read:db'],
    ARRAY['*'],
    100,
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded": true, "safeDefault": true}'::jsonb
  ),
  (
    'tblapi_project_envs_read',
    'backend_project_environments',
    'project-environments',
    'Project Environments',
    'Read-only public API for GoodOS project environments.',
    true,
    false,
    false,
    false,
    false,
    ARRAY['id','project_id','name','slug','type','status','api_base_url','created_at','updated_at'],
    ARRAY['id','name','slug','type','status'],
    ARRAY['read:db'],
    ARRAY['*'],
    100,
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded": true, "safeDefault": true}'::jsonb
  ),
  (
    'tblapi_edge_functions_read',
    'backend_edge_functions',
    'edge-functions',
    'Edge Functions',
    'Read-only public API for active GoodOS Edge Function records.',
    true,
    false,
    false,
    false,
    false,
    ARRAY['id','name','type','runtime','trigger_type','route_path','status','run_count','last_status','last_run_at','created_at','updated_at'],
    ARRAY['id','name','type','runtime','trigger_type','route_path','status'],
    ARRAY['read:db'],
    ARRAY['*'],
    100,
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded": true, "safeDefault": true}'::jsonb
  ),
  (
    'tblapi_demo_items_rw',
    'public_goodos_demo_items',
    'demo-items',
    'Demo Items',
    'Safe demo table for generated Database API read and write testing.',
    true,
    true,
    true,
    true,
    true,
    ARRAY['id','title','status','metadata_json','created_at','updated_at'],
    ARRAY['id','title','status'],
    ARRAY['read:db','write:db'],
    ARRAY['*'],
    100,
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"seeded": true, "safeWriteDemo": true}'::jsonb
  )
ON CONFLICT (id) DO UPDATE
SET
  table_name = EXCLUDED.table_name,
  api_slug = EXCLUDED.api_slug,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  read_enabled = EXCLUDED.read_enabled,
  write_enabled = EXCLUDED.write_enabled,
  insert_enabled = EXCLUDED.insert_enabled,
  update_enabled = EXCLUDED.update_enabled,
  delete_enabled = EXCLUDED.delete_enabled,
  exposed_columns = EXCLUDED.exposed_columns,
  searchable_columns = EXCLUDED.searchable_columns,
  allowed_api_key_scopes = EXCLUDED.allowed_api_key_scopes,
  allowed_app_ids = EXCLUDED.allowed_app_ids,
  max_rows = EXCLUDED.max_rows,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_table_api_rules TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON public_goodos_demo_items TO goodapp_backend_user;
GRANT SELECT ON backend_project_environments TO goodapp_backend_user;

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
  'audit_phase_16a_database_api_generator',
  'system',
  'database.api.generator.ready',
  'database_api',
  'backend_table_api_rules',
  '{"phase":"16A","publishedTables":["apps","project-environments","edge-functions","demo-items"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
