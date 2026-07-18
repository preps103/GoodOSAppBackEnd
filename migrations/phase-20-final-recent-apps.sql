-- GOODOS_RECENT_APPS_LIVE_V1

CREATE INDEX IF NOT EXISTS
  idx_backend_usage_events_recent_apps
ON backend_usage_events (
  user_id,
  created_at DESC
)
WHERE metric_key = 'app.opened';

-- END GOODOS_RECENT_APPS_LIVE_V1
