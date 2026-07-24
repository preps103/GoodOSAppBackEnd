BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS goodads_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  environment_id TEXT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT goodads_resource_type_valid CHECK (
    resource_type IN (
      'campaigns', 'content', 'approvals', 'calendar', 'connections',
      'publishing_jobs', 'analytics', 'media', 'link_hubs', 'automations',
      'notifications', 'email_campaigns', 'designs', 'flyers',
      'business_cards', 'qr_codes', 'videos', 'brand', 'audit_events'
    )
  ),
  CONSTRAINT goodads_resource_status_valid CHECK (
    status IN (
      'draft', 'ready', 'pending', 'approved', 'rejected', 'scheduled',
      'queued', 'processing', 'active', 'paused', 'completed', 'failed',
      'connected', 'disconnected', 'expired', 'archived'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_goodads_resources_tenant_type
  ON goodads_resources (organization_id, resource_type, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_goodads_resources_owner
  ON goodads_resources (owner_user_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goodads_resource_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID REFERENCES goodads_resources(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES backend_organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  next_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goodads_resource_events_resource
  ON goodads_resource_events (resource_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON goodads_resources TO goodapp_backend_user;
GRANT SELECT, INSERT ON goodads_resource_events TO goodapp_backend_user;

COMMIT;
