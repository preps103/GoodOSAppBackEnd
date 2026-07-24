CREATE TABLE IF NOT EXISTS goodboost_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'Free' CHECK (tier IN ('Free','Basic','Advanced','Premium')),
  trust_score INTEGER NOT NULL DEFAULT 0 CHECK (trust_score BETWEEN 0 AND 100),
  daily_streak INTEGER NOT NULL DEFAULT 0 CHECK (daily_streak >= 0),
  bonus_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  referral_json JSONB NOT NULL DEFAULT '{"count":0,"earned":0,"code":""}'::jsonb,
  white_label_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodboost_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  content_url TEXT NOT NULL,
  interaction_type TEXT NOT NULL,
  target INTEGER NOT NULL CHECK (target BETWEEN 10 AND 1000),
  current_count INTEGER NOT NULL DEFAULT 0 CHECK (current_count >= 0),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused','Completed','Queued','Error')),
  targeting_json JSONB NOT NULL DEFAULT '{"countries":[],"interests":[],"verifiedOnly":false}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodboost_campaigns_user_created_idx
  ON goodboost_campaigns(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goodboost_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goodboost_activity_user_created_idx
  ON goodboost_activity(user_id, created_at DESC);

INSERT INTO apps (
  id, name, domain, status, description,
  organization_id, project_id, environment_id
)
VALUES (
  'goodboost', 'GoodBoost', 'boost.goodos.app', 'active', 'GoodOS growth campaign application',
  'org_goodos', 'proj_goodos_platform', 'env_goodos_production'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  domain = EXCLUDED.domain,
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id;
