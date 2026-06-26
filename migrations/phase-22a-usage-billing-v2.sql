BEGIN;

CREATE TABLE IF NOT EXISTS backend_billing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'usd',
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  annual_price_cents INTEGER NOT NULL DEFAULT 0,
  included_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 100,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_billing_customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id UUID,
  name TEXT,
  email TEXT,
  external_customer_id TEXT,
  provider TEXT NOT NULL DEFAULT 'internal',
  billing_email TEXT,
  tax_status TEXT NOT NULL DEFAULT 'not_configured',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  organization_id TEXT,
  plan_id TEXT,
  plan_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', NOW()) + INTERVAL '1 month'),
  trial_ends_at TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  provider TEXT NOT NULL DEFAULT 'internal',
  external_subscription_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  subscription_id TEXT,
  organization_id TEXT,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'usd',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  amount_due_cents INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  provider TEXT NOT NULL DEFAULT 'internal',
  external_invoice_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  organization_id TEXT,
  metric_key TEXT,
  description TEXT,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_usage_events (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'api',
  source TEXT NOT NULL DEFAULT 'public-api',
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'count',
  api_key_id TEXT,
  user_id UUID,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  route TEXT,
  method TEXT,
  status_code INTEGER,
  request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_usage_events_metric_created
ON backend_usage_events(metric_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_usage_events_api_key
ON backend_usage_events(api_key_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_meter_events (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  meter_name TEXT NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'count',
  billable BOOLEAN NOT NULL DEFAULT true,
  api_key_id TEXT,
  customer_id TEXT,
  subscription_id TEXT,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  usage_event_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_meter_events_metric_created
ON backend_meter_events(metric_key, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_usage_daily (
  id TEXT PRIMARY KEY,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  metric_key TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'api',
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'count',
  api_key_id TEXT,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_usage_daily_unique
ON backend_usage_daily(usage_date, metric_key, COALESCE(api_key_id, ''), COALESCE(organization_id, ''), COALESCE(project_id, ''), COALESCE(environment_id, ''));

CREATE TABLE IF NOT EXISTS backend_quota_counters (
  id TEXT PRIMARY KEY,
  metric_key TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'organization',
  scope_id TEXT NOT NULL DEFAULT 'org_goodos',
  period TEXT NOT NULL DEFAULT 'monthly',
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  quota_limit NUMERIC(18,4) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_quota_counters_unique
ON backend_quota_counters(metric_key, scope_type, scope_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS backend_api_key_usage_logs (
  id TEXT PRIMARY KEY,
  api_key_id TEXT,
  api_key_prefix TEXT,
  metric_key TEXT NOT NULL DEFAULT 'api.calls.monthly',
  route TEXT,
  method TEXT,
  status_code INTEGER,
  scope TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  ip_address TEXT,
  user_agent TEXT,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_api_key_usage_logs_created
ON backend_api_key_usage_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_api_key_usage_logs_key
ON backend_api_key_usage_logs(api_key_id, created_at DESC);

ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS metric_key TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS quota_limit BIGINT NOT NULL DEFAULT 0;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS quota_unit TEXT NOT NULL DEFAULT 'count';
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS warning_percent INTEGER NOT NULL DEFAULT 80;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS is_enforced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS environment_id TEXT;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE backend_usage_quotas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE backend_usage_quotas
SET
  organization_id = COALESCE(organization_id, 'org_goodos'),
  project_id = COALESCE(project_id, 'proj_goodos_platform'),
  environment_id = COALESCE(environment_id, 'env_goodos_production'),
  metric_key = COALESCE(metric_key, id),
  label = COALESCE(label, metric_key, id),
  metadata_json = COALESCE(metadata_json, '{}'::jsonb);

INSERT INTO backend_billing_plans (
  id,
  name,
  display_name,
  description,
  monthly_price_cents,
  annual_price_cents,
  included_json,
  limits_json,
  features_json,
  status,
  sort_order,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  (
    'plan_free',
    'free',
    'Free',
    'Starter backend plan for testing GoodOS APIs.',
    0,
    0,
    '{"apiCallsMonthly":1000,"storageBytes":104857600,"users":1}'::jsonb,
    '{"api.calls.monthly":1000,"storage.bytes":104857600,"users.active":1}'::jsonb,
    '["API keys","Basic storage","Realtime testing"]'::jsonb,
    'active',
    10,
    '{"phase":"22A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'plan_starter',
    'starter',
    'Starter',
    'Small business GoodOS backend plan.',
    2900,
    29000,
    '{"apiCallsMonthly":50000,"storageBytes":10737418240,"users":5}'::jsonb,
    '{"api.calls.monthly":50000,"storage.bytes":10737418240,"users.active":5}'::jsonb,
    '["Database API","Storage","Realtime","Webhooks"]'::jsonb,
    'active',
    20,
    '{"phase":"22A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'plan_business',
    'business',
    'Business',
    'Production GoodOS backend plan.',
    9900,
    99000,
    '{"apiCallsMonthly":500000,"storageBytes":107374182400,"users":25}'::jsonb,
    '{"api.calls.monthly":500000,"storage.bytes":107374182400,"users.active":25}'::jsonb,
    '["Everything in Starter","Edge Functions","Usage metering","Advanced auth"]'::jsonb,
    'active',
    30,
    '{"phase":"22A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'plan_enterprise',
    'enterprise',
    'Enterprise',
    'Full GoodOS platform plan for internal production.',
    0,
    0,
    '{"apiCallsMonthly":10000000,"storageBytes":1099511627776,"users":250}'::jsonb,
    '{"api.calls.monthly":10000000,"storage.bytes":1099511627776,"users.active":250}'::jsonb,
    '["Full backend suite","Custom limits","Internal billing","Priority controls"]'::jsonb,
    'active',
    40,
    '{"phase":"22A","internal":true}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  monthly_price_cents = EXCLUDED.monthly_price_cents,
  annual_price_cents = EXCLUDED.annual_price_cents,
  included_json = EXCLUDED.included_json,
  limits_json = EXCLUDED.limits_json,
  features_json = EXCLUDED.features_json,
  status = EXCLUDED.status,
  sort_order = EXCLUDED.sort_order,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_billing_customers (
  id,
  organization_id,
  user_id,
  name,
  email,
  provider,
  billing_email,
  status,
  metadata_json,
  project_id,
  environment_id,
  created_by
)
VALUES (
  'bcus_goodos_internal',
  'org_goodos',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  'GoodOS Internal',
  (SELECT email FROM users ORDER BY created_at ASC LIMIT 1),
  'internal',
  (SELECT email FROM users ORDER BY created_at ASC LIMIT 1),
  'active',
  '{"phase":"22A","internal":true}'::jsonb,
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE
SET
  email = EXCLUDED.email,
  billing_email = EXCLUDED.billing_email,
  status = 'active',
  updated_at = NOW();

INSERT INTO backend_subscriptions (
  id,
  customer_id,
  organization_id,
  plan_id,
  plan_name,
  status,
  billing_cycle,
  current_period_start,
  current_period_end,
  provider,
  metadata_json,
  project_id,
  environment_id,
  created_by
)
VALUES (
  'sub_goodos_internal_enterprise',
  'bcus_goodos_internal',
  'org_goodos',
  'plan_enterprise',
  'enterprise',
  'active',
  'monthly',
  date_trunc('month', NOW()),
  date_trunc('month', NOW()) + INTERVAL '1 month',
  'internal',
  '{"phase":"22A","internal":true}'::jsonb,
  'proj_goodos_platform',
  'env_goodos_production',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
)
ON CONFLICT (id) DO UPDATE
SET
  plan_id = EXCLUDED.plan_id,
  plan_name = EXCLUDED.plan_name,
  status = 'active',
  current_period_start = EXCLUDED.current_period_start,
  current_period_end = EXCLUDED.current_period_end,
  updated_at = NOW();

INSERT INTO backend_usage_quotas (
  id,
  metric_key,
  label,
  category,
  quota_limit,
  quota_unit,
  warning_percent,
  is_enforced,
  description,
  status,
  organization_id,
  project_id,
  environment_id,
  metadata_json
)
VALUES
  ('quota_api_calls_monthly', 'api.calls.monthly', 'Monthly API Calls', 'api', 10000000, 'calls', 80, false, 'Total public API calls per month.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_storage_bytes', 'storage.bytes', 'Storage Bytes', 'storage', 1099511627776, 'bytes', 80, false, 'Total stored object bytes.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_storage_files', 'storage.files', 'Storage Files', 'storage', 1000000, 'files', 80, false, 'Total storage file records.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_webhook_deliveries_monthly', 'webhooks.deliveries.monthly', 'Monthly Webhook Deliveries', 'webhooks', 1000000, 'deliveries', 80, false, 'Webhook deliveries per month.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_realtime_events_monthly', 'realtime.events.monthly', 'Monthly Realtime Events', 'realtime', 1000000, 'events', 80, false, 'Realtime events per month.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_functions_runs_monthly', 'functions.runs.monthly', 'Monthly Function Runs', 'functions', 1000000, 'runs', 80, false, 'Edge Function runs per month.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_users_active', 'users.active', 'Active Users', 'auth', 250, 'users', 80, false, 'Active users allowed.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb),
  ('quota_apps_active', 'apps.active', 'Active Apps', 'apps', 250, 'apps', 80, false, 'Active registered apps.', 'active', 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', '{"phase":"22A"}'::jsonb)
ON CONFLICT (id) DO UPDATE
SET
  label = EXCLUDED.label,
  category = EXCLUDED.category,
  quota_limit = EXCLUDED.quota_limit,
  quota_unit = EXCLUDED.quota_unit,
  warning_percent = EXCLUDED.warning_percent,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  organization_id = EXCLUDED.organization_id,
  project_id = EXCLUDED.project_id,
  environment_id = EXCLUDED.environment_id,
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
    'pol_usage_read_api_key',
    'Allow usage read with read:usage',
    'Allows API keys with read:usage to inspect their own usage.',
    'usage',
    '*',
    'read',
    'allow',
    100,
    '{"requiredScopes":["read:usage"]}'::jsonb,
    'Usage read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"22A","usageV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_billing_plans_public_read',
    'Allow billing plan reads',
    'Allows billing plan catalog reads.',
    'billing',
    'plans',
    'read',
    'allow',
    100,
    '{}'::jsonb,
    'Billing plans are readable.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"22A","usageV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  condition_json = EXCLUDED.condition_json,
  message = EXCLUDED.message,
  status = EXCLUDED.status,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_usage_events (
  id,
  metric_key,
  category,
  source,
  quantity,
  unit,
  organization_id,
  project_id,
  environment_id,
  metadata_json
)
VALUES (
  'usageevt_phase22a_ready',
  'usage.v2.ready',
  'system',
  'phase-22a',
  1,
  'event',
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production',
  '{"phase":"22A","features":["plans","customers","subscriptions","usage-events","quota-counters","api-key-usage-logs"]}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_billing_plans TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_billing_customers TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_subscriptions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_invoices TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_invoice_items TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_usage_events TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_meter_events TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_usage_daily TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_quota_counters TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_api_key_usage_logs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_usage_quotas TO goodapp_backend_user;

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
  'audit_phase_22a_usage_billing_v2',
  'system',
  'usage.billing.v2.ready',
  'usage_billing',
  'backend_usage_events',
  '{"phase":"22A","features":["billing-plans","subscriptions","usage-events","quota-counters","meter-events","public-usage-api"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
