/* GOODOS_SETTINGS_LIVE_V1 */

const express =
  require("express");
const multer =
  require("multer");

const authRequired =
  require("../middleware/authRequired");

const database =
  require("../config/database");

const {
  success,
  error
} = require("../utils/response");

const settingsService =
  require("../services/settings.service");

const router =
  express.Router();

const avatarUpload = multer({
  storage:
    multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize:
      2 * 1024 * 1024
  }
});

function receiveAvatar(
  req,
  res,
  next
) {
  avatarUpload.single("avatar")(
    req,
    res,
    uploadError => {
      if (!uploadError) {
        return next();
      }

      if (
        uploadError.code ===
        "LIMIT_FILE_SIZE"
      ) {
        return error(
          res,
          "Profile photos must be 2 MB or smaller.",
          413
        );
      }

      return error(
        res,
        uploadError.message ||
          "Profile photo upload failed.",
        400
      );
    }
  );
}

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

function sendFailure(
  res,
  requestError,
  fallback
) {
  console.error(
    fallback,
    requestError
  );

  return error(
    res,
    requestError.message ||
      fallback,
    requestError.statusCode ||
      500
  );
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
                'public.backend_user_preferences'
              ) IS NOT NULL
                AS preferences_ready,

              to_regclass(
                'public.backend_workspace_settings'
              ) IS NOT NULL
                AS workspace_ready,

              to_regclass(
                'public.backend_settings_export_requests'
              ) IS NOT NULL
                AS exports_ready,

              EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE
                  table_schema = 'public'
                  AND table_name = 'users'
                  AND column_name = 'avatar_url'
              ) AS avatar_ready
          `
        );

      const row =
        result.rows[0] || {};

      return success(
        res,
        {
          service:
            "GoodOS Settings",
          status:
            "ok",
          schemaReady:
            Boolean(
              row.preferences_ready &&
              row.workspace_ready &&
              row.exports_ready &&
              row.avatar_ready
            ),
          avatarReady:
            Boolean(
              row.avatar_ready
            )
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Settings health check failed"
      );
    }
  }
);

router.get(
  "/avatars/:userId",
  async (
    req,
    res
  ) => {
    try {
      const avatar =
        await settingsService
          .getAvatarForPublicUser(
            req.params.userId
          );

      res.set({
        "Content-Type":
          avatar.contentType,
        "Content-Length":
          String(
            avatar.sizeBytes
          ),
        "Cache-Control":
          "public, max-age=31536000, immutable",
        "X-Content-Type-Options":
          "nosniff",
        "Cross-Origin-Resource-Policy":
          "cross-origin"
      });

      return res.sendFile(
        avatar.filePath
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Profile avatar was not found"
      );
    }
  }
);

router.use(
  authRequired
);

router.post(
  "/avatar",
  receiveAvatar,
  async (
    req,
    res
  ) => {
    try {
      const profile =
        await settingsService
          .saveAvatarForUser({
            userId:
              req.user.id,
            buffer:
              req.file?.buffer,
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          profile,
          message:
            "Profile photo saved."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to save profile photo"
      );
    }
  }
);

router.delete(
  "/avatar",
  async (
    req,
    res
  ) => {
    try {
      const profile =
        await settingsService
          .removeAvatarForUser({
            userId:
              req.user.id,
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          profile,
          message:
            "Profile photo removed."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to remove profile photo"
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
      const overview =
        await settingsService
          .getOverviewForUser({
            userId:
              req.user.id,
            currentSessionId:
              req.auth.sessionId
          });

      return success(
        res,
        overview
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to load Settings"
      );
    }
  }
);

router.patch(
  "/profile",
  async (
    req,
    res
  ) => {
    try {
      const profile =
        await settingsService
          .updateProfileForUser({
            userId:
              req.user.id,
            input:
              req.body || {},
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          profile,
          message:
            "Account profile saved."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to update account profile"
      );
    }
  }
);

router.patch(
  "/preferences",
  async (
    req,
    res
  ) => {
    try {
      const preferences =
        await settingsService
          .updatePreferencesForUser({
            userId:
              req.user.id,
            input:
              req.body || {},
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          preferences,
          message:
            "Preferences saved."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to save preferences"
      );
    }
  }
);

router.delete(
  "/preferences",
  async (
    req,
    res
  ) => {
    try {
      const preferences =
        await settingsService
          .resetPreferencesForUser({
            userId:
              req.user.id,
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          preferences,
          message:
            "Preferences reset to defaults."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to reset preferences"
      );
    }
  }
);

router.patch(
  "/workspace",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await settingsService
          .updateWorkspaceForUser({
            userId:
              req.user.id,
            platformRole:
              req.user.platformRole,
            input:
              req.body || {},
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          ...result,
          message:
            "Workspace settings saved."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to update workspace"
      );
    }
  }
);

router.post(
  "/password",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await settingsService
          .changePasswordForUser({
            userId:
              req.user.id,
            currentSessionId:
              req.auth.sessionId,
            currentPassword:
              req.body
                ?.currentPassword,
            newPassword:
              req.body
                ?.newPassword,
            ipAddress:
              req.ip
          });

      return success(
        res,
        result
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to update password"
      );
    }
  }
);

router.delete(
  "/sessions/:sessionId",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await settingsService
          .revokeUserSession({
            userId:
              req.user.id,
            currentSessionId:
              req.auth.sessionId,
            targetSessionId:
              String(
                req.params
                  .sessionId || ""
              ),
            ipAddress:
              req.ip
          });

      return success(
        res,
        {
          session:
            result,
          message:
            "Session revoked."
        }
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to revoke session"
      );
    }
  }
);

router.post(
  "/export",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await settingsService
          .createSettingsExport({
            userId:
              req.user.id,
            currentSessionId:
              req.auth.sessionId,
            ipAddress:
              req.ip
          });

      return success(
        res,
        result
      );
    } catch (
      requestError
    ) {
      return sendFailure(
        res,
        requestError,
        "Failed to export Settings data"
      );
    }
  }
);

module.exports =
  router;
