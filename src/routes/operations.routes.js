"use strict";

const crypto =
  require("crypto");

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const {
  query,
} = require("../config/database");

const router =
  express.Router();

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

function actorId(
  request
) {
  return (
    request.user?.id ||
    request.auth?.userId ||
    request.auth?.sub ||
    null
  );
}

async function operationsAdminRequired(
  request,
  response,
  next
) {
  try {
    const userId =
      actorId(request);

    const organizationId =
      request.tenantContext
        ?.organizationId;

    const result =
      await query(
        `
          SELECT
            account.platform_role,
            membership.role
              AS membership_role

          FROM users AS account

          JOIN backend_organization_memberships
               AS membership
            ON membership.user_id =
               account.id

          WHERE account.id =
                $1::uuid

            AND membership.organization_id =
                $2

            AND account.status =
                'active'

            AND membership.status =
                'active'

          LIMIT 1
        `,
        [
          userId,
          organizationId,
        ]
      );

    const identity =
      result.rows[0];

    const allowed =
      identity &&
      (
        [
          "owner",
          "admin",
        ].includes(
          identity.platform_role
        )
        ||
        [
          "owner",
          "admin",
        ].includes(
          identity.membership_role
        )
      );

    if (!allowed) {
      return response
        .status(403)
        .json({
          success: false,
          code:
            "OPERATIONS_ADMIN_REQUIRED",
          message:
            "Operations administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

router.use(
  authRequired,
  tenantContext,
  operationsAdminRequired
);


router.get(
  "/summary",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const [
        policyResult,
        checksResult,
        incidentResult,
        backupResult,
      ] =
        await Promise.all([
          query(
            `
              SELECT
                organization_id
                  AS "organizationId",

                backup_warning_hours
                  AS "backupWarningHours",

                backup_critical_hours
                  AS "backupCriticalHours",

                worker_heartbeat_max_seconds
                  AS "workerHeartbeatMaxSeconds",

                disk_warning_percent
                  AS "diskWarningPercent",

                disk_critical_percent
                  AS "diskCriticalPercent",

                error_rate_warning_percent
                  AS "errorRateWarningPercent",

                error_rate_critical_percent
                  AS "errorRateCriticalPercent",

                operations_check_retention_days
                  AS "operationsCheckRetentionDays",

                incident_auto_create
                  AS "incidentAutoCreate",

                updated_at
                  AS "updatedAt"

              FROM backend_operations_policies

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT DISTINCT ON (
                check_key
              )
                id,
                check_key
                  AS "checkKey",
                category,
                status,
                message,
                duration_ms
                  AS "durationMs",
                evidence_json
                  AS evidence,
                checked_at
                  AS "checkedAt"

              FROM backend_operations_checks

              WHERE organization_id =
                    $1

              ORDER BY
                check_key,
                checked_at DESC
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                COUNT(*) FILTER (
                  WHERE status IN (
                    'open',
                    'investigating',
                    'monitoring'
                  )
                )::int
                  AS "openIncidents",

                COUNT(*) FILTER (
                  WHERE severity =
                        'critical'
                    AND status IN (
                      'open',
                      'investigating',
                      'monitoring'
                    )
                )::int
                  AS "criticalIncidents"

              FROM backend_incidents

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT MAX(completed_at)
                       AS "completedAt"

              FROM (
                SELECT
                  COALESCE(
                    verified_at,
                    created_at
                  ) AS completed_at

                FROM backend_database_backups

                WHERE status =
                      'completed'

                UNION ALL

                SELECT
                  COALESCE(
                    completed_at,
                    created_at
                  ) AS completed_at

                FROM backend_backup_inventory

                WHERE status =
                      'completed'
              ) AS completed_backups
            `
          ),
        ]);

      response.json({
        success: true,
        organizationId,
        policy:
          policyResult.rows[0] ||
          null,
        checks:
          checksResult.rows,
        incidents:
          incidentResult.rows[0],
        latestBackup:
          backupResult.rows[0]
            ?.completedAt ||
          null,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/checks",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              id,
              check_key
                AS "checkKey",
              category,
              status,
              message,
              duration_ms
                AS "durationMs",
              evidence_json
                AS evidence,
              checked_at
                AS "checkedAt"

            FROM backend_operations_checks

            WHERE organization_id =
                  $1

            ORDER BY
              checked_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        checks:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/incidents",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              id,
              title,
              description,
              severity,
              status,
              source,
              source_id
                AS "sourceId",
              acknowledged_by
                AS "acknowledgedBy",
              acknowledged_at
                AS "acknowledgedAt",
              resolved_by
                AS "resolvedBy",
              resolved_at
                AS "resolvedAt",
              resolution_notes
                AS "resolutionNotes",
              metadata_json
                AS metadata,
              opened_at
                AS "openedAt",
              updated_at
                AS "updatedAt"

            FROM backend_incidents

            WHERE organization_id =
                  $1

            ORDER BY
              opened_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        incidents:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/incidents",
  async (
    request,
    response,
    next
  ) => {
    try {
      const title =
        String(
          request.body?.title ||
          ""
        )
        .trim()
        .slice(0, 500);

      const severity =
        String(
          request.body?.severity ||
          "warning"
        )
        .trim();

      if (!title) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Incident title is required.",
          });
      }

      if (
        ![
          "info",
          "warning",
          "critical",
        ].includes(severity)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid incident severity.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_incidents (
              id,
              organization_id,
              project_id,
              environment_id,
              title,
              description,
              severity,
              status,
              source,
              source_id,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'open',
              'manual',
              $8,
              $9::jsonb
            )
            RETURNING
              id,
              title,
              severity,
              status,
              opened_at
                AS "openedAt"
          `,
          [
            identifier("incident"),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            title,
            String(
              request.body
                ?.description || ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
            severity,
            String(
              request.body
                ?.sourceId || ""
            )
            .trim()
            .slice(0, 500) ||
              null,
            JSON.stringify(
              request.body
                ?.metadata || {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          incident:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.patch(
  "/incidents/:incidentId",
  async (
    request,
    response,
    next
  ) => {
    try {
      const status =
        String(
          request.body?.status ||
          ""
        )
        .trim();

      if (
        ![
          "open",
          "investigating",
          "monitoring",
          "resolved",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid incident status.",
          });
      }

      const userId =
        actorId(request);

      const result =
        await query(
          `
            UPDATE backend_incidents
            SET
              status =
                $3,

              acknowledged_by =
                CASE
                  WHEN $3 IN (
                    'investigating',
                    'monitoring',
                    'resolved'
                  )
                  THEN COALESCE(
                    acknowledged_by,
                    $4::uuid
                  )
                  ELSE acknowledged_by
                END,

              acknowledged_at =
                CASE
                  WHEN $3 IN (
                    'investigating',
                    'monitoring',
                    'resolved'
                  )
                  THEN COALESCE(
                    acknowledged_at,
                    NOW()
                  )
                  ELSE acknowledged_at
                END,

              resolved_by =
                CASE
                  WHEN $3 =
                       'resolved'
                  THEN $4::uuid
                  ELSE NULL
                END,

              resolved_at =
                CASE
                  WHEN $3 =
                       'resolved'
                  THEN NOW()
                  ELSE NULL
                END,

              resolution_notes =
                CASE
                  WHEN $3 =
                       'resolved'
                  THEN $5
                  ELSE resolution_notes
                END,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              title,
              severity,
              status,
              acknowledged_at
                AS "acknowledgedAt",
              resolved_at
                AS "resolvedAt",
              resolution_notes
                AS "resolutionNotes",
              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .incidentId,
            request.tenantContext
              .organizationId,
            status,
            userId,
            String(
              request.body
                ?.resolutionNotes || ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Incident was not found.",
          });
      }

      response.json({
        success: true,
        incident:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports =
  router;
