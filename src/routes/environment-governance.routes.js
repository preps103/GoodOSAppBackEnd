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

async function environmentAdminRequired(
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
            account.platform_role
              AS "platformRole",

            membership.role
              AS "membershipRole"

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
          identity.platformRole
        )
        ||
        [
          "owner",
          "admin",
        ].includes(
          identity.membershipRole
        )
      );

    if (!allowed) {
      return response
        .status(403)
        .json({
          success: false,
          code:
            "ENVIRONMENT_ADMIN_REQUIRED",
          message:
            "Environment administration requires owner or administrator access.",
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
  environmentAdminRequired
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

      const projectId =
        request.tenantContext
          .projectId;

      const [
        environments,
        inventory,
        promotions,
      ] =
        await Promise.all([
          query(
            `
              SELECT
                environment.id,
                environment.name,
                environment.slug,
                environment.type,
                environment.status,
                environment.api_base_url
                  AS "apiBaseUrl",

                policy.data_mode
                  AS "dataMode",

                policy.secrets_namespace
                  AS "secretsNamespace",

                policy.storage_namespace
                  AS "storageNamespace",

                policy.requires_clean_git
                  AS "requiresCleanGit",

                policy.requires_change_request
                  AS "requiresChangeRequest",

                policy.requires_release_approval
                  AS "requiresReleaseApproval",

                policy.requires_mfa
                  AS "requiresMfa",

                policy.allows_direct_deploy
                  AS "allowsDirectDeploy",

                policy.allows_production_credentials
                  AS "allowsProductionCredentials",

                policy.allows_production_customer_data
                  AS "allowsProductionCustomerData",

                policy.promotion_source_environment_id
                  AS "promotionSourceEnvironmentId",

                policy.metadata_json
                  AS metadata

              FROM backend_project_environments
                   AS environment

              LEFT JOIN backend_environment_policies
                        AS policy
                ON policy.environment_id =
                   environment.id

              WHERE environment.project_id =
                    $1

              ORDER BY
                CASE environment.type
                  WHEN 'development' THEN 1
                  WHEN 'staging' THEN 2
                  WHEN 'production' THEN 3
                  ELSE 4
                END
            `,
            [
              projectId,
            ]
          ),

          query(
            `
              SELECT
                environment_id
                  AS "environmentId",

                resource_type
                  AS "resourceType",

                record_count
                  AS "recordCount"

              FROM (
                SELECT
                  environment_id,
                  'releases'::text
                    AS resource_type,
                  COUNT(*)::int
                    AS record_count
                FROM backend_releases
                WHERE organization_id = $1
                GROUP BY environment_id

                UNION ALL

                SELECT
                  environment_id,
                  'apiKeys',
                  COUNT(*)::int
                FROM backend_api_keys
                WHERE organization_id = $1
                GROUP BY environment_id

                UNION ALL

                SELECT
                  environment_id,
                  'webhooks',
                  COUNT(*)::int
                FROM backend_webhooks
                WHERE organization_id = $1
                GROUP BY environment_id

                UNION ALL

                SELECT
                  environment_id,
                  'storageBuckets',
                  COUNT(*)::int
                FROM backend_storage_buckets
                WHERE organization_id = $1
                GROUP BY environment_id

                UNION ALL

                SELECT
                  environment_id,
                  'featureFlags',
                  COUNT(*)::int
                FROM backend_feature_flags
                WHERE organization_id = $1
                GROUP BY environment_id

                UNION ALL

                SELECT
                  environment_id,
                  'operationsChecks',
                  COUNT(*)::int
                FROM backend_operations_checks
                WHERE organization_id = $1
                GROUP BY environment_id
              ) inventory_records

              ORDER BY
                environment_id,
                resource_type
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                status,
                COUNT(*)::int
                  AS count

              FROM backend_environment_promotions

              WHERE organization_id =
                    $1

              GROUP BY status

              ORDER BY status
            `,
            [
              organizationId,
            ]
          ),
        ]);

      response.json({
        success: true,
        organizationId,
        projectId,
        environments:
          environments.rows,
        inventory:
          inventory.rows,
        promotionCounts:
          promotions.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/promotions",
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
              promotion.id,

              promotion.source_environment_id
                AS "sourceEnvironmentId",

              source_environment.name
                AS "sourceEnvironmentName",

              promotion.environment_id
                AS "targetEnvironmentId",

              target_environment.name
                AS "targetEnvironmentName",

              promotion.source_release_id
                AS "sourceReleaseId",

              promotion.target_release_id
                AS "targetReleaseId",

              source_release.version_label
                AS "sourceVersionLabel",

              promotion.status,

              promotion.approval_notes
                AS "approvalNotes",

              promotion.validation_json
                AS validation,

              promotion.requested_at
                AS "requestedAt",

              promotion.approved_at
                AS "approvedAt",

              promotion.promoted_at
                AS "promotedAt",

              promotion.failed_at
                AS "failedAt",

              promotion.updated_at
                AS "updatedAt"

            FROM backend_environment_promotions
                 AS promotion

            JOIN backend_project_environments
                 AS source_environment
              ON source_environment.id =
                 promotion.source_environment_id

            JOIN backend_project_environments
                 AS target_environment
              ON target_environment.id =
                 promotion.environment_id

            JOIN backend_releases
                 AS source_release
              ON source_release.id =
                 promotion.source_release_id

            WHERE promotion.organization_id =
                  $1

            ORDER BY
              promotion.created_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        promotions:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/promotions",
  async (
    request,
    response,
    next
  ) => {
    try {
      const sourceReleaseId =
        String(
          request.body
            ?.sourceReleaseId ||
          ""
        )
        .trim();

      if (!sourceReleaseId) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "A deployed staging release is required.",
          });
      }

      const environments =
        await query(
          `
            SELECT
              id,
              type

            FROM backend_project_environments

            WHERE project_id =
                  $1

              AND type IN (
                'staging',
                'production'
              )

              AND status =
                  'active'
          `,
          [
            request.tenantContext
              .projectId,
          ]
        );

      const staging =
        environments.rows.find(
          item =>
            item.type ===
            "staging"
        );

      const production =
        environments.rows.find(
          item =>
            item.type ===
            "production"
        );

      if (
        !staging ||
        !production
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              "Canonical staging and production environments are required.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_environment_promotions (
              id,
              organization_id,
              project_id,
              environment_id,
              source_environment_id,
              source_release_id,
              status,
              requested_by,
              validation_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              'pending',
              $7::uuid,
              $8::jsonb
            )
            RETURNING
              id,
              source_environment_id
                AS "sourceEnvironmentId",
              environment_id
                AS "targetEnvironmentId",
              source_release_id
                AS "sourceReleaseId",
              status,
              requested_at
                AS "requestedAt"
          `,
          [
            identifier(
              "promotion"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            production.id,
            staging.id,
            sourceReleaseId,
            actorId(request),
            JSON.stringify(
              request.body
                ?.validation ||
              {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          promotion:
            result.rows[0],
        });
    } catch (error) {
      if (
        error.code ===
        "23514"
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              error.message,
          });
      }

      next(error);
    }
  }
);


router.patch(
  "/promotions/:promotionId/status",
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
          "approved",
          "rejected",
          "promoted",
          "failed",
          "cancelled",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid promotion status.",
          });
      }

      const userId =
        actorId(request);

      const result =
        await query(
          `
            UPDATE backend_environment_promotions

            SET
              status =
                $3,

              approved_by =
                CASE
                  WHEN $3 IN (
                    'approved',
                    'promoted'
                  )
                  THEN $4::uuid
                  ELSE approved_by
                END,

              approved_at =
                CASE
                  WHEN $3 IN (
                    'approved',
                    'promoted'
                  )
                  THEN COALESCE(
                    approved_at,
                    NOW()
                  )
                  ELSE approved_at
                END,

              approval_notes =
                $5,

              promoted_at =
                CASE
                  WHEN $3 =
                       'promoted'
                  THEN NOW()
                  ELSE promoted_at
                END,

              failed_at =
                CASE
                  WHEN $3 =
                       'failed'
                  THEN NOW()
                  ELSE failed_at
                END,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              status,
              approved_at
                AS "approvedAt",
              promoted_at
                AS "promotedAt",
              failed_at
                AS "failedAt",
              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .promotionId,
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
              "Environment promotion was not found.",
          });
      }

      response.json({
        success: true,
        promotion:
          result.rows[0],
      });
    } catch (error) {
      if (
        error.code ===
        "23514"
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              error.message,
          });
      }

      next(error);
    }
  }
);

module.exports =
  router;
