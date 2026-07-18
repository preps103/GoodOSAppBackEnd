/* GOODOS_API_ACCESS_LIVE_V1 */

BEGIN;

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    NOT NULL
    DEFAULT NOW();

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS metadata_json JSONB
    NOT NULL
    DEFAULT '{}'::jsonb;

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS rotated_from_key_id TEXT;

ALTER TABLE backend_api_keys
  ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS
  idx_backend_api_keys_org_status
ON backend_api_keys (
  organization_id,
  status,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_backend_api_keys_creator
ON backend_api_keys (
  created_by,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_backend_api_keys_expiration
ON backend_api_keys (
  expires_at
)
WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_backend_api_key_usage_key_created
ON backend_api_key_usage_logs (
  api_key_id,
  created_at DESC
);

COMMIT;
