BEGIN;

CREATE TABLE IF NOT EXISTS backend_data_plane_publications (
  id TEXT PRIMARY KEY,
  api_schema TEXT NOT NULL DEFAULT 'goodos_api',
  api_name TEXT NOT NULL,
  source_schema TEXT NOT NULL,
  source_name TEXT NOT NULL,
  columns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  operations_json JSONB NOT NULL DEFAULT '["SELECT"]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  unpublished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT backend_data_plane_publications_name_unique
    UNIQUE (api_schema, api_name),
  CONSTRAINT backend_data_plane_publications_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT backend_data_plane_publications_columns_check
    CHECK (
      jsonb_typeof(columns_json) = 'array'
      AND jsonb_array_length(columns_json) BETWEEN 1 AND 100
    ),
  CONSTRAINT backend_data_plane_publications_operations_check
    CHECK (
      jsonb_typeof(operations_json) = 'array'
      AND jsonb_array_length(operations_json) BETWEEN 1 AND 4
    )
);

CREATE INDEX IF NOT EXISTS
  idx_backend_data_plane_publications_status
ON backend_data_plane_publications (
  status,
  api_schema,
  api_name
);

CREATE TABLE IF NOT EXISTS backend_data_plane_request_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  resource_path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  request_bytes BIGINT NOT NULL DEFAULT 0,
  response_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT backend_data_plane_request_logs_method_check
    CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS')),
  CONSTRAINT backend_data_plane_request_logs_status_check
    CHECK (response_status BETWEEN 100 AND 599),
  CONSTRAINT backend_data_plane_request_logs_duration_check
    CHECK (duration_ms >= 0),
  CONSTRAINT backend_data_plane_request_logs_size_check
    CHECK (request_bytes >= 0 AND response_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS
  idx_backend_data_plane_request_logs_created
ON backend_data_plane_request_logs (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_backend_data_plane_request_logs_user
ON backend_data_plane_request_logs (
  user_id,
  created_at DESC
)
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_backend_data_plane_request_logs_resource
ON backend_data_plane_request_logs (
  resource_path,
  created_at DESC
);

INSERT INTO backend_data_plane_publications (
  id,
  api_schema,
  api_name,
  source_schema,
  source_name,
  columns_json,
  operations_json,
  status,
  published_at,
  created_at,
  updated_at
)
VALUES (
  'dppub_demo_items',
  'goodos_api',
  'demo_items',
  'public',
  'public_goodos_demo_items',
  '[
    "id",
    "title",
    "status",
    "metadata_json",
    "organization_id",
    "project_id",
    "environment_id",
    "created_at",
    "updated_at"
  ]'::jsonb,
  '["SELECT","INSERT","UPDATE","DELETE"]'::jsonb,
  'active',
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT (api_schema, api_name)
DO UPDATE SET
  source_schema = EXCLUDED.source_schema,
  source_name = EXCLUDED.source_name,
  columns_json = EXCLUDED.columns_json,
  operations_json = EXCLUDED.operations_json,
  status = 'active',
  published_at = COALESCE(
    backend_data_plane_publications.published_at,
    EXCLUDED.published_at
  ),
  unpublished_at = NULL,
  updated_at = NOW();

UPDATE backend_data_plane_components
SET
  metadata_json =
    COALESCE(metadata_json, '{}'::jsonb) ||
    jsonb_build_object(
      'brand', 'Goodbase',
      'publicBaseUrl', 'https://base.goodos.app',
      'publicRestEndpoint', 'https://base.goodos.app/rest/v1',
      'phase', 1,
      'productionControls', jsonb_build_array(
        'readiness',
        'publication_registry',
        'schema_cache_reload',
        'request_limits',
        'request_ledger'
      )
    ),
  updated_at = NOW()
WHERE component = 'postgrest';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backend_data_plane_publications
  TO goodapp_backend_user;

GRANT SELECT, INSERT
  ON backend_data_plane_request_logs
  TO goodapp_backend_user;

NOTIFY pgrst, 'reload schema';

COMMIT;
