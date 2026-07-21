BEGIN;

CREATE TABLE IF NOT EXISTS goodbase_release_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('certification','security','load','chaos','recovery','sdk','offline','region','cdn','distribution','telemetry','hosting','ci','commercial','compliance')),
  release_commit TEXT NOT NULL CHECK(release_commit ~ '^[0-9a-f]{7,64}$'), status TEXT NOT NULL CHECK(status IN ('passed','failed','blocked','partial')),
  artifact_ref TEXT NOT NULL, checksum_sha256 TEXT NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'), report_json JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, UNIQUE(evidence_type,release_commit,checksum_sha256)
);
CREATE INDEX IF NOT EXISTS goodbase_release_evidence_commit_idx ON goodbase_release_evidence(release_commit,evidence_type,verified_at DESC);

CREATE TABLE IF NOT EXISTS goodbase_commercial_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('payments','tax','invoicing','support','entitlements')), provider_name TEXT NOT NULL,
  secret_ref TEXT NOT NULL, webhook_secret_ref TEXT, status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','ready','degraded','disabled')),
  capabilities TEXT[] NOT NULL DEFAULT '{}', last_health_at TIMESTAMPTZ, verification_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id,provider_type,provider_name)
);

CREATE TABLE IF NOT EXISTS goodbase_compliance_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  control_family TEXT NOT NULL CHECK(control_family IN ('penetration_test','soc2','iso27001','privacy','dpa','subprocessors','security_whitepaper','incident_management')),
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','verified','expired','rejected')),
  assessor TEXT, artifact_ref TEXT, checksum_sha256 TEXT, effective_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_incident_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email_hash TEXT NOT NULL UNIQUE, encrypted_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','unsubscribed','bounced')),
  verification_token_hash TEXT, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE goodbase_controller_registrations DROP CONSTRAINT IF EXISTS goodbase_controller_registrations_controller_type_check;
ALTER TABLE goodbase_controller_registrations ADD CONSTRAINT goodbase_controller_registrations_controller_type_check
  CHECK(controller_type IN ('infrastructure','recovery','hosting','domain','preview','regional','cdn','distribution','embedding','import'));
ALTER TABLE goodbase_controller_operations DROP CONSTRAINT IF EXISTS goodbase_controller_operations_status_check;
ALTER TABLE goodbase_controller_operations ADD CONSTRAINT goodbase_controller_operations_status_check
  CHECK(status IN ('queued','running','awaiting_callback','succeeded','failed','cancelled'));
ALTER TABLE goodbase_controller_operations ADD COLUMN IF NOT EXISTS callback_received_at TIMESTAMPTZ;
ALTER TABLE goodbase_controller_operations ADD COLUMN IF NOT EXISTS rollback_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE goodbase_controller_operations ADD COLUMN IF NOT EXISTS failure_json JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['goodbase_release_evidence','goodbase_commercial_providers','goodbase_compliance_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I USING (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true)) WITH CHECK (organization_id=current_setting(''app.organization_id'',true) AND project_id=current_setting(''app.project_id'',true) AND environment_id=current_setting(''app.environment_id'',true))',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name); EXECUTE format('CREATE POLICY goodbase_backend_service ON %I TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
  END LOOP;
END $$;
ALTER TABLE goodbase_incident_subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE goodbase_incident_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS goodbase_backend_service ON goodbase_incident_subscriptions;
CREATE POLICY goodbase_backend_service ON goodbase_incident_subscriptions TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE);
GRANT SELECT,INSERT,UPDATE,DELETE ON goodbase_release_evidence,goodbase_commercial_providers,goodbase_compliance_evidence,goodbase_incident_subscriptions TO goodapp_backend_user;
COMMIT;
