BEGIN;

ALTER TABLE backend_organizations
  ADD COLUMN IF NOT EXISTS legal_name TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS business_email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS company_size TEXT,
  ADD COLUMN IF NOT EXISTS address_line_1 TEXT,
  ADD COLUMN IF NOT EXISTS address_line_2 TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS country_code TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS logo_file_name TEXT,
  ADD COLUMN IF NOT EXISTS logo_content_type TEXT,
  ADD COLUMN IF NOT EXISTS logo_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN backend_organizations.logo_url IS
  'Public GoodOS API URL for the current organization logo.';

COMMENT ON COLUMN backend_organizations.logo_file_name IS
  'Server-managed file name within the protected organization logo directory.';

COMMIT;
