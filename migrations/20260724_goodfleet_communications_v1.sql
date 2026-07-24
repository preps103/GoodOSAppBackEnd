BEGIN;

CREATE TABLE IF NOT EXISTS fleet_chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  channel_type text NOT NULL CHECK (channel_type IN ('group', 'direct')),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS fleet_chat_channels_org_idx
  ON fleet_chat_channels (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS fleet_chat_channel_members (
  channel_id uuid NOT NULL REFERENCES fleet_chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_role text NOT NULL DEFAULT 'member'
    CHECK (membership_role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS fleet_chat_members_user_idx
  ON fleet_chat_channel_members (user_id, channel_id);

CREATE TABLE IF NOT EXISTS fleet_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  channel_id uuid NOT NULL,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  client_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY (organization_id, channel_id)
    REFERENCES fleet_chat_channels(organization_id, id)
    ON DELETE CASCADE,
  UNIQUE (organization_id, sender_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS fleet_chat_messages_channel_idx
  ON fleet_chat_messages (organization_id, channel_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fleet_chat_reads (
  channel_id uuid NOT NULL REFERENCES fleet_chat_channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS fleet_customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  customer_id uuid NOT NULL,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('reservation', 'payment', 'trip', 'support', 'general')),
  channels text[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'partially_delivered', 'delivered', 'failed')),
  action_url text,
  client_request_id text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  archived_at timestamptz,
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES fleet_customers(organization_id, id)
    ON DELETE CASCADE,
  UNIQUE (organization_id, created_by, client_request_id)
);

CREATE INDEX IF NOT EXISTS fleet_customer_notifications_recipient_idx
  ON fleet_customer_notifications (recipient_user_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS fleet_customer_notifications_email_idx
  ON fleet_customer_notifications (lower(recipient_email), created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS fleet_customer_notifications_org_idx
  ON fleet_customer_notifications (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fleet_customer_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL
    REFERENCES fleet_customer_notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  provider_reference text,
  attempted_at timestamptz,
  delivered_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel)
);

CREATE INDEX IF NOT EXISTS fleet_notification_deliveries_status_idx
  ON fleet_customer_notification_deliveries (status, created_at);

COMMIT;
