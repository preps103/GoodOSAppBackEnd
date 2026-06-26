BEGIN;

CREATE TABLE IF NOT EXISTS backend_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  job_type TEXT NOT NULL DEFAULT 'scheduled',
  handler_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 100,
  schedule_seconds INTEGER NOT NULL DEFAULT 300,
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  concurrency_key TEXT,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status TEXT,
  last_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_jobs_due
ON backend_jobs(status, next_run_at ASC);

CREATE TABLE IF NOT EXISTS backend_job_schedules (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'interval',
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  cron_expression TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_enqueued_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id)
);

CREATE TABLE IF NOT EXISTS backend_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  job_name TEXT NOT NULL,
  handler_key TEXT NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_job_runs_created
ON backend_job_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_job_runs_job
ON backend_job_runs(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backend_worker_locks (
  id TEXT PRIMARY KEY,
  lock_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'locked',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_worker_locks_until
ON backend_worker_locks(locked_until);

CREATE TABLE IF NOT EXISTS backend_worker_heartbeats (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL UNIQUE,
  worker_name TEXT NOT NULL,
  hostname TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_queue_items (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL DEFAULT 'default',
  item_type TEXT NOT NULL DEFAULT 'job',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 100,
  handler_key TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_queue_items_pending
ON backend_queue_items(queue_name, status, scheduled_at ASC);

INSERT INTO backend_jobs (
  id,
  name,
  display_name,
  description,
  job_type,
  handler_key,
  status,
  priority,
  schedule_seconds,
  timeout_seconds,
  max_attempts,
  concurrency_key,
  next_run_at,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  ('job_email_queue_process', 'email.queue.process', 'Process Email Queue', 'Processes pending email queue records. Uses SMTP when configured and dry-run simulation otherwise.', 'scheduled', 'notifications.email_queue.process', 'active', 10, 60, 120, 1, 'email.queue.process', NOW() + INTERVAL '30 seconds', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('job_alert_rules_evaluate', 'alerts.evaluate', 'Evaluate Alert Rules', 'Evaluates alert rules from quota counters and system sources.', 'scheduled', 'notifications.alert_rules.evaluate', 'active', 20, 300, 120, 1, 'alerts.evaluate', NOW() + INTERVAL '1 minute', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('job_security_sessions_cleanup', 'security.sessions.cleanup_expired', 'Cleanup Expired Sessions', 'Revokes expired sessions and records cleanup counts.', 'scheduled', 'security.sessions.cleanup_expired', 'active', 30, 3600, 120, 1, 'security.sessions.cleanup_expired', NOW() + INTERVAL '5 minutes', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('job_usage_quota_refresh', 'usage.quota_counters.refresh', 'Refresh Usage Quota Counters', 'Refreshes quota counter status values and records usage health.', 'scheduled', 'usage.quota_counters.refresh', 'active', 40, 300, 120, 1, 'usage.quota_counters.refresh', NOW() + INTERVAL '2 minutes', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('job_digest_jobs_process', 'notifications.digest.process', 'Process Digest Jobs', 'Processes scheduled digest job records for future digest emails.', 'scheduled', 'notifications.digest.process', 'active', 50, 3600, 120, 1, 'notifications.digest.process', NOW() + INTERVAL '10 minutes', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)),
  ('job_webhook_retry_scan', 'webhooks.retry.scan', 'Scan Webhook Retry Queue', 'Scans due webhook retry records and reports pending counts.', 'scheduled', 'webhooks.retry.scan', 'active', 60, 120, 120, 1, 'webhooks.retry.scan', NOW() + INTERVAL '2 minutes', '{"phase":"24A"}'::jsonb, 'org_goodos', 'proj_goodos_platform', 'env_goodos_production', (SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
ON CONFLICT (id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  handler_key = EXCLUDED.handler_key,
  schedule_seconds = EXCLUDED.schedule_seconds,
  timeout_seconds = EXCLUDED.timeout_seconds,
  max_attempts = EXCLUDED.max_attempts,
  concurrency_key = EXCLUDED.concurrency_key,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_job_schedules (
  id,
  job_id,
  schedule_type,
  interval_seconds,
  enabled,
  next_run_at,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
SELECT
  'schedule_' || j.id,
  j.id,
  'interval',
  j.schedule_seconds,
  j.status = 'active',
  j.next_run_at,
  '{"phase":"24A"}'::jsonb,
  j.organization_id,
  j.project_id,
  j.environment_id
FROM backend_jobs j
ON CONFLICT (job_id) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  enabled = EXCLUDED.enabled,
  next_run_at = EXCLUDED.next_run_at,
  metadata_json = EXCLUDED.metadata_json,
  updated_at = NOW();

INSERT INTO backend_queue_items (
  id,
  queue_name,
  item_type,
  status,
  priority,
  handler_key,
  payload_json,
  scheduled_at,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'queue_phase24a_ready',
  'system',
  'job',
  'completed',
  100,
  'jobs.v2.ready',
  '{"phase":"24A","message":"Background Jobs V2 foundation installed."}'::jsonb,
  NOW(),
  '{"seeded":true}'::jsonb,
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
    'pol_jobs_manage_owner_admin',
    'Allow job management',
    'Allows owner/admin users to manage jobs, schedules, queues, and worker controls.',
    'job',
    '*',
    'manage',
    'allow',
    100,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Job management allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"24A","jobsV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_jobs_read_owner_admin',
    'Allow job reads',
    'Allows owner/admin users to read jobs, schedules, queues, and worker state.',
    'job',
    '*',
    'read',
    'allow',
    100,
    '{"requiredRoles":["owner","admin"]}'::jsonb,
    'Job read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"24A","jobsV2":true}'::jsonb,
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

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_jobs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_job_schedules TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_job_runs TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_worker_locks TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_worker_heartbeats TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_queue_items TO goodapp_backend_user;

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
  'audit_phase_24a_background_jobs_v2',
  'system',
  'jobs.v2.ready',
  'job',
  'backend_jobs',
  '{"phase":"24A","features":["jobs","job_runs","schedules","worker_locks","worker_heartbeats","queue_items","pm2_worker"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
