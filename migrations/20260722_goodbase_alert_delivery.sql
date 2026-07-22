BEGIN;

CREATE TABLE IF NOT EXISTS goodbase_alert_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_hash TEXT NOT NULL UNIQUE,
  group_key TEXT,
  receiver TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','duplicate','rejected','processed','failed')),
  alert_count INTEGER NOT NULL DEFAULT 0,
  signature_timestamp TIMESTAMPTZ NOT NULL,
  signature_nonce TEXT NOT NULL UNIQUE,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_goodbase_alert_receipts_received
ON goodbase_alert_receipts(received_at DESC);

CREATE TABLE IF NOT EXISTS goodbase_on_call_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL DEFAULT 'org_goodos',
  project_id TEXT NOT NULL DEFAULT 'proj_goodos_platform',
  environment_id TEXT NOT NULL DEFAULT 'env_goodos_production',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  quiet_hours_json JSONB NOT NULL DEFAULT '{"enabled":false,"start":"22:00","end":"07:00","criticalBypass":true}'::jsonb,
  routes_json JSONB NOT NULL DEFAULT '{"critical":["email","in_app"],"warning":["email","in_app"],"info":["in_app"]}'::jsonb,
  escalation_json JSONB NOT NULL DEFAULT '[{"delayMinutes":0,"channel":"email"},{"delayMinutes":15,"channel":"email"}]'::jsonb,
  recipient_user_id UUID,
  recipient_email TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, project_id, environment_id, name)
);

INSERT INTO goodbase_on_call_policies(name,recipient_user_id,recipient_email,created_by)
SELECT 'Production on-call',id,email,id FROM users ORDER BY created_at LIMIT 1
ON CONFLICT(organization_id,project_id,environment_id,name) DO NOTHING;

CREATE TABLE IF NOT EXISTS goodbase_alert_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID REFERENCES goodbase_alert_receipts(id) ON DELETE SET NULL,
  policy_id UUID REFERENCES goodbase_on_call_policies(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  alert_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('firing','resolved')),
  labels_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotations_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_goodbase_alert_instances_status
ON goodbase_alert_instances(status,severity,last_received_at DESC);

CREATE TABLE IF NOT EXISTS goodbase_alert_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_instance_id UUID NOT NULL REFERENCES goodbase_alert_instances(id) ON DELETE CASCADE,
  policy_id UUID REFERENCES goodbase_on_call_policies(id) ON DELETE SET NULL,
  escalation_step INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL CHECK (channel IN ('email','in_app','webhook','sms','slack','pagerduty','opsgenie')),
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','suppressed','queued','sent','simulated','retrying','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notification_id TEXT,
  email_queue_id TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  UNIQUE(alert_instance_id,escalation_step,channel)
);

CREATE INDEX IF NOT EXISTS idx_goodbase_alert_delivery_due
ON goodbase_alert_delivery_attempts(status,next_attempt_at);

INSERT INTO backend_jobs(id,name,display_name,description,job_type,handler_key,status,priority,schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by)
VALUES('job_goodbase_alert_delivery','goodbase.alerts.deliver','Deliver Goodbase Alerts','Routes signed Alertmanager alerts through on-call policies, escalation and durable delivery tracking.','scheduled','goodbase.alerts.deliver','active',2,15,120,3,'goodbase.alerts.deliver',NOW(),'{"controller":"observability","phase":"outbound-alerting"}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,schedule_seconds=EXCLUDED.schedule_seconds,description=EXCLUDED.description,status='active',updated_at=NOW();

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,timezone,enabled,next_run_at,metadata_json,organization_id,project_id,environment_id)
VALUES('schedule_goodbase_alert_delivery','job_goodbase_alert_delivery','interval',15,'UTC',TRUE,NOW(),'{"controller":"observability"}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
ON CONFLICT(job_id) DO UPDATE SET interval_seconds=15,enabled=TRUE,next_run_at=LEAST(backend_job_schedules.next_run_at,NOW()),updated_at=NOW();

GRANT SELECT,INSERT,UPDATE,DELETE ON goodbase_alert_receipts,goodbase_on_call_policies,goodbase_alert_instances,goodbase_alert_delivery_attempts TO goodapp_backend_user;

COMMIT;
