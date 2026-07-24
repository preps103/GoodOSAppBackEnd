/* GOODOS_NOTIFICATION_CENTER_V1 */

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const database =
  require("../config/database");

const notificationCenter =
  require("../services/notification-center.service");

const router =
  express.Router();

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

function success(
  res,
  data = {}
) {
  return res.json({
    success: true,
    ...data,
  });
}

function failure(
  res,
  error,
  fallback
) {
  console.error(
    fallback,
    error
  );

  return res
    .status(
      error.statusCode ||
      500
    )
    .json({
      success: false,
      message:
        error.message ||
        fallback,
    });
}

router.get(
  "/health",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await dbQuery(
          `
            SELECT
              to_regclass(
                'public.backend_notifications'
              ) IS NOT NULL
                AS notifications_ready,

              to_regclass(
                'public.backend_notification_channels'
              ) IS NOT NULL
                AS channels_ready,

              to_regclass(
                'public.backend_notification_templates'
              ) IS NOT NULL
                AS templates_ready,

              to_regclass(
                'public.backend_notification_queue'
              ) IS NOT NULL
                AS queue_ready,

              to_regclass(
                'public.backend_notification_preferences'
              ) IS NOT NULL
                AS preferences_ready
          `
        );

      const row =
        result.rows[0] || {};

      return success(res, {
        service:
          "GoodOS Notification Center",
        status: "ok",

        schemaReady:
          Boolean(
            row.notifications_ready &&
            row.channels_ready &&
            row.templates_ready &&
            row.queue_ready &&
            row.preferences_ready
          ),
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Notification Center health check failed."
      );
    }
  }
);

router.use(
  authRequired
);

/*
 * Product applications must use the /apps/:appId routes below.
 * The unscoped routes that follow are reserved for the GoodOS master
 * Notification Center, which may aggregate the user's assigned apps.
 */
router.get(
  "/apps/:appId/overview",
  async (
    req,
    res
  ) => {
    try {
      const data =
        await notificationCenter
          .getApplicationOverviewForUser(
            req.user.id,
            String(
              req.params.appId
            ),
            req.query || {}
          );

      return success(
        res,
        data
      );
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to load application notifications."
      );
    }
  }
);

router.patch(
  "/apps/:appId/:notificationId/read",
  async (
    req,
    res
  ) => {
    try {
      const notification =
        await notificationCenter
          .updateReadStateForUser(
            req.user.id,
            String(
              req.params
                .notificationId
            ),
            req.body?.read !==
              false,
            {
              ipAddress:
                req.ip,
            },
            String(
              req.params.appId
            )
          );

      return success(res, {
        notification,
        message:
          req.body?.read === false
            ? "Notification marked unread."
            : "Notification marked read.",
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to update application notification."
      );
    }
  }
);

router.post(
  "/apps/:appId/read-all",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await notificationCenter
          .markAllReadForUser(
            req.user.id,
            {
              ipAddress:
                req.ip,
            },
            String(
              req.params.appId
            )
          );

      return success(res, {
        ...result,
        message:
          result.updated === 1
            ? "1 notification marked read."
            : `${result.updated} notifications marked read.`,
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to mark application notifications read."
      );
    }
  }
);

router.delete(
  "/apps/:appId/:notificationId",
  async (
    req,
    res
  ) => {
    try {
      const notification =
        await notificationCenter
          .archiveNotificationForUser(
            req.user.id,
            String(
              req.params
                .notificationId
            ),
            {
              ipAddress:
                req.ip,
            },
            String(
              req.params.appId
            )
          );

      return success(res, {
        notification,
        message:
          "Notification archived.",
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to archive application notification."
      );
    }
  }
);

router.post(
  "/apps/:appId/archive-read",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await notificationCenter
          .archiveReadForUser(
            req.user.id,
            {
              ipAddress:
                req.ip,
            },
            String(
              req.params.appId
            )
          );

      return success(res, {
        ...result,
        message:
          result.archived === 1
            ? "1 read notification archived."
            : `${result.archived} read notifications archived.`,
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to archive read application notifications."
      );
    }
  }
);

router.get(
  "/overview",
  async (
    req,
    res
  ) => {
    try {
      const data =
        await notificationCenter
          .getOverviewForUser(
            req.user.id,
            req.query || {}
          );

      return success(
        res,
        data
      );
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to load notifications."
      );
    }
  }
);

router.patch(
  "/:notificationId/read",
  async (
    req,
    res
  ) => {
    try {
      const notification =
        await notificationCenter
          .updateReadStateForUser(
            req.user.id,
            String(
              req.params
                .notificationId
            ),
            req.body?.read !==
              false,
            {
              ipAddress:
                req.ip,
            }
          );

      return success(res, {
        notification,
        message:
          req.body?.read === false
            ? "Notification marked unread."
            : "Notification marked read.",
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to update notification."
      );
    }
  }
);

router.post(
  "/read-all",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await notificationCenter
          .markAllReadForUser(
            req.user.id,
            {
              ipAddress:
                req.ip,
            },
            req.body?.appId ||
              "all"
          );

      return success(res, {
        ...result,
        message:
          result.updated === 1
            ? "1 notification marked read."
            : `${result.updated} notifications marked read.`,
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to mark notifications read."
      );
    }
  }
);

router.delete(
  "/:notificationId",
  async (
    req,
    res
  ) => {
    try {
      const notification =
        await notificationCenter
          .archiveNotificationForUser(
            req.user.id,
            String(
              req.params
                .notificationId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return success(res, {
        notification,
        message:
          "Notification archived.",
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to archive notification."
      );
    }
  }
);

router.post(
  "/archive-read",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await notificationCenter
          .archiveReadForUser(
            req.user.id,
            {
              ipAddress:
                req.ip,
            },
            req.body?.appId ||
              "all"
          );

      return success(res, {
        ...result,
        message:
          result.archived === 1
            ? "1 read notification archived."
            : `${result.archived} read notifications archived.`,
      });
    } catch (error) {
      return failure(
        res,
        error,
        "Failed to archive read notifications."
      );
    }
  }
);

module.exports =
  router;
