BEGIN;

ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS delivered_ws_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS delivered_sse_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backend_realtime_events ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS backend_realtime_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'active',
  allow_public_subscribe BOOLEAN NOT NULL DEFAULT false,
  allow_public_publish BOOLEAN NOT NULL DEFAULT false,
  require_api_key BOOLEAN NOT NULL DEFAULT true,
  max_subscribers INTEGER NOT NULL DEFAULT 1000,
  retention_days INTEGER NOT NULL DEFAULT 30,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_channels_status
ON backend_realtime_channels(status);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_channels_project_env
ON backend_realtime_channels(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_realtime_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  channel TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL DEFAULT 'message',
  source TEXT NOT NULL DEFAULT 'public-api',
  message TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'recorded',
  delivered_ws_count INTEGER NOT NULL DEFAULT 0,
  delivered_sse_count INTEGER NOT NULL DEFAULT 0,
  api_key_id TEXT,
  connection_id TEXT,
  request_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_messages_channel
ON backend_realtime_messages(channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_messages_api_key
ON backend_realtime_messages(api_key_id);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_messages_project_env
ON backend_realtime_messages(project_id, environment_id);

CREATE TABLE IF NOT EXISTS backend_realtime_connections (
  id TEXT PRIMARY KEY,
  transport TEXT NOT NULL DEFAULT 'websocket',
  channel TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'connected',
  api_key_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'api_key',
  actor_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  close_code INTEGER,
  close_reason TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_connections_channel
ON backend_realtime_connections(channel);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_connections_status
ON backend_realtime_connections(status);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_connections_api_key
ON backend_realtime_connections(api_key_id);

CREATE TABLE IF NOT EXISTS backend_realtime_subscriptions (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  channel TEXT NOT NULL DEFAULT 'system',
  transport TEXT NOT NULL DEFAULT 'websocket',
  api_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_subscriptions_channel
ON backend_realtime_subscriptions(channel);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_subscriptions_status
ON backend_realtime_subscriptions(status);

CREATE TABLE IF NOT EXISTS backend_realtime_presence (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'system',
  connection_id TEXT,
  api_key_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'api_key',
  actor_id TEXT,
  presence_state TEXT NOT NULL DEFAULT 'online',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  organization_id TEXT,
  project_id TEXT,
  environment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_presence_channel
ON backend_realtime_presence(channel);

CREATE INDEX IF NOT EXISTS idx_backend_realtime_presence_state
ON backend_realtime_presence(presence_state);

INSERT INTO backend_realtime_channels (
  id,
  name,
  display_name,
  description,
  visibility,
  status,
  allow_public_subscribe,
  allow_public_publish,
  require_api_key,
  policy_json,
  metadata_json,
  organization_id,
  project_id,
  environment_id,
  created_by
)
VALUES
  (
    'rtch_system',
    'system',
    'System',
    'System-wide realtime messages and operational broadcasts.',
    'private',
    'active',
    true,
    true,
    true,
    '{"requiredSubscribeScopes":["subscribe:realtime"],"requiredPublishScopes":["publish:realtime"]}'::jsonb,
    '{"phase":"20A","seeded":true}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'rtch_apps',
    'apps',
    'Apps',
    'Application registry events and app-level broadcasts.',
    'private',
    'active',
    true,
    true,
    true,
    '{"requiredSubscribeScopes":["subscribe:realtime"],"requiredPublishScopes":["publish:realtime"]}'::jsonb,
    '{"phase":"20A","seeded":true}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'rtch_storage',
    'storage',
    'Storage',
    'Storage object, upload, and CDN events.',
    'private',
    'active',
    true,
    true,
    true,
    '{"requiredSubscribeScopes":["subscribe:realtime"],"requiredPublishScopes":["publish:realtime"]}'::jsonb,
    '{"phase":"20A","seeded":true}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'rtch_functions',
    'functions',
    'Functions',
    'Edge Function execution and deployment broadcasts.',
    'private',
    'active',
    true,
    true,
    true,
    '{"requiredSubscribeScopes":["subscribe:realtime"],"requiredPublishScopes":["publish:realtime"]}'::jsonb,
    '{"phase":"20A","seeded":true}'::jsonb,
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
ON CONFLICT (id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  allow_public_subscribe = EXCLUDED.allow_public_subscribe,
  allow_public_publish = EXCLUDED.allow_public_publish,
  policy_json = EXCLUDED.policy_json,
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
    'pol_realtime_read_allow',
    'Allow realtime reads',
    'Allows API keys with read:realtime to list realtime channels and messages.',
    'realtime',
    '*',
    'read',
    'allow',
    100,
    '{"requiredScopes":["read:realtime"]}'::jsonb,
    'Realtime read allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"20A","realtimeV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_realtime_subscribe_allow',
    'Allow realtime subscriptions',
    'Allows API keys with subscribe:realtime to subscribe to realtime channels.',
    'realtime',
    '*',
    'subscribe',
    'allow',
    100,
    '{"requiredScopes":["subscribe:realtime"]}'::jsonb,
    'Realtime subscribe allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"20A","realtimeV2":true}'::jsonb,
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  ),
  (
    'pol_realtime_publish_allow',
    'Allow realtime publishing',
    'Allows API keys with publish:realtime to publish realtime messages.',
    'realtime',
    '*',
    'publish',
    'allow',
    100,
    '{"requiredScopes":["publish:realtime"]}'::jsonb,
    'Realtime publish allowed by policy.',
    'active',
    'org_goodos',
    'proj_goodos_platform',
    'env_goodos_production',
    '{"phase":"20A","realtimeV2":true}'::jsonb,
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

INSERT INTO backend_realtime_messages (
  id,
  channel_id,
  channel,
  event_type,
  source,
  message,
  payload_json,
  status,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'rtmsg_phase20a_ready',
  'rtch_system',
  'system',
  'realtime.v2.ready',
  'phase-20a',
  'Realtime V2 WebSocket channel foundation is ready.',
  '{"phase":"20A","transport":["websocket","sse","rest"]}'::jsonb,
  'recorded',
  '{"seeded":true}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backend_realtime_events (
  id,
  event_type,
  source,
  channel,
  message,
  payload,
  status,
  message_id,
  metadata_json,
  organization_id,
  project_id,
  environment_id
)
VALUES (
  'evt_phase20a_realtime_v2_ready',
  'realtime.v2.ready',
  'phase-20a',
  'system',
  'Realtime V2 WebSocket channel foundation is ready.',
  '{"phase":"20A","transport":["websocket","sse","rest"]}'::jsonb,
  'recorded',
  'rtmsg_phase20a_ready',
  '{"seeded":true}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

UPDATE backend_realtime_channels c
SET
  message_count = COALESCE(stats.count, 0),
  last_message_at = stats.last_message_at,
  updated_at = NOW()
FROM (
  SELECT channel, COUNT(*)::int AS count, MAX(created_at) AS last_message_at
  FROM backend_realtime_messages
  GROUP BY channel
) stats
WHERE stats.channel = c.name;

GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_channels TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_messages TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_connections TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_subscriptions TO goodapp_backend_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backend_realtime_presence TO goodapp_backend_user;

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
  'audit_phase_20a_realtime_v2',
  'system',
  'realtime.v2.ready',
  'realtime',
  'backend_realtime_channels',
  '{"phase":"20A","features":["websocket","channels","subscriptions","presence","message-log","public-api"]}'::jsonb,
  'org_goodos',
  'proj_goodos_platform',
  'env_goodos_production'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
