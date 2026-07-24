/* GOODOS_NOTIFICATION_CENTER_V1 */

const database =
  require("../config/database");

const {
  logAudit,
} = require("./audit.service");

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

  throw new Error(
    "Database query function not found"
  );
}

function serviceError(
  message,
  statusCode = 400
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}

function cleanText(
  value,
  maximum = 500
) {
  return String(
    value ?? ""
  )
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function positiveInteger(
  value,
  fallback,
  maximum
) {
  const parsed =
    Number.parseInt(
      String(value ?? ""),
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed < 1
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    maximum
  );
}

async function recordAudit(
  input
) {
  try {
    await logAudit(input);
  } catch (error) {
    console.error(
      "Notification audit failed:",
      error.message
    );
  }
}

async function requireContext(
  userId
) {
  const result =
    await dbQuery(
      `
        SELECT
          account.id
            AS "userId",

          account.email,

          organization.id
            AS "organizationId",

          organization.name
            AS "organizationName",

          membership.role
            AS "organizationRole"

        FROM users account

        JOIN backend_organization_memberships
             membership
          ON membership.user_id =
             account.id

        JOIN backend_organizations
             organization
          ON organization.id =
             membership.organization_id

        WHERE account.id =
              $1::uuid

          AND account.status =
              'active'

          AND membership.status =
              'active'

          AND organization.status =
              'active'

        ORDER BY
          CASE membership.role
            WHEN 'owner' THEN 1
            WHEN 'admin' THEN 2
            WHEN 'manager' THEN 3
            ELSE 4
          END

        LIMIT 1
      `,
      [
        userId,
      ]
    );

  const context =
    result.rows[0];

  if (!context) {
    throw serviceError(
      "Active workspace membership is required.",
      403
    );
  }

  return context;
}

function visibilitySql(
  alias = "notification"
) {
  return `
    (
      (
        ${alias}.recipient_user_id =
          $1::uuid

        OR (
          ${alias}.recipient_user_id
            IS NULL

          AND ${alias}.recipient_email
            IS NOT NULL

          AND LOWER(
            ${alias}.recipient_email
          ) = LOWER($3)
        )

        OR (
          ${alias}.recipient_user_id
            IS NULL

          AND ${alias}.recipient_email
            IS NULL

          AND ${alias}.organization_id =
            $2
        )
      )

      AND (
        ${notificationAppIdSql(alias)}
          = 'goodos'

        OR EXISTS (
          SELECT 1

          FROM app_memberships
               app_membership

          JOIN apps
               accessible_app
            ON accessible_app.id =
               app_membership.app_id

          WHERE app_membership.user_id =
                $1::uuid

            AND app_membership.status =
                'active'

            AND accessible_app.status =
                'active'

            AND accessible_app.id =
                ${notificationAppIdSql(alias)}
        )
      )
    )
  `;
}

function notificationAppIdSql(
  alias = "notification"
) {
  return `
    COALESCE(
      NULLIF(
        ${alias}.metadata_json
          ->> 'appId',
        ''
      ),
      NULLIF(
        ${alias}.metadata_json
          ->> 'app_id',
        ''
      ),
      NULLIF(
        ${alias}.payload_json
          ->> 'appId',
        ''
      ),
      NULLIF(
        ${alias}.payload_json
          ->> 'app_id',
        ''
      ),
      'goodos'
    )
  `;
}

async function getAccessibleApps(
  userId
) {
  const result =
    await dbQuery(
      `
        SELECT
          app.id,
          app.name,
          app.domain

        FROM app_memberships
             membership

        JOIN apps app
          ON app.id =
             membership.app_id

        WHERE membership.user_id =
              $1::uuid

          AND membership.status =
              'active'

          AND app.status =
              'active'

        ORDER BY
          CASE
            WHEN app.id = 'goodos'
            THEN 0
            ELSE 1
          END,
          app.name ASC
      `,
      [
        userId,
      ]
    );

  const apps =
    result.rows;

  if (
    !apps.some(
      app =>
        app.id === "goodos"
    )
  ) {
    apps.unshift({
      id: "goodos",
      name: "GoodOS",
      domain: "goodos.app",
    });
  }

  return apps;
}

async function requireAppAccess(
  userId,
  value
) {
  const appId =
    cleanText(
      value,
      120
    ) || "all";

  if (appId === "all") {
    return appId;
  }

  const accessibleApps =
    await getAccessibleApps(
      userId
    );

  if (
    !accessibleApps.some(
      app =>
        app.id === appId
    )
  ) {
    throw serviceError(
      "This application is unavailable or is not assigned to this user.",
      403
    );
  }

  return appId;
}

async function getOverviewForUser(
  userId,
  query = {}
) {
  const context =
    await requireContext(
      userId
    );

  const page =
    positiveInteger(
      query.page,
      1,
      100000
    );

  const limit =
    positiveInteger(
      query.limit,
      20,
      100
    );

  const offset =
    (page - 1) * limit;

  const status =
    [
      "all",
      "unread",
      "read",
    ].includes(
      cleanText(
        query.status,
        20
      )
    )
      ? cleanText(
          query.status,
          20
        )
      : "all";

  const category =
    cleanText(
      query.category,
      100
    ) || "all";

  const severity =
    cleanText(
      query.severity,
      40
    ) || "all";

  const search =
    cleanText(
      query.search,
      200
    );

  const appId =
    cleanText(
      query.appId,
      120
    ) || "all";

  const accessibleApps =
    await getAccessibleApps(
      userId
    );

  if (
    appId !== "all" &&
    !accessibleApps.some(
      app =>
        app.id === appId
    )
  ) {
    throw serviceError(
      "This application is unavailable or is not assigned to this user.",
      403
    );
  }

  const includeArchived =
    String(
      query.includeArchived ||
      ""
    ).toLowerCase() ===
    "true";

  const params = [
    userId,
    context.organizationId,
    context.email,
    status,
    category,
    severity,
    search,
    appId,
    includeArchived,
    limit,
    offset,
  ];

  const filteredWhere = `
    ${visibilitySql("notification")}

    AND (
      $4 = 'all'

      OR (
        $4 = 'unread'

        AND notification.read_at
          IS NULL

        AND notification.status =
          'unread'
      )

      OR (
        $4 = 'read'

        AND (
          notification.read_at
            IS NOT NULL

          OR notification.status <>
            'unread'
        )
      )
    )

    AND (
      $5 = 'all'
      OR notification.category =
         $5
    )

    AND (
      $6 = 'all'
      OR notification.severity =
         $6
    )

    AND (
      $7 = ''

      OR notification.title
           ILIKE '%' || $7 || '%'

      OR COALESCE(
           notification.message,
           ''
         )
         ILIKE '%' || $7 || '%'

      OR COALESCE(
           notification.source,
           ''
         )
         ILIKE '%' || $7 || '%'
    )

    AND (
      $8 = 'all'
      OR ${notificationAppIdSql(
        "notification"
      )} = $8
    )

    AND (
      $9::boolean = TRUE
      OR notification.archived_at
         IS NULL
    )
  `;

  const [
    notificationsResult,
    totalResult,
    statsResult,
    categoriesResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          notification.id,

          notification.notification_key
            AS "notificationKey",

          notification.category,
          notification.channel,
          notification.title,
          notification.message,
          notification.severity,
          notification.status,

          notification.source,

          notification.source_id
            AS "sourceId",

          ${notificationAppIdSql(
            "notification"
          )} AS "appId",

          COALESCE(
            notification_app.name,
            'GoodOS'
          ) AS "appName",

          COALESCE(
            notification_app.domain,
            'goodos.app'
          ) AS "appDomain",

          notification.action_url
            AS "actionUrl",

          notification.payload_json
            AS "payload",

          notification.metadata_json
            AS "metadata",

          notification.read_at
            AS "readAt",

          notification.archived_at
            AS "archivedAt",

          notification.created_at
            AS "createdAt",

          notification.updated_at
            AS "updatedAt",

          (
            notification.read_at
              IS NOT NULL

            OR notification.status <>
              'unread'
          ) AS "isRead"

        FROM backend_notifications
             notification

        LEFT JOIN apps
             notification_app
          ON notification_app.id =
             ${notificationAppIdSql(
               "notification"
             )}

        WHERE ${filteredWhere}

        ORDER BY
          CASE
            WHEN notification.read_at
                 IS NULL
             AND notification.status =
                 'unread'
            THEN 0
            ELSE 1
          END,

          notification.created_at
            DESC

        LIMIT $10
        OFFSET $11
      `,
      params
    ),

    dbQuery(
      `
        SELECT
          COUNT(*)::int
            AS total

        FROM backend_notifications
             notification

        WHERE ${filteredWhere}
      `,
      params.slice(
        0,
        9
      )
    ),

    dbQuery(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE notification.archived_at
                  IS NULL
          )::int AS total,

          COUNT(*) FILTER (
            WHERE notification.archived_at
                  IS NULL

              AND notification.read_at
                  IS NULL

              AND notification.status =
                  'unread'
          )::int AS unread,

          COUNT(*) FILTER (
            WHERE notification.archived_at
                  IS NULL

              AND (
                notification.read_at
                  IS NOT NULL

                OR notification.status <>
                  'unread'
              )
          )::int AS read,

          COUNT(*) FILTER (
            WHERE notification.archived_at
                  IS NOT NULL
          )::int AS archived

        FROM backend_notifications
             notification

        WHERE ${visibilitySql(
          "notification"
        )}

          AND (
            $4 = 'all'
            OR ${notificationAppIdSql(
              "notification"
            )} = $4
          )
      `,
      [
        userId,
        context.organizationId,
        context.email,
        appId,
      ]
    ),

    dbQuery(
      `
        SELECT DISTINCT
          notification.category

        FROM backend_notifications
             notification

        WHERE ${visibilitySql(
          "notification"
        )}

          AND notification.archived_at
              IS NULL

          AND (
            $4 = 'all'
            OR ${notificationAppIdSql(
              "notification"
            )} = $4
          )

        ORDER BY
          notification.category
      `,
      [
        userId,
        context.organizationId,
        context.email,
        appId,
      ]
    ),
  ]);

  const total =
    Number(
      totalResult.rows[0]
        ?.total || 0
    );

  return {
    organization: {
      id:
        context.organizationId,
      name:
        context.organizationName,
      role:
        context.organizationRole,
    },

    notifications:
      notificationsResult.rows,

    stats: {
      total:
        Number(
          statsResult.rows[0]
            ?.total || 0
        ),

      unread:
        Number(
          statsResult.rows[0]
            ?.unread || 0
        ),

      read:
        Number(
          statsResult.rows[0]
            ?.read || 0
        ),

      archived:
        Number(
          statsResult.rows[0]
            ?.archived || 0
        ),
    },

    filters: {
      apps:
        accessibleApps,

      categories:
        categoriesResult.rows
          .map(
            row =>
              row.category
          )
          .filter(Boolean),

      severities: [
        "info",
        "success",
        "warning",
        "error",
        "critical",
      ],
    },

    pagination: {
      page,
      limit,
      total,

      totalPages:
        Math.max(
          1,
          Math.ceil(
            total / limit
          )
        ),
    },
  };
}

async function updateReadStateForUser(
  userId,
  notificationId,
  read,
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId
    );

  const result =
    await dbQuery(
      `
        UPDATE backend_notifications
             notification

        SET
          status =
            CASE
              WHEN $5::boolean
              THEN 'read'
              ELSE 'unread'
            END,

          read_at =
            CASE
              WHEN $5::boolean
              THEN COALESCE(
                notification.read_at,
                NOW()
              )
              ELSE NULL
            END,

          updated_at =
            NOW()

        WHERE notification.id =
              $4

          AND notification.archived_at
              IS NULL

          AND ${visibilitySql(
            "notification"
          )}

        RETURNING
          notification.id,
          notification.status,

          notification.read_at
            AS "readAt",

          notification.updated_at
            AS "updatedAt"
      `,
      [
        userId,
        context.organizationId,
        context.email,
        notificationId,
        Boolean(read),
      ]
    );

  const notification =
    result.rows[0];

  if (!notification) {
    throw serviceError(
      "Notification was not found.",
      404
    );
  }

  await recordAudit({
    userId,
    appId: "goodos",
    action:
      read
        ? "notification.read"
        : "notification.unread",
    entityType:
      "notification",
    entityId:
      notificationId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
    },
  });

  return notification;
}

async function markAllReadForUser(
  userId,
  requestMeta = {},
  requestedAppId = "all"
) {
  const context =
    await requireContext(
      userId
    );

  const appId =
    await requireAppAccess(
      userId,
      requestedAppId
    );

  const result =
    await dbQuery(
      `
        UPDATE backend_notifications
             notification

        SET
          status = 'read',
          read_at =
            COALESCE(
              notification.read_at,
              NOW()
            ),
          updated_at = NOW()

        WHERE notification.archived_at
              IS NULL

          AND notification.read_at
              IS NULL

          AND notification.status =
              'unread'

          AND ${visibilitySql(
            "notification"
          )}

          AND (
            $4 = 'all'
            OR ${notificationAppIdSql(
              "notification"
            )} = $4
          )

        RETURNING notification.id
      `,
      [
        userId,
        context.organizationId,
        context.email,
        appId,
      ]
    );

  await recordAudit({
    userId,
    appId: "goodos",
    action:
      "notification.read_all",
    entityType:
      "notification",
    entityId: null,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      appId,
      updated:
        result.rowCount,
    },
  });

  return {
    updated:
      result.rowCount,
  };
}

async function archiveNotificationForUser(
  userId,
  notificationId,
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId
    );

  const result =
    await dbQuery(
      `
        UPDATE backend_notifications
             notification

        SET
          archived_at = NOW(),
          updated_at = NOW()

        WHERE notification.id =
              $4

          AND notification.archived_at
              IS NULL

          AND ${visibilitySql(
            "notification"
          )}

        RETURNING
          notification.id,

          notification.archived_at
            AS "archivedAt"
      `,
      [
        userId,
        context.organizationId,
        context.email,
        notificationId,
      ]
    );

  const notification =
    result.rows[0];

  if (!notification) {
    throw serviceError(
      "Notification was not found.",
      404
    );
  }

  await recordAudit({
    userId,
    appId: "goodos",
    action:
      "notification.archived",
    entityType:
      "notification",
    entityId:
      notificationId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
    },
  });

  return notification;
}

async function archiveReadForUser(
  userId,
  requestMeta = {},
  requestedAppId = "all"
) {
  const context =
    await requireContext(
      userId
    );

  const appId =
    await requireAppAccess(
      userId,
      requestedAppId
    );

  const result =
    await dbQuery(
      `
        UPDATE backend_notifications
             notification

        SET
          archived_at = NOW(),
          updated_at = NOW()

        WHERE notification.archived_at
              IS NULL

          AND (
            notification.read_at
              IS NOT NULL

            OR notification.status <>
              'unread'
          )

          AND ${visibilitySql(
            "notification"
          )}

          AND (
            $4 = 'all'
            OR ${notificationAppIdSql(
              "notification"
            )} = $4
          )

        RETURNING notification.id
      `,
      [
        userId,
        context.organizationId,
        context.email,
        appId,
      ]
    );

  await recordAudit({
    userId,
    appId: "goodos",
    action:
      "notification.archive_read",
    entityType:
      "notification",
    entityId: null,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      appId,
      archived:
        result.rowCount,
    },
  });

  return {
    archived:
      result.rowCount,
  };
}

module.exports = {
  getOverviewForUser,
  updateReadStateForUser,
  markAllReadForUser,
  archiveNotificationForUser,
  archiveReadForUser,
};
