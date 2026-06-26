BEGIN;

CREATE TABLE IF NOT EXISTS backend_notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'in_app',
  provider TEXT NOT NULL DEFAULT 'internal',
  from_name TEXT,
  from_email TEXT,
  reply_to_email TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_notification_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system',
  channel_type TEXT NOT NULL DEFAULT 'email',
  subject_template TEXT,
  body_text_template TEXT,
  body_html_template TEXT,
  variables_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_notifications (
  id TEXT PRIMARY KEY,
  notification_key TEXT,
  category TEXT NOT NULL DEFAULT 'system',
  channel TEXT NOT NULL DEFAULT 'in_app',
  title TEXT NOT NULL,
  message TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'unread',
  recipient_user_id UUID,
  recipient_email TEXT,
  actor_user_id UUID,
  source TEXT NOT NULL DEFAULT 'system',
  source_id TEXT,
  action_url TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_notifications_recipient
ON backend_notifications(recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_notifications_status
ON backend_notifications(status);

CREATE TABLE IF NOT EXISTS backend_notification_queue (
  id TEXT PRIMARY KEY,
  notification_id TEXT,
  queue_type TEXT NOT NULL DEFAULT 'notification',
  channel TEXT NOT NULL DEFAULT 'in_app',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_notification_queue_status
ON backend_notification_queue(status, scheduled_at ASC);

CREATE TABLE IF NOT EXISTS backend_email_queue (
  id TEXT PRIMARY KEY,
  notification_id TEXT,
  template_id TEXT,
  template_key TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT,
  from_email TEXT,
  from_name TEXT,
  reply_to_email TEXT,
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  provider TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  error_message TEXT,
  provider_message_id TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_email_queue_status
ON backend_email_queue(status, scheduled_at ASC);

CREATE INDEX IF NOT EXISTS idx_backend_email_queue_to_email
ON backend_email_queue(to_email, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_email_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject_template TEXT NOT NULL,
  body_text_template TEXT,
  body_html_template TEXT,
  category TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_alert_rules (
  id TEXT PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system',
  source_table TEXT,
  metric_key TEXT,
  condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity TEXT NOT NULL DEFAULT 'info',
  channel_names TEXT[] NOT NULL DEFAULT ARRAY['in_app'],
  template_key TEXT,
  throttle_minutes INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'active',
  last_triggered_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT,
  rule_key TEXT,
  category TEXT NOT NULL DEFAULT 'system',
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  notification_id TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_alert_events_status
ON backend_alert_events(status, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_message_center (
  id TEXT PRIMARY KEY,
  notification_id TEXT,
  user_id UUID,
  email TEXT,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'unread',
  action_url TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_message_center_user
ON backend_message_center(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_notification_preferences (
  id TEXT PRIMARY KEY,
  user_id UUID,
  email TEXT,
  category TEXT NOT NULL DEFAULT 'system',
  channel TEXT NOT NULL DEFAULT 'email',
  enabled BOOLEAN NOT NULL DEFAULT true,
  digest_frequency TEXT NOT NULL DEFAULT 'instant',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, category, channel)
);

CREATE TABLE IF NOT EXISTS backend_digest_jobs (
  id TEXT PRIMARY KEY,
  user_id UUID,
  email TEXT,
  category TEXT NOT NULL DEFAULT 'system',
  frequency TEXT NOT NULL DEFAULT 'daily',
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  notification_count INTEGER NOT NULL DEFAULT 0,
  email_queue_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO backend_notification_channels (
  id,
  name,
  display_name,
  channel_type,
  provider,
  from_name,
  from_email,
  reply_to_email,
  config_json,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  ('ntch_in_app', 'in_app', 'In-App Message Center', 'in_app', 'internal', 'GoodOS', 'no-reply@goodos.app', 'support@goodos.app', '{"dryRun":false}'::jsonb, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('ntch_email', 'email', 'Email Queue', 'email', 'smtp_or_dry_run', 'GoodOS', 'no-reply@goodos.app', 'support@goodos.app', '{"dryRunWhenSmtpMissing":true}'::jsonb, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('ntch_webhook', 'webhook', 'Webhook Notifications', 'webhook', 'internal_webhooks', 'GoodOS', 'no-reply@goodos.app', 'support@goodos.app', '{"futureUse":true}'::jsonb, 'planned', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  channel_type = EXCLUDED.channel_type,
  provider = EXCLUDED.provider,
  config_json = EXCLUDED.config_json,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO backend_notification_templates (
  id,
  template_key,
  name,
  category,
  channel_type,
  subject_template,
  body_text_template,
  body_html_template,
  variables_json,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  (
    'ntpl_system_notice',
    'system.notice',
    'System Notice',
    'system',
    'email',
    '{{title}}',
    '{{message}}',
    '<h2>{{title}}</h2><p>{{message}}</p>',
    '["title","message"]'::jsonb,
    'active',
    '{"phase":"23A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'ntpl_auth_invite',
    'auth.invite',
    'User Invite',
    'auth',
    'email',
    'You have been invited to GoodOS',
    'You were invited to GoodOS. Invite link: {{inviteUrl}}',
    '<h2>You were invited to GoodOS</h2><p>Use this invite link:</p><p><a href="{{inviteUrl}}">{{inviteUrl}}</a></p>',
    '["inviteUrl","email","role"]'::jsonb,
    'active',
    '{"phase":"23A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'ntpl_password_reset',
    'auth.password_reset',
    'Password Reset',
    'auth',
    'email',
    'Reset your GoodOS password',
    'A password reset was requested. Reset link: {{resetUrl}}',
    '<h2>Reset your GoodOS password</h2><p>Reset link:</p><p><a href="{{resetUrl}}">{{resetUrl}}</a></p>',
    '["resetUrl","email"]'::jsonb,
    'active',
    '{"phase":"23A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'ntpl_quota_warning',
    'usage.quota_warning',
    'Quota Warning',
    'usage',
    'email',
    'GoodOS quota warning: {{metricKey}}',
    'Usage for {{metricKey}} is at {{percent}}%. Current: {{current}} / Limit: {{limit}}.',
    '<h2>GoodOS quota warning</h2><p>{{metricKey}} is at {{percent}}%.</p><p>Current: {{current}} / Limit: {{limit}}</p>',
    '["metricKey","percent","current","limit"]'::jsonb,
    'active',
    '{"phase":"23A"}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  subject_template = EXCLUDED.subject_template,
  body_text_template = EXCLUDED.body_text_template,
  body_html_template = EXCLUDED.body_html_template,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO backend_email_templates (
  id,
  template_key,
  name,
  subject_template,
  body_text_template,
  body_html_template,
  category,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
SELECT
  id,
  template_key,
  name,
  COALESCE(subject_template, name),
  body_text_template,
  body_html_template,
  category,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
FROM backend_notification_templates
ON CONFLICT (id) DO UPDATE
SET
  subject_template = EXCLUDED.subject_template,
  body_text_template = EXCLUDED.body_text_template,
  body_html_template = EXCLUDED.body_html_template,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO backend_alert_rules (
  id,
  rule_key,
  name,
  category,
  source_table,
  metric_key,
  condition_json,
  severity,
  channel_names,
  template_key,
  throttle_minutes,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  ('altrule_quota_warning', 'usage.quota.warning', 'Usage quota warning', 'usage', 'backend_quota_counters', 'api.calls.monthly', '{"operator":">=","percent":80}'::jsonb, 'warning', ARRAY['in_app','email'], 'usage.quota_warning', 60, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('altrule_auth_security', 'auth.security.event', 'Auth security event', 'auth', 'backend_auth_audit_events', NULL, '{"eventTypes":["auth.login.failed","auth.mfa.failed"]}'::jsonb, 'warning', ARRAY['in_app'], 'system.notice', 30, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('altrule_webhook_failure', 'webhook.delivery.failed', 'Webhook delivery failure', 'webhooks', 'backend_webhook_deliveries', NULL, '{"statuses":["failed"]}'::jsonb, 'warning', ARRAY['in_app','email'], 'system.notice', 30, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('altrule_function_failed', 'function.run.failed', 'Edge Function failed run', 'functions', 'backend_edge_function_runs', NULL, '{"statuses":["failed","timeout"]}'::jsonb, 'critical', ARRAY['in_app'], 'system.notice', 15, 'active', '{"phase":"23A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  condition_json = EXCLUDED.condition_json,
  severity = EXCLUDED.severity,
  channel_names = EXCLUDED.channel_names,
  template_key = EXCLUDED.template_key,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO backend_notification_preferences (
  id,
  user_id,
  email,
  category,
  channel,
  enabled,
  digest_frequency,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
SELECT
  'ntpref_' || replace(id::text, '-', '') || '_system_email',
  id,
  email,
  'system',
  'email',
  true,
  'instant',
  '{"phase":"23A","seeded":true}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
FROM users
ON CONFLICT (user_id, category, channel) DO UPDATE
SET
  email = EXCLUDED.email,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

INSERT INTO backend_notifications (
  id,
  notification_key,
  category,
  channel,
  title,
  message,
  severity,
  status,
  recipient_user_id,
  recipient_email,
  source,
  source_id,
  payload_json,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'ntf_phase23a_ready',
  'notifications.v2.ready',
  'system',
  'in_app',
  'Notifications V2 is ready',
  'Notification templates, email queue, alert rules, and message center foundation are active.',
  'success',
  'unread',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  (SELECT email FROM users ORDER BY created_at ASC LIMIT 1),
  'phase-23a',
  'phase-23a',
  '{"phase":"23A"}'::jsonb,
  '{"seeded":true}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backend_message_center (
  id,
  notification_id,
  user_id,
  email,
  title,
  body,
  severity,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'msg_phase23a_ready',
  'ntf_phase23a_ready',
  (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
  (SELECT email FROM users ORDER BY created_at ASC LIMIT 1),
  'Notifications V2 is ready',
  'Notification templates, email queue, alert rules, and message center foundation are active.',
  'success',
  'unread',
  '{"seeded":true,"phase":"23A"}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

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
    'pol_notifications_read_api_key',
    'Allow notification reads',
    'Allows API keys with read:notifications to read notifications.',
    'notification',
    '*',
    'read',
    'allow',
    100,
    '{"requiredScopes":["read:notifications"]}'::jsonb,
    'Notification read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"23A","notificationsV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_notifications_write_api_key',
    'Allow notification writes',
    'Allows API keys with write:notifications to create notification events.',
    'notification',
    '*',
    'write',
    'allow',
    100,
    '{"requiredScopes":["write:notifications"]}'::jsonb,
    'Notification write allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"23A","notificationsV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_alert_manage_owner_admin',
    'Allow alert management',
    'Allows owner/admin users to manage alert rules and notification queue records.',
    'alert',
    '*',
    'manage',
    'allow',
    100,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Alert management allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"23A","notificationsV2":true}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_notification_channels TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_notification_templates TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_notifications TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_notification_queue TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_email_queue TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_email_templates TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_alert_rules TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_alert_events TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_message_center TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_notification_preferences TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_digest_jobs TO goodapp_backend_user;

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
  'audit_phase_23a_notifications_v2',
  'system',
  'notifications.v2.ready',
  'notification',
  'backend_notifications',
  '{"phase":"23A","features":["templates","email-queue","alert-rules","message-center","preferences"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
