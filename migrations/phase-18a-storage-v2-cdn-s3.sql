BEGIN;

ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider_config_id TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider_bucket_name TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider_region TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider_endpoint TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS provider_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS cdn_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS cdn_base_url TEXT;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS cache_control TEXT NOT NULL DEFAULT 'private, max-age=0';
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS object_lock_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS lifecycle_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS cors_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS storage_class TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS checksum_algorithm TEXT NOT NULL DEFAULT 'sha256';
ALTER TABLE backend_storage_buckets ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS object_key TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider_bucket_name TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider_region TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider_endpoint TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider_etag TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS version_id TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS parent_file_id TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS is_latest_version BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS checksum_md5 TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS checksum_algorithm TEXT NOT NULL DEFAULT 'sha256';
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS public_url TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS cdn_url TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS content_disposition TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS content_encoding TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS cache_control TEXT;
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS storage_class TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE backend_storage_files ADD COLUMN IF NOT EXISTS provider_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS token_prefix TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'download';
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS allowed_ip TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS user_agent_limit TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'GET';
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS public_url TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS cdn_url TEXT;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE backend_storage_signed_urls ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS backend_storage_provider_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'active',
  endpoint_url TEXT,
  region TEXT,
  bucket_name TEXT,
  access_key_prefix TEXT,
  secret_ref TEXT,
  cdn_base_url TEXT,
  path_style BOOLEAN NOT NULL DEFAULT true,
  force_ssl BOOLEAN NOT NULL DEFAULT true,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_storage_provider_configs_provider
ON backend_storage_provider_configs(provider);

CREATE INDEX IF NOT EXISTS idx_backend_storage_provider_configs_status
ON backend_storage_provider_configs(status);

CREATE INDEX IF NOT EXISTS idx_backend_storage_provider_configs_project_env
ON backend_storage_provider_configs(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_storage_object_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  bucket_id TEXT,
  object_key TEXT,
  version_id TEXT,
  version_number INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'local',
  size_bytes BIGINT,
  checksum_sha256 TEXT,
  checksum_md5 TEXT,
  storage_path TEXT,
  public_url TEXT,
  cdn_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_storage_object_versions_file
ON backend_storage_object_versions(file_id);

CREATE INDEX IF NOT EXISTS idx_backend_storage_object_versions_bucket
ON backend_storage_object_versions(bucket_id);

CREATE INDEX IF NOT EXISTS idx_backend_storage_object_versions_project_env
ON backend_storage_object_versions(project_id, environment_id);

INSERT INTO backend_storage_provider_configs (
  id,
  name,
  provider,
  status,
  endpoint_url,
  region,
  bucket_name,
  cdn_base_url,
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
  'https://backend.goodos.app/storage/public',
  '{"phase":"18A","supports":["local","cdn-url-mapping","future-s3-compatible"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  provider = EXCLUDED.provider,
  status = EXCLUDED.status,
  endpoint_url = EXCLUDED.endpoint_url,
  region = EXCLUDED.region,
  bucket_name = EXCLUDED.bucket_name,
  cdn_base_url = EXCLUDED.cdn_base_url,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

UPDATE backend_storage_buckets
SET
  provider = COALESCE(provider, 'local'),
  provider_config_id = COALESCE(provider_config_id, 'storage_provider_local_goodos'),
  provider_bucket_name = COALESCE(provider_bucket_name, name),
  provider_region = COALESCE(provider_region, 'local'),
  provider_endpoint = COALESCE(provider_endpoint, 'file:///var/www/GoodAppBackEnd/storage/buckets'),
  provider_prefix = COALESCE(provider_prefix, ''),
  cache_control = COALESCE(cache_control, CASE WHEN visibility = 'public' OR public_read_enabled = true THEN 'public, max-age=3600' ELSE 'private, max-age=0' END),
  checksum_algorithm = COALESCE(checksum_algorithm, 'sha256'),
  metadata_json = COALESCE(metadata_json, '{}'::jsonb),
  updated_at = NOW()
WHERE provider_config_id IS NULL
   OR provider_bucket_name IS NULL
   OR provider_endpoint IS NULL
   OR metadata_json IS NULL;

UPDATE backend_storage_files f
SET
  object_key = COALESCE(NULLIF(f.object_key, ''), NULLIF(f.folder_path, '') || CASE WHEN NULLIF(f.folder_path, '') IS NULL THEN '' ELSE '/' END || f.filename, f.filename),
  provider = COALESCE(f.provider, 'local'),
  provider_bucket_name = COALESCE(f.provider_bucket_name, b.name),
  provider_region = COALESCE(f.provider_region, 'local'),
  provider_endpoint = COALESCE(f.provider_endpoint, 'file:///var/www/GoodAppBackEnd/storage/buckets'),
  version_id = COALESCE(f.version_id, 'v1'),
  version_number = COALESCE(f.version_number, 1),
  is_latest_version = COALESCE(f.is_latest_version, true),
  checksum_algorithm = COALESCE(f.checksum_algorithm, 'sha256'),
  cache_control = COALESCE(f.cache_control, b.cache_control),
  storage_class = COALESCE(f.storage_class, 'standard'),
  public_url = CASE
    WHEN b.public_read_enabled = true OR b.visibility = 'public'
      THEN 'https://backend.goodos.app/storage/public/' || b.name || '/' || COALESCE(NULLIF(f.object_key, ''), f.filename)
    ELSE f.public_url
  END,
  cdn_url = CASE
    WHEN b.cdn_enabled = true AND b.cdn_base_url IS NOT NULL
      THEN rtrim(b.cdn_base_url, '/') || '/' || COALESCE(NULLIF(f.object_key, ''), f.filename)
    ELSE f.cdn_url
  END,
  provider_metadata_json = COALESCE(f.provider_metadata_json, '{}'::jsonb),
  updated_at = NOW()
FROM backend_storage_buckets b
WHERE b.id = f.bucket_id;

INSERT INTO backend_storage_buckets (
  id,
  name,
  visibility,
  status,
  created_by,
  max_file_size_bytes,
  allowed_mime_types,
  allowed_extensions,
  public_read_enabled,
  signed_url_ttl_seconds,
  file_versioning_enabled,
  virus_scan_required,
  encryption_mode,
  provider,
  provider_config_id,
  provider_bucket_name,
  provider_region,
  provider_endpoint,
  cdn_enabled,
  cdn_base_url,
  cache_control,
  object_lock_enabled,
  lifecycle_json,
  cors_json,
  storage_class,
  checksum_algorithm,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'bucket_storage_v2_public_test',
  'storage-v2-public',
  'public',
  'active',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  10485760,
  ARRAY['text/plain'],
  ARRAY['.txt'],
  true,
  3600,
  true,
  false,
  'local',
  'local',
  'storage_provider_local_goodos',
  'storage-v2-public',
  'local',
  'file:///var/www/GoodAppBackEnd/storage/buckets',
  true,
  'https://backend.goodos.app/storage/public/storage-v2-public',
  'public, max-age=3600',
  false,
  '{"deleteAfterDays": null, "archiveAfterDays": null}'::jsonb,
  '{"allowedOrigins":["https://backend.goodos.app","https://app.goodos.app"],"allowedMethods":["GET"]}'::jsonb,
  'standard',
  'sha256',
  '{"phase":"18A","purpose":"public cdn route test"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE
SET
  visibility = EXCLUDED.visibility,
  public_read_enabled = EXCLUDED.public_read_enabled,
  file_versioning_enabled = EXCLUDED.file_versioning_enabled,
  provider = EXCLUDED.provider,
  provider_config_id = EXCLUDED.provider_config_id,
  provider_bucket_name = EXCLUDED.provider_bucket_name,
  provider_region = EXCLUDED.provider_region,
  provider_endpoint = EXCLUDED.provider_endpoint,
  cdn_enabled = EXCLUDED.cdn_enabled,
  cdn_base_url = EXCLUDED.cdn_base_url,
  cache_control = EXCLUDED.cache_control,
  lifecycle_json = EXCLUDED.lifecycle_json,
  cors_json = EXCLUDED.cors_json,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_policy_rules (
  id,
  name,
  description,
  target_type,
  target_id,
  operation,
  effect,
  priority,
  condition_json,
  message,
  status,
  organization_id,
  project_id,
  environment_id,
  metadata_json,
  created_by
)
VALUES
  (
    'pol_storage_write_allow',
    'Allow storage write operations',
    'Allows future storage write APIs for keys with write:storage.',
    'storage',
    '*',
    'write',
    'allow',
    100,
    '{"requiredScopes":["write:storage"]}'::jsonb,
    'Storage write allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"18A","storageV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_storage_public_read_allow',
    'Allow public storage object reads',
    'Allows public reads for buckets explicitly marked public/public_read_enabled.',
    'storage',
    'public',
    'read',
    'allow',
    100,
    '{"publicRead":true}'::jsonb,
    'Public storage read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"18A","storageV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  target_type = EXCLUDED.target_type,
  target_id = EXCLUDED.target_id,
  operation = EXCLUDED.operation,
  effect = EXCLUDED.effect,
  priority = EXCLUDED.priority,
  condition_json = EXCLUDED.condition_json,
  message = EXCLUDED.message,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_provider_configs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_storage_object_versions TO goodapp_backend_user;

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
  'audit_phase_18a_storage_v2',
  'system',
  'storage.v2.ready',
  'storage',
  'backend_storage_provider_configs',
  '{"phase":"18A","provider":"local","cdnRoute":"/storage/public/:bucket/:objectKey","s3Compatible":"metadata-ready"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
