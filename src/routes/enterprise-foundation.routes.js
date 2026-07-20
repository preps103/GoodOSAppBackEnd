/* GOODOS_ENTERPRISE_FOUNDATION_V1 */

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const enterprise =
  require("../enterprise/enterprise-foundation.service");

const enterpriseReadiness =
  require("../enterprise/enterprise-readiness.service");

const router =
  express.Router();

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

      requestId:
        res.req.requestId ||
        null,

      traceId:
        res.req.traceId ||
        null,
    });
}

router.get(
  "/health",
  (
    req,
    res
  ) => {
    return success(res, {
      service:
        "GoodOS Enterprise Foundation",

      status:
        "ok",

      version:
        "1.0.0",

      requestId:
        req.requestId,

      traceId:
        req.traceId,

      timestamp:
        new Date()
          .toISOString(),
    });
  }
);

router.get(
  "/ready",
  async (
    req,
    res
  ) => {
    try {
      const readiness =
        await enterprise
          .runDependencyChecks({
            persist: false,
          });

      const statusCode =
        readiness.status ===
        "ready"
          ? 200
          : readiness.status ===
            "degraded"
          ? 200
          : 503;

      return res
        .status(statusCode)
        .json({
          success:
            readiness.status !==
            "down",

          status:
            readiness.status,

          checkedAt:
            readiness.checkedAt,

          checks:
            readiness.checks.map(
              check => ({
                name:
                  check.name,

                type:
                  check.type,

                critical:
                  check.critical,

                status:
                  check.status,

                latencyMs:
                  check.latencyMs,

                message:
                  check.message,
              })
            ),

          requestId:
            req.requestId,

          traceId:
            req.traceId,
        });
    } catch (error) {
      return failure(
        res,
        error,
        "Enterprise readiness check failed."
      );
    }
  }
);

router.use(
  authRequired
);

router.use(
  async (
    req,
    res,
    next
  ) => {
    try {
      const result =
        await enterprise.dbQuery(
          `
            SELECT
              membership.role
                AS "organizationRole",

              account.platform_role
                AS "platformRole"

            FROM users account

            LEFT JOIN backend_organization_memberships
                      membership
              ON membership.user_id =
                 account.id

             AND membership.status =
                 'active'

            WHERE account.id =
                  $1::uuid

              AND account.status =
                  'active'

            ORDER BY
              CASE membership.role
                WHEN 'owner' THEN 1
                WHEN 'admin' THEN 2
                ELSE 3
              END

            LIMIT 1
          `,
          [
            req.user.id,
          ]
        );

      const access =
        result.rows[0];

      const allowed =
        [
          "owner",
          "admin",
        ].includes(
          access
            ?.organizationRole
        ) ||
        [
          "owner",
          "admin",
        ].includes(
          access
            ?.platformRole
        );

      if (!allowed) {
        return res
          .status(403)
          .json({
            success: false,

            message:
              "Owner or administrator access is required.",

            requestId:
              req.requestId,

            traceId:
              req.traceId,
          });
      }

      next();
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/overview",
  async (
    req,
    res,
    next
  ) => {
    try {
      const overview =
        await enterprise
          .getEnterpriseOverview();

      return success(
        res,
        overview
      );
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/readiness-program",
  async (
    req,
    res,
    next
  ) => {
    try {
      const report =
        await enterpriseReadiness
          .assessEnterpriseReadiness();

      return success(
        res,
        report
      );
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/dependencies",
  async (
    req,
    res,
    next
  ) => {
    try {
      const readiness =
        await enterprise
          .runDependencyChecks({
            persist: true,
          });

      return success(
        res,
        readiness
      );
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/metrics",
  async (
    req,
    res,
    next
  ) => {
    try {
      const overview =
        await enterprise
          .getEnterpriseOverview();

      return success(res, {
        service:
          overview.service,

        metrics24Hours:
          overview.metrics24Hours,

        slos:
          overview.slos,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/metrics/prometheus",
  async (
    req,
    res,
    next
  ) => {
    try {
      const metrics =
        await enterprise
          .getPrometheusMetrics();

      res.type(
        "text/plain; version=0.0.4; charset=utf-8"
      );

      return res.send(
        metrics
      );
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/backups",
  async (
    req,
    res,
    next
  ) => {
    try {
      const result =
        await enterprise.dbQuery(
          `
            SELECT
              id,

              backup_type
                AS "backupType",

              storage_type
                AS "storageType",

              file_path
                AS "filePath",

              file_name
                AS "fileName",

              size_bytes
                AS "sizeBytes",

              checksum_sha256
                AS "checksumSha256",

              database_name
                AS "databaseName",

              started_at
                AS "startedAt",

              completed_at
                AS "completedAt",

              status,

              retention_until
                AS "retentionUntil",

              metadata_json
                AS metadata,

              created_at
                AS "createdAt"

            FROM backend_backup_inventory

            ORDER BY
              created_at DESC

            LIMIT 200
          `
        );

      return success(res, {
        backups:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/restore-verifications",
  async (
    req,
    res,
    next
  ) => {
    try {
      const result =
        await enterprise.dbQuery(
          `
            SELECT
              id,

              backup_inventory_id
                AS "backupInventoryId",

              verification_type
                AS "verificationType",

              target_environment
                AS "targetEnvironment",

              status,

              rpo_minutes
                AS "rpoMinutes",

              rto_minutes
                AS "rtoMinutes",

              started_at
                AS "startedAt",

              completed_at
                AS "completedAt",

              notes,

              evidence_json
                AS evidence,

              created_at
                AS "createdAt"

            FROM backend_restore_verifications

            ORDER BY
              created_at DESC

            LIMIT 200
          `
        );

      return success(res, {
        restoreVerifications:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports =
  router;
