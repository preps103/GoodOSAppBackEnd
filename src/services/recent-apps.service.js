"use strict";

/* GOODOS_RECENT_APPS_LIVE_V1 */

const crypto =
  require("crypto");

const database =
  require("../config/database");

function dbQuery(
  sql,
  params = []
) {
  if (
    typeof database.query ===
    "function"
  ) {
    return database.query(
      sql,
      params
    );
  }

  if (
    database.pool &&
    typeof database.pool.query ===
      "function"
  ) {
    return database.pool.query(
      sql,
      params
    );
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database
      .getPool()
      .query(
        sql,
        params
      );
  }

  if (
    database.default &&
    typeof database.default.query ===
      "function"
  ) {
    return database.default.query(
      sql,
      params
    );
  }

  throw new Error(
    "Database query function not found"
  );
}

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto
      .randomUUID()
      .replaceAll(
        "-",
        ""
      )
  );
}

function serviceError(
  message,
  statusCode
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}

function normalizedAppId(
  value
) {
  const appId =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(
      appId
    )
  ) {
    throw serviceError(
      "A valid application ID is required.",
      400
    );
  }

  return appId;
}

function normalizedUserId(
  value
) {
  const userId =
    String(value || "")
      .trim();

  if (!userId) {
    throw serviceError(
      "Authenticated user is required.",
      401
    );
  }

  return userId;
}

function normalizedLimit(
  value
) {
  const parsed =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isFinite(parsed)
  ) {
    return 12;
  }

  return Math.min(
    Math.max(
      parsed,
      1
    ),
    50
  );
}

async function accessibleApp(
  userId,
  appId
) {
  const result =
    await dbQuery(
      `
        SELECT
          app.id,
          app.name,
          app.domain,
          app.status
        FROM apps app
        INNER JOIN app_memberships membership
          ON membership.app_id = app.id
         AND membership.user_id = $1
         AND membership.status = 'active'
        WHERE app.id = $2
          AND app.status = 'active'
        LIMIT 1
      `,
      [
        userId,
        appId,
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function recordAppOpen({
  userId,
  appId,
}) {
  const safeUserId =
    normalizedUserId(
      userId
    );

  const safeAppId =
    normalizedAppId(
      appId
    );

  const app =
    await accessibleApp(
      safeUserId,
      safeAppId
    );

  if (!app) {
    throw serviceError(
      "Application is unavailable or not assigned to this user.",
      404
    );
  }

  const eventId =
    identifier(
      "usageevt"
    );

  const requestId =
    identifier(
      "appopen"
    );

  const result =
    await dbQuery(
      `
        INSERT INTO backend_usage_events (
          id,
          metric_key,
          category,
          source,
          quantity,
          unit,
          user_id,
          route,
          method,
          status_code,
          request_id,
          metadata_json
        )
        VALUES (
          $1,
          'app.opened',
          'application',
          'goodos-console',
          1,
          'count',
          $2,
          $3,
          'POST',
          200,
          $4,
          $5::jsonb
        )
        RETURNING
          id,
          created_at AS "openedAt"
      `,
      [
        eventId,
        safeUserId,
        `/apps/${app.id}/open`,
        requestId,
        JSON.stringify({
          appId:
            app.id,
          appName:
            app.name,
          domain:
            app.domain,
        }),
      ]
    );

  return {
    source:
      "backend_usage_events",
    event: {
      id:
        result.rows[0].id,
      appId:
        app.id,
      openedAt:
        result.rows[0].openedAt,
    },
  };
}

async function getRecentApps({
  userId,
  limit = 12,
}) {
  const safeUserId =
    normalizedUserId(
      userId
    );

  const safeLimit =
    normalizedLimit(
      limit
    );

  const result =
    await dbQuery(
      `
        WITH ranked_events AS (
          SELECT
            event.metadata_json ->> 'appId'
              AS app_id,
            event.created_at,
            ROW_NUMBER() OVER (
              PARTITION BY
                event.metadata_json ->> 'appId'
              ORDER BY
                event.created_at DESC
            ) AS recent_rank
          FROM backend_usage_events event
          WHERE event.user_id = $1
            AND event.metric_key = 'app.opened'
            AND event.metadata_json ? 'appId'
        )
        SELECT
          app.id AS "appId",
          app.name,
          app.domain,
          app.status,
          ranked.created_at
            AS "lastOpenedAt"
        FROM ranked_events ranked
        INNER JOIN apps app
          ON app.id = ranked.app_id
         AND app.status = 'active'
        INNER JOIN app_memberships membership
          ON membership.app_id = app.id
         AND membership.user_id = $1
         AND membership.status = 'active'
        WHERE ranked.recent_rank = 1
        ORDER BY
          ranked.created_at DESC
        LIMIT $2
      `,
      [
        safeUserId,
        safeLimit,
      ]
    );

  return {
    source:
      "backend_usage_events",
    checkedAt:
      new Date().toISOString(),
    limit:
      safeLimit,
    counts: {
      returned:
        result.rows.length,
    },
    recentApps:
      result.rows,
  };
}

module.exports = {
  getRecentApps,
  recordAppOpen,
};

/* END GOODOS_RECENT_APPS_LIVE_V1 */
