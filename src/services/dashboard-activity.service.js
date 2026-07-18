"use strict";

const {
  query,
} = require("../config/database");

const SOURCE =
  "events+admin-audit+notifications+releases+webhook-deliveries";

function normalizedLimit(value) {
  const parsed =
    Number(value);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.min(
    Math.max(
      Math.trunc(parsed),
      4
    ),
    50
  );
}

async function getDashboardActivitySnapshot({
  limit = 12,
} = {}) {
  const safeLimit =
    normalizedLimit(limit);

  const result =
    await query(
      `
        SELECT
          id,
          kind,
          title,
          description,
          status,
          source,
          "createdAt"
        FROM (
          SELECT
            'event:' || id
              AS id,

            'event'::text
              AS kind,

            COALESCE(
              NULLIF(event_type, ''),
              'System event'
            )
              AS title,

            NULLIF(message, '')
              AS description,

            NULL::text
              AS status,

            COALESCE(
              NULLIF(source, ''),
              'goodapp-backend'
            )
              AS source,

            created_at
              AS "createdAt"

          FROM backend_events

          UNION ALL

          SELECT
            'audit:' || id
              AS id,

            'audit'::text
              AS kind,

            COALESCE(
              NULLIF(action, ''),
              'Administrative activity'
            )
              AS title,

            NULLIF(
              REPLACE(
                COALESCE(
                  target_type,
                  ''
                ),
                '_',
                ' '
              ),
              ''
            )
              AS description,

            'completed'::text
              AS status,

            'audit'::text
              AS source,

            created_at
              AS "createdAt"

          FROM backend_admin_audit_logs

          UNION ALL

          SELECT
            'notification:' || id
              AS id,

            'notification'::text
              AS kind,

            COALESCE(
              NULLIF(title, ''),
              'Notification'
            )
              AS title,

            NULLIF(message, '')
              AS description,

            COALESCE(
              NULLIF(status, ''),
              NULLIF(severity, '')
            )
              AS status,

            COALESCE(
              NULLIF(source, ''),
              'notification-service'
            )
              AS source,

            created_at
              AS "createdAt"

          FROM backend_notifications

          WHERE archived_at IS NULL

          UNION ALL

          SELECT
            'release:' || id
              AS id,

            'deployment'::text
              AS kind,

            'Release deployment'::text
              AS title,

            CASE
              WHEN NULLIF(
                release_id,
                ''
              ) IS NOT NULL
              THEN
                'Release ' ||
                release_id
              ELSE NULL
            END
              AS description,

            NULLIF(status, '')
              AS status,

            'release'::text
              AS source,

            COALESCE(
              completed_at,
              started_at
            )
              AS "createdAt"

          FROM backend_release_deployments

          UNION ALL

          SELECT
            'webhook:' || id
              AS id,

            'webhook'::text
              AS kind,

            COALESCE(
              NULLIF(event_type, ''),
              'Webhook delivery'
            )
              AS title,

            CASE
              WHEN response_status
                   IS NOT NULL
              THEN
                'HTTP ' ||
                response_status::text
              ELSE NULL
            END
              AS description,

            NULLIF(status, '')
              AS status,

            'webhook'::text
              AS source,

            COALESCE(
              delivered_at,
              created_at
            )
              AS "createdAt"

          FROM backend_webhook_deliveries
        ) activity

        WHERE "createdAt"
              IS NOT NULL

        ORDER BY
          "createdAt" DESC,
          id DESC

        LIMIT $1
      `,
      [
        safeLimit,
      ]
    );

  const activities =
    result.rows || [];

  const byKind =
    activities.reduce(
      (counts, activity) => {
        const kind =
          String(
            activity.kind ||
            "unknown"
          );

        counts[kind] =
          Number(
            counts[kind] || 0
          ) + 1;

        return counts;
      },
      {}
    );

  return {
    source: SOURCE,
    checkedAt:
      new Date().toISOString(),
    limit:
      safeLimit,
    counts: {
      returned:
        activities.length,
      byKind,
    },
    activities,
  };
}

module.exports = {
  getDashboardActivitySnapshot,
};
