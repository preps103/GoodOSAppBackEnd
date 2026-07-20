BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS avatar_file_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_content_type TEXT,
  ADD COLUMN IF NOT EXISTS avatar_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN users.avatar_url IS
  'Public GoodOS API URL for the current profile avatar.';

COMMENT ON COLUMN users.avatar_file_name IS
  'Server-managed file name within the protected profile avatar directory.';

COMMIT;
