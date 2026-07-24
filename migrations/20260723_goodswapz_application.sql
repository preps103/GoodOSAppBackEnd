CREATE TABLE IF NOT EXISTS goodswapz_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 8 AND 120),
  handle TEXT NOT NULL,
  account_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('YouTube','Instagram','TikTok','Twitter/X','Telegram')),
  subscribers BIGINT NOT NULL CHECK (subscribers > 0),
  price NUMERIC(14,2) NOT NULL CHECK (price >= 50),
  monthly_revenue NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_revenue >= 0),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 40 AND 4000),
  category TEXT NOT NULL,
  engagement_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (engagement_rate BETWEEN 0 AND 100),
  image_url TEXT,
  country TEXT NOT NULL,
  original_email_included BOOLEAN NOT NULL DEFAULT FALSE,
  audience_male_percent INTEGER NOT NULL DEFAULT 50 CHECK (audience_male_percent BETWEEN 0 AND 100),
  instant_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  audience_report_available BOOLEAN NOT NULL DEFAULT FALSE,
  audience_age_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  audience_locations_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  transfer_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','active','rejected','sold','archived')),
  ownership_verification_code TEXT NOT NULL UNIQUE,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodswapz_listings_status_created_idx
  ON goodswapz_listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS goodswapz_listings_user_created_idx
  ON goodswapz_listings(user_id, created_at DESC);

INSERT INTO apps (
  id, name, domain, status, description,
  organization_id, project_id, environment_id
)
VALUES (
  'goodswapz', 'GoodSwapz', 'swapz.goodos.app', 'active', 'Secure marketplace for transferring social media accounts',
  'org_goodos', 'proj_goodos_platform', 'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  domain=EXCLUDED.domain,
  status=EXCLUDED.status,
  description=EXCLUDED.description,
  organization_id=EXCLUDED.organization_id,
  project_id=EXCLUDED.project_id,
  environment_id=EXCLUDED.environment_id;
