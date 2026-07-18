BEGIN;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS access_key_ref TEXT;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS secret_key_ref TEXT;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS session_token_ref TEXT;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS last_health_error TEXT;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS default_cache_control TEXT NOT NULL DEFAULT 'private, max-age=0';

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS signed_url_ttl_seconds INTEGER NOT NULL DEFAULT 900;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS max_upload_bytes BIGINT NOT NULL DEFAULT 104857600;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE backend_storage_provider_configs
ADD COLUMN IF NOT EXISTS capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE backend_storage_buckets
ADD COLUMN IF NOT EXISTS version_retention_count INTEGER NOT NULL DEFAULT 25;

ALTER TABLE backend_storage_buckets
ADD COLUMN IF NOT EXISTS soft_delete_retention_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE backend_storage_buckets
ADD COLUMN IF NOT EXISTS require_checksum BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE backend_storage_buckets
ADD COLUMN IF NOT EXISTS public_listing_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE backend_storage_files
ADD COLUMN IF NOT EXISTS provider_version_id TEXT;

ALTER TABLE backend_storage_files
ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

ALTER TABLE backend_storage_files
ADD COLUMN IF NOT EXISTS access_count BIGINT NOT NULL DEFAULT 0;

ALTER TABLE backend_storage_files
ADD COLUMN IF NOT EXISTS deleted_marker BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS provider_version_id TEXT;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS content_type TEXT;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS content_encoding TEXT;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS content_disposition TEXT;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS cache_control TEXT;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS storage_class TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS provider_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS is_delete_marker BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE backend_storage_object_versions
ADD COLUMN IF NOT EXISTS restored_from_version_id TEXT;

CREATE TABLE IF NOT EXISTS backend_storage_access_logs (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    organization_id TEXT,
    project_id TEXT,
    environment_id TEXT,
    api_key_id TEXT,
    actor_type TEXT NOT NULL DEFAULT 'api_key',
    actor_id TEXT,
    operation TEXT NOT NULL,
    bucket_id TEXT,
    bucket_name TEXT,
    file_id TEXT,
    object_key TEXT,
    provider TEXT NOT NULL DEFAULT 'local',
    status_code INTEGER,
    bytes_transferred BIGINT NOT NULL DEFAULT 0,
    source_ip TEXT,
    user_agent TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_storage_access_logs_org_time
ON backend_storage_access_logs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_storage_access_logs_file_time
ON backend_storage_access_logs (file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_storage_access_logs_key_time
ON backend_storage_access_logs (api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_storage_lifecycle_runs (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    project_id TEXT,
    environment_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    scanned_buckets INTEGER NOT NULL DEFAULT 0,
    scanned_files INTEGER NOT NULL DEFAULT 0,
    expired_signed_urls INTEGER NOT NULL DEFAULT 0,
    purged_files INTEGER NOT NULL DEFAULT 0,
    purged_versions INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_backend_storage_lifecycle_runs_org_time
ON backend_storage_lifecycle_runs (organization_id, started_at DESC);

INSERT INTO backend_storage_provider_configs (
    id,
    name,
    provider,
    status,
    endpoint_url,
    region,
    bucket_name,
    cdn_base_url,
    path_style,
    force_ssl,
    health_status,
    default_cache_control,
    signed_url_ttl_seconds,
    max_upload_bytes,
    read_only,
    capabilities_json,
    metadata_json,
    organization_id,
    project_id,
    environment_id,
    created_by
)
VALUES (
    'storage_provider_local_goodos',
    'GoodOS Local Storage Provider',
    'local',
    'active',
    'file:///var/www/GoodAppBackEnd/storage/buckets',
    'local',
    'storage/buckets',
    'https://backend.goodos.app/storage/v2/public',
    TRUE,
    TRUE,
    'healthy',
    'private, max-age=0',
    900,
    104857600,
    FALSE,
    '{"read":true,"write":true,"delete":true,"versions":true,"signedUrls":true,"cdn":true}'::jsonb,
    '{"phase":18,"provider":"local"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1)
)
ON CONFLICT (id)
DO UPDATE SET
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    status = EXCLUDED.status,
    endpoint_url = EXCLUDED.endpoint_url,
    region = EXCLUDED.region,
    bucket_name = EXCLUDED.bucket_name,
    cdn_base_url = EXCLUDED.cdn_base_url,
    health_status = 'healthy',
    default_cache_control = EXCLUDED.default_cache_control,
    signed_url_ttl_seconds = EXCLUDED.signed_url_ttl_seconds,
    max_upload_bytes = EXCLUDED.max_upload_bytes,
    read_only = FALSE,
    capabilities_json = EXCLUDED.capabilities_json,
    metadata_json = COALESCE(backend_storage_provider_configs.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
    updated_at = NOW();

UPDATE backend_storage_provider_configs
SET
    access_key_ref = COALESCE(
      access_key_ref,
      NULLIF(metadata_json->>'accessKeyRef', '')
    ),
    secret_key_ref = COALESCE(
      secret_key_ref,
      NULLIF(secret_ref, ''),
      NULLIF(metadata_json->>'secretKeyRef', '')
    ),
    health_status = CASE
      WHEN provider = 'local' THEN 'healthy'
      ELSE COALESCE(NULLIF(health_status, ''), 'unknown')
    END,
    default_cache_control = COALESCE(NULLIF(default_cache_control, ''), 'private, max-age=0'),
    capabilities_json = COALESCE(capabilities_json, '{}'::jsonb) ||
      CASE
        WHEN provider = 'local' THEN
          '{"read":true,"write":true,"delete":true,"versions":true,"signedUrls":true,"cdn":true}'::jsonb
        ELSE
          '{"read":true,"write":true,"delete":true,"versions":true,"signedUrls":true,"s3Compatible":true}'::jsonb
      END,
    updated_at = NOW();

UPDATE backend_storage_buckets
SET
    version_retention_count = GREATEST(COALESCE(version_retention_count, 25), 1),
    soft_delete_retention_days = GREATEST(COALESCE(soft_delete_retention_days, 30), 1),
    require_checksum = COALESCE(require_checksum, TRUE),
    public_listing_enabled = COALESCE(public_listing_enabled, FALSE),
    updated_at = NOW();

INSERT INTO backend_policy_rules (
    id,
    name,
    description,
    rule_set_id,
    target_type,
    target_id,
    operation,
    effect,
    priority,
    condition_json,
    message,
    status,
    match_mode,
    rollout_percentage,
    version,
    starts_at,
    published_by,
    published_at,
    organization_id,
    project_id,
    environment_id,
    metadata_json,
    created_by
)
VALUES
  (
    'pol_phase18_storage_gateway_access',
    'Allow scoped Storage V2 gateway access',
    'Allows API Gateway V2 storage requests for keys with read:storage or write:storage.',
    'ruleset_phase17_gateway_v2',
    'api_gateway',
    '/api/v2/storage*',
    '*',
    'allow',
    90,
    '{"anyScopes":["read:storage","write:storage"]}'::jsonb,
    'Storage V2 API access allowed by central policy.',
    'active',
    'all',
    100,
    1,
    NOW(),
    (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
    NOW(),
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":18,"storageControlPlane":true}'::jsonb,
    (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1)
  ),
  (
    'pol_phase18_storage_public_read',
    'Allow explicit public bucket reads',
    'Allows the public CDN route only when the resolved bucket is explicitly public.',
    'ruleset_phase17_gateway_v2',
    'storage',
    'public',
    'GET',
    'allow',
    90,
    '{"attributes":{"publicRead":true}}'::jsonb,
    'Public storage object read allowed.',
    'active',
    'all',
    100,
    1,
    NOW(),
    (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1),
    NOW(),
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":18,"storageControlPlane":true}'::jsonb,
    (SELECT id FROM users WHERE platform_role = 'owner' ORDER BY created_at LIMIT 1)
  )
ON CONFLICT (id)
DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    rule_set_id = EXCLUDED.rule_set_id,
    target_type = EXCLUDED.target_type,
    target_id = EXCLUDED.target_id,
    operation = EXCLUDED.operation,
    effect = EXCLUDED.effect,
    priority = EXCLUDED.priority,
    condition_json = EXCLUDED.condition_json,
    message = EXCLUDED.message,
    status = EXCLUDED.status,
    match_mode = EXCLUDED.match_mode,
    rollout_percentage = EXCLUDED.rollout_percentage,
    metadata_json = EXCLUDED.metadata_json,
    published_at = NOW(),
    updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_access_logs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_lifecycle_runs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_provider_configs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_object_versions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_files TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_signed_urls TO goodapp_backend_user;

COMMIT;
