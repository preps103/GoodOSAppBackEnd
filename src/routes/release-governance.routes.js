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
} =
  require("../config/database");

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

async function releaseAdminRequired(
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

          FROM users
               AS account

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
            "RELEASE_ADMIN_REQUIRED",
          message:
            "Release governance requires owner or administrator access.",
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
  releaseAdminRequired
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
        policy,
        releaseCounts,
        changeCounts,
        flagCounts,
        migrationCounts,
        recentReleases,
      ] =
        await Promise.all([
          query(
            `
              SELECT
                approval_required
                  AS "approvalRequired",

                operations_health_required
                  AS "operationsHealthRequired",

                fresh_backup_required
                  AS "freshBackupRequired",

                backup_max_age_hours
                  AS "backupMaxAgeHours",

                clean_git_required
                  AS "cleanGitRequired",

                dirty_baseline_allowed
                  AS "dirtyBaselineAllowed",

                source_snapshot_required
                  AS "sourceSnapshotRequired",

                schema_snapshot_required
                  AS "schemaSnapshotRequired",

                rollback_path_required
                  AS "rollbackPathRequired",

                release_retention_days
                  AS "releaseRetentionDays",

                updated_at
                  AS "updatedAt"

              FROM backend_release_policies

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                COUNT(*)::int
                  AS total,

                COUNT(*) FILTER (
                  WHERE status =
                        'deployed'
                )::int
                  AS deployed,

                COUNT(*) FILTER (
                  WHERE status =
                        'failed'
                )::int
                  AS failed,

                COUNT(*) FILTER (
                  WHERE status =
                        'rolled_back'
                )::int
                  AS "rolledBack"

              FROM backend_releases

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                COUNT(*)::int
                  AS total,

                COUNT(*) FILTER (
                  WHERE status =
                        'approved'
                )::int
                  AS approved,

                COUNT(*) FILTER (
                  WHERE status IN (
                    'draft',
                    'review'
                  )
                )::int
                  AS pending

              FROM backend_change_requests

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                COUNT(*)::int
                  AS total,

                COUNT(*) FILTER (
                  WHERE enabled
                    AND status =
                        'active'
                )::int
                  AS enabled

              FROM backend_feature_flags

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                COUNT(*)::int
                  AS total,

                COUNT(*) FILTER (
                  WHERE status =
                        'applied'
                )::int
                  AS applied,

                COUNT(*) FILTER (
                  WHERE status =
                        'observed'
                )::int
                  AS observed

              FROM backend_migration_ledger

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                id,
                version_label
                  AS "versionLabel",
                release_type
                  AS "releaseType",
                status,
                approval_status
                  AS "approvalStatus",
                backend_commit
                  AS "backendCommit",
                frontend_commit
                  AS "frontendCommit",
                backend_dirty_count
                  AS "backendDirtyCount",
                frontend_dirty_count
                  AS "frontendDirtyCount",
                rollback_path
                  AS "rollbackPath",
                manifest_path
                  AS "manifestPath",
                deployed_at
                  AS "deployedAt",
                created_at
                  AS "createdAt"

              FROM backend_releases

              WHERE organization_id =
                    $1

              ORDER BY
                created_at DESC

              LIMIT 25
            `,
            [
              organizationId,
            ]
          ),
        ]);

      response.json({
        success: true,
        organizationId,
        policy:
          policy.rows[0] ||
          null,
        releases:
          releaseCounts.rows[0],
        changeRequests:
          changeCounts.rows[0],
        featureFlags:
          flagCounts.rows[0],
        migrations:
          migrationCounts.rows[0],
        recentReleases:
          recentReleases.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/releases",
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
              change_request_id
                AS "changeRequestId",
              version_label
                AS "versionLabel",
              release_type
                AS "releaseType",
              status,
              approval_status
                AS "approvalStatus",
              backend_commit
                AS "backendCommit",
              frontend_commit
                AS "frontendCommit",
              backend_branch
                AS "backendBranch",
              frontend_branch
                AS "frontendBranch",
              backend_dirty_count
                AS "backendDirtyCount",
              frontend_dirty_count
                AS "frontendDirtyCount",
              rollback_path
                AS "rollbackPath",
              manifest_path
                AS "manifestPath",
              approved_at
                AS "approvedAt",
              deployed_at
                AS "deployedAt",
              failed_at
                AS "failedAt",
              rolled_back_at
                AS "rolledBackAt",
              created_at
                AS "createdAt"

            FROM backend_releases

            WHERE organization_id =
                  $1

            ORDER BY
              created_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        releases:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/change-requests",
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
              change_type
                AS "changeType",
              risk_level
                AS "riskLevel",
              status,
              requested_by
                AS "requestedBy",
              approved_by
                AS "approvedBy",
              approval_notes
                AS "approvalNotes",
              approved_at
                AS "approvedAt",
              planned_start
                AS "plannedStart",
              planned_end
                AS "plannedEnd",
              implemented_at
                AS "implementedAt",
              metadata_json
                AS metadata,
              created_at
                AS "createdAt",
              updated_at
                AS "updatedAt"

            FROM backend_change_requests

            WHERE organization_id =
                  $1

            ORDER BY
              created_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        changeRequests:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/change-requests",
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

      const changeType =
        String(
          request.body
            ?.changeType ||
          "application"
        )
        .trim();

      const riskLevel =
        String(
          request.body
            ?.riskLevel ||
          "medium"
        )
        .trim();

      if (!title) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Change-request title is required.",
          });
      }

      if (
        ![
          "application",
          "configuration",
          "database",
          "infrastructure",
          "security",
          "hotfix",
        ].includes(
          changeType
        )
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid change type.",
          });
      }

      if (
        ![
          "low",
          "medium",
          "high",
          "critical",
        ].includes(
          riskLevel
        )
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid risk level.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_change_requests (
              id,
              organization_id,
              project_id,
              environment_id,
              title,
              description,
              change_type,
              risk_level,
              status,
              requested_by,
              planned_start,
              planned_end,
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
              $8,
              'draft',
              $9::uuid,
              $10,
              $11,
              $12::jsonb
            )
            RETURNING
              id,
              title,
              change_type
                AS "changeType",
              risk_level
                AS "riskLevel",
              status,
              created_at
                AS "createdAt"
          `,
          [
            identifier(
              "change"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            title,
            String(
              request.body
                ?.description ||
              ""
            )
            .trim()
            .slice(0, 10000) ||
              null,
            changeType,
            riskLevel,
            actorId(request),
            request.body
              ?.plannedStart ||
              null,
            request.body
              ?.plannedEnd ||
              null,
            JSON.stringify(
              request.body
                ?.metadata ||
              {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          changeRequest:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.patch(
  "/change-requests/:changeRequestId/status",
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
          "draft",
          "review",
          "approved",
          "rejected",
          "implemented",
          "cancelled",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid change-request status.",
          });
      }

      const userId =
        actorId(request);

      const result =
        await query(
          `
            UPDATE backend_change_requests

            SET
              status =
                $3,

              approved_by =
                CASE
                  WHEN $3 =
                       'approved'
                  THEN $4::uuid
                  ELSE approved_by
                END,

              approved_at =
                CASE
                  WHEN $3 =
                       'approved'
                  THEN NOW()
                  ELSE approved_at
                END,

              approval_notes =
                CASE
                  WHEN $3 IN (
                    'approved',
                    'rejected'
                  )
                  THEN $5
                  ELSE approval_notes
                END,

              implemented_at =
                CASE
                  WHEN $3 =
                       'implemented'
                  THEN NOW()
                  ELSE implemented_at
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
              status,
              approved_by
                AS "approvedBy",
              approved_at
                AS "approvedAt",
              implemented_at
                AS "implementedAt",
              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .changeRequestId,
            request.tenantContext
              .organizationId,
            status,
            userId,
            String(
              request.body
                ?.approvalNotes ||
              ""
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
              "Change request was not found.",
          });
      }

      response.json({
        success: true,
        changeRequest:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/feature-flags",
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
              flag_key
                AS "flagKey",
              name,
              description,
              enabled,
              rollout_percent
                AS "rolloutPercent",
              status,
              conditions_json
                AS conditions,
              expires_at
                AS "expiresAt",
              created_at
                AS "createdAt",
              updated_at
                AS "updatedAt"

            FROM backend_feature_flags

            WHERE organization_id =
                  $1

            ORDER BY
              flag_key ASC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        featureFlags:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/feature-flags",
  async (
    request,
    response,
    next
  ) => {
    try {
      const flagKey =
        String(
          request.body?.flagKey ||
          ""
        )
        .trim()
        .toLowerCase();

      const name =
        String(
          request.body?.name ||
          flagKey
        )
        .trim()
        .slice(0, 500);

      if (
        !/^[a-z0-9._-]{3,150}$/
          .test(flagKey)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Feature-flag key is invalid.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_feature_flags (
              id,
              organization_id,
              project_id,
              environment_id,
              flag_key,
              name,
              description,
              enabled,
              rollout_percent,
              status,
              conditions_json,
              expires_at,
              created_by,
              updated_by
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              false,
              0,
              'active',
              $8::jsonb,
              $9,
              $10::uuid,
              $10::uuid
            )
            RETURNING
              id,
              flag_key
                AS "flagKey",
              name,
              enabled,
              rollout_percent
                AS "rolloutPercent",
              status,
              created_at
                AS "createdAt"
          `,
          [
            identifier(
              "flag"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            flagKey,
            name,
            String(
              request.body
                ?.description ||
              ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
            JSON.stringify(
              request.body
                ?.conditions ||
              {}
            ),
            request.body
              ?.expiresAt ||
              null,
            actorId(request),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          featureFlag:
            result.rows[0],
        });
    } catch (error) {
      if (
        error.code ===
        "23505"
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              "Feature-flag key already exists in this environment.",
          });
      }

      next(error);
    }
  }
);


router.patch(
  "/feature-flags/:flagId",
  async (
    request,
    response,
    next
  ) => {
    try {
      const enabled =
        request.body?.enabled;

      const rolloutPercent =
        request.body
          ?.rolloutPercent;

      if (
        enabled !== undefined &&
        typeof enabled !==
          "boolean"
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Enabled must be boolean.",
          });
      }

      if (
        rolloutPercent !==
          undefined &&
        (
          !Number.isInteger(
            rolloutPercent
          )
          ||
          rolloutPercent < 0
          ||
          rolloutPercent > 100
        )
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Rollout percent must be an integer from 0 through 100.",
          });
      }

      const result =
        await query(
          `
            UPDATE backend_feature_flags

            SET
              enabled =
                COALESCE(
                  $3::boolean,
                  enabled
                ),

              rollout_percent =
                COALESCE(
                  $4::integer,
                  rollout_percent
                ),

              status =
                COALESCE(
                  $5,
                  status
                ),

              conditions_json =
                COALESCE(
                  $6::jsonb,
                  conditions_json
                ),

              expires_at =
                CASE
                  WHEN $7::boolean
                  THEN $8::timestamptz
                  ELSE expires_at
                END,

              updated_by =
                $9::uuid,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              flag_key
                AS "flagKey",
              name,
              enabled,
              rollout_percent
                AS "rolloutPercent",
              status,
              conditions_json
                AS conditions,
              expires_at
                AS "expiresAt",
              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .flagId,
            request.tenantContext
              .organizationId,
            enabled ??
              null,
            rolloutPercent ??
              null,
            request.body
              ?.status ||
              null,
            request.body
              ?.conditions ===
              undefined
              ? null
              : JSON.stringify(
                  request.body
                    .conditions
                ),
            Object.prototype
              .hasOwnProperty
              .call(
                request.body ||
                {},
                "expiresAt"
              ),
            request.body
              ?.expiresAt ||
              null,
            actorId(request),
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
              "Feature flag was not found.",
          });
      }

      response.json({
        success: true,
        featureFlag:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/migrations",
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
              release_id
                AS "releaseId",
              file_name
                AS "fileName",
              checksum_sha256
                AS "checksumSha256",
              status,
              applied_by
                AS "appliedBy",
              applied_at
                AS "appliedAt",
              error_message
                AS "errorMessage",
              metadata_json
                AS metadata,
              created_at
                AS "createdAt",
              updated_at
                AS "updatedAt"

            FROM backend_migration_ledger

            WHERE organization_id =
                  $1

            ORDER BY
              file_name ASC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        migrations:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports =
  router;
