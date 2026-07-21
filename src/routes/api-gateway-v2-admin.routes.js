"use strict";

const crypto =
  require("crypto");

const express =
  require("express");

const authRequired =
  require(
    "../middleware/authRequired"
  );

const tenantContext =
  require(
    "../middleware/tenantContext"
  );

const {
  query,
} = require(
  "../config/database"
);

const {
  logAudit,
} = require(
  "../services/audit.service"
);

const router =
  express.Router();

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

function cleanText(
  value,
  maximum = 255
) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /\s+/g,
      " "
    )
    .slice(
      0,
      maximum
    );
}

function integerValue(
  value,
  fallback,
  minimum,
  maximum
) {
  const parsed =
    Number.parseInt(
      String(
        value ?? ""
      ),
      10
    );

  if (
    !Number.isInteger(
      parsed
    )
  ) {
    return fallback;
  }

  return Math.min(
    Math.max(
      parsed,
      minimum
    ),
    maximum
  );
}

function stringArray(
  value,
  fallback = []
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    return fallback;
  }

  return [
    ...new Set(
      value
        .map(item =>
          String(
            item || ""
          ).trim()
        )
        .filter(Boolean)
    ),
  ];
}

async function adminRequired(
  request,
  response,
  next
) {
  try {
    const result =
      await query(
        `
          SELECT
            account.platform_role,

            membership.role
              AS organization_role

          FROM users account

          JOIN
            backend_organization_memberships
               AS membership
            ON membership.user_id =
               account.id

          WHERE account.id =
                $1::uuid

            AND account.status =
                'active'

            AND membership.organization_id =
                $2

            AND membership.status =
                'active'

          LIMIT 1
        `,
        [
          request.user.id,

          request.tenantContext
            .organizationId,
        ]
      );

    const identity =
      result.rows[0];

    const permitted =
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
          identity
            .organization_role
        )
      );

    if (!permitted) {
      return response
        .status(403)
        .json({
          success: false,

          code:
            "API_GATEWAY_ADMIN_REQUIRED",

          message:
            "Owner or administrator access is required.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

router.get(
  "/health",
  async (
    request,
    response
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              to_regclass(
                'public.backend_service_accounts'
              ) IS NOT NULL
                AS service_accounts,

              to_regclass(
                'public.backend_api_gateway_policies'
              ) IS NOT NULL
                AS policies,

              to_regclass(
                'public.backend_api_gateway_windows'
              ) IS NOT NULL
                AS rate_limits,

              to_regclass(
                'public.backend_api_idempotency_records'
              ) IS NOT NULL
                AS idempotency,

              to_regclass(
                'public.backend_api_gateway_request_logs'
              ) IS NOT NULL
                AS request_ledger
          `
        );

      const state =
        result.rows[0] ||
        {};

      const ready =
        Object.values(
          state
        ).every(Boolean);

      return response
        .status(
          ready
            ? 200
            : 503
        )
        .json({
          success:
            ready,

          service:
            "GoodOS Enterprise API Gateway V2",

          status:
            ready
              ? "ready"
              : "incomplete",

          components:
            state,

          timestamp:
            new Date()
              .toISOString(),
        });
    } catch (error) {
      return response
        .status(500)
        .json({
          success: false,

          status:
            "failed",

          message:
            error.message,
        });
    }
  }
);

router.use(
  authRequired,
  tenantContext,
  adminRequired
);

router.get(
  "/overview",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const result =
        await query(
          `
            SELECT
              (
                SELECT COUNT(*)::int
                FROM backend_service_accounts
                WHERE organization_id =
                      $1
                  AND status =
                      'active'
              ) AS active_service_accounts,

              (
                SELECT COUNT(*)::int
                FROM backend_api_gateway_policies
                WHERE organization_id =
                      $1
                  AND status =
                      'active'
              ) AS active_policies,

              (
                SELECT COUNT(*)::int
                FROM backend_api_gateway_request_logs
                WHERE organization_id =
                      $1
                  AND created_at >=
                      NOW() -
                      INTERVAL '24 hours'
              ) AS requests_24h,

              (
                SELECT COUNT(*)::int
                FROM backend_api_gateway_request_logs
                WHERE organization_id =
                      $1
                  AND status_code >=
                      400
                  AND created_at >=
                      NOW() -
                      INTERVAL '24 hours'
              ) AS errors_24h,

              (
                SELECT COUNT(*)::int
                FROM backend_api_idempotency_records
                WHERE status =
                      'completed'
                  AND created_at >=
                      NOW() -
                      INTERVAL '24 hours'
                  AND api_key_id IN (
                    SELECT id
                    FROM backend_api_keys
                    WHERE organization_id =
                          $1
                  )
              ) AS idempotent_requests_24h
          `,
          [
            organizationId,
          ]
        );

      return response.json({
        success: true,

        organizationId,

        gateway:
          result.rows[0] ||
          {},

        publicBaseUrl:
          "https://base.goodos.app/api/v2",
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/service-accounts",
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
              account.id,
              account.name,
              account.description,
              account.status,

              account.last_used_at
                AS "lastUsedAt",

              account.created_at
                AS "createdAt",

              account.updated_at
                AS "updatedAt",

              COUNT(
                key_record.id
              )::int
                AS "keyCount"

            FROM backend_service_accounts
                 AS account

            LEFT JOIN
              backend_api_keys
                 AS key_record
              ON key_record.service_account_id =
                 account.id

            WHERE account.organization_id =
                  $1

            GROUP BY
              account.id

            ORDER BY
              account.created_at DESC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      return response.json({
        success: true,

        serviceAccounts:
          result.rows,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/service-accounts",
  async (
    request,
    response,
    next
  ) => {
    try {
      const name =
        cleanText(
          request.body?.name,
          150
        );

      if (
        name.length < 3
      ) {
        return response
          .status(400)
          .json({
            success: false,

            message:
              "Service-account name must contain at least three characters.",
          });
      }

      const id =
        identifier(
          "svcacct"
        );

      const result =
        await query(
          `
            INSERT INTO
              backend_service_accounts (
                id,
                organization_id,
                name,
                description,
                status,
                created_by,
                metadata_json
              )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              'active',
              $5::uuid,
              $6::jsonb
            )
            RETURNING
              id,
              name,
              description,
              status,

              created_at
                AS "createdAt"
          `,
          [
            id,

            request.tenantContext
              .organizationId,

            name,

            cleanText(
              request.body
                ?.description,
              500
            ) || null,

            request.user.id,

            JSON.stringify({
              source:
                "phase16-api-gateway",
            }),
          ]
        );

      await logAudit({
        userId:
          request.user.id,

        appId:
          "goodos",

        action:
          "api_gateway.service_account.created",

        entityType:
          "service_account",

        entityId:
          id,

        ipAddress:
          request.ip,

        metadata: {
          organizationId:
            request.tenantContext
              .organizationId,

          name,
        },
      });

      return response
        .status(201)
        .json({
          success: true,

          serviceAccount:
            result.rows[0],
        });
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  "/service-accounts/:serviceAccountId",
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
        ).toLowerCase();

      if (
        ![
          "active",
          "disabled",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,

            message:
              "Status must be active or disabled.",
          });
      }

      const result =
        await query(
          `
            UPDATE backend_service_accounts
            SET
              status =
                $3,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              name,
              status,

              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .serviceAccountId,

            request.tenantContext
              .organizationId,

            status,
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
              "Service account was not found.",
          });
      }

      await logAudit({
        userId:
          request.user.id,

        appId:
          "goodos",

        action:
          "api_gateway.service_account.updated",

        entityType:
          "service_account",

        entityId:
          request.params
            .serviceAccountId,

        ipAddress:
          request.ip,

        metadata: {
          organizationId:
            request.tenantContext
              .organizationId,

          status,
        },
      });

      return response.json({
        success: true,

        serviceAccount:
          result.rows[0],
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/policies",
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
              policy.id,

              policy.api_key_id
                AS "apiKeyId",

              key_record.name
                AS "apiKeyName",

              policy.service_account_id
                AS "serviceAccountId",

              service_account.name
                AS "serviceAccountName",

              policy.requests_per_minute
                AS "requestsPerMinute",

              policy.burst_limit
                AS "burstLimit",

              policy.daily_quota
                AS "dailyQuota",

              policy.max_body_bytes
                AS "maxBodyBytes",

              policy.require_idempotency
                AS "requireIdempotency",

              policy.allowed_cidrs
                AS "allowedCidrs",

              policy.denied_cidrs
                AS "deniedCidrs",

              policy.status,

              policy.created_at
                AS "createdAt",

              policy.updated_at
                AS "updatedAt"

            FROM backend_api_gateway_policies
                 AS policy

            JOIN backend_api_keys
                 AS key_record
              ON key_record.id =
                 policy.api_key_id

            LEFT JOIN
              backend_service_accounts
                 AS service_account
              ON service_account.id =
                 policy.service_account_id

            WHERE policy.organization_id =
                  $1

            ORDER BY
              policy.created_at DESC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      return response.json({
        success: true,

        policies:
          result.rows,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.put(
  "/keys/:keyId/policy",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const keyResult =
        await query(
          `
            SELECT id
            FROM backend_api_keys
            WHERE id =
                  $1

              AND COALESCE(
                organization_id,
                'org_goodos'
              ) = $2

            LIMIT 1
          `,
          [
            request.params
              .keyId,

            organizationId,
          ]
        );

      if (
        keyResult.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,

            message:
              "API key was not found.",
          });
      }

      const serviceAccountId =
        cleanText(
          request.body
            ?.serviceAccountId,
          180
        ) || null;

      if (
        serviceAccountId
      ) {
        const serviceResult =
          await query(
            `
              SELECT id
              FROM backend_service_accounts
              WHERE id =
                    $1

                AND organization_id =
                    $2

                AND status =
                    'active'

              LIMIT 1
            `,
            [
              serviceAccountId,
              organizationId,
            ]
          );

        if (
          serviceResult.rowCount ===
          0
        ) {
          return response
            .status(400)
            .json({
              success: false,

              message:
                "Active service account was not found.",
            });
        }
      }

      const status =
        [
          "active",
          "disabled",
        ].includes(
          String(
            request.body
              ?.status ||
            "active"
          ).toLowerCase()
        )
          ? String(
              request.body
                ?.status ||
              "active"
            ).toLowerCase()
          : "active";

      const policyId =
        identifier(
          "apipol"
        );

      const result =
        await query(
          `
            INSERT INTO
              backend_api_gateway_policies (
                id,
                organization_id,
                api_key_id,
                service_account_id,
                requests_per_minute,
                burst_limit,
                daily_quota,
                max_body_bytes,
                require_idempotency,
                allowed_cidrs,
                denied_cidrs,
                status,
                created_by,
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
              $9,
              $10::text[],
              $11::text[],
              $12,
              $13::uuid,
              $14::jsonb
            )
            ON CONFLICT (
              api_key_id
            )
            DO UPDATE SET
              service_account_id =
                EXCLUDED.service_account_id,

              requests_per_minute =
                EXCLUDED.requests_per_minute,

              burst_limit =
                EXCLUDED.burst_limit,

              daily_quota =
                EXCLUDED.daily_quota,

              max_body_bytes =
                EXCLUDED.max_body_bytes,

              require_idempotency =
                EXCLUDED.require_idempotency,

              allowed_cidrs =
                EXCLUDED.allowed_cidrs,

              denied_cidrs =
                EXCLUDED.denied_cidrs,

              status =
                EXCLUDED.status,

              metadata_json =
                COALESCE(
                  backend_api_gateway_policies
                    .metadata_json,
                  '{}'::jsonb
                ) ||
                EXCLUDED.metadata_json,

              updated_at =
                NOW()

            RETURNING
              id,

              api_key_id
                AS "apiKeyId",

              service_account_id
                AS "serviceAccountId",

              requests_per_minute
                AS "requestsPerMinute",

              burst_limit
                AS "burstLimit",

              daily_quota
                AS "dailyQuota",

              max_body_bytes
                AS "maxBodyBytes",

              require_idempotency
                AS "requireIdempotency",

              allowed_cidrs
                AS "allowedCidrs",

              denied_cidrs
                AS "deniedCidrs",

              status,

              updated_at
                AS "updatedAt"
          `,
          [
            policyId,

            organizationId,

            request.params
              .keyId,

            serviceAccountId,

            integerValue(
              request.body
                ?.requestsPerMinute,
              120,
              1,
              100000
            ),

            integerValue(
              request.body
                ?.burstLimit,
              30,
              1,
              100000
            ),

            integerValue(
              request.body
                ?.dailyQuota,
              10000,
              1,
              100000000
            ),

            integerValue(
              request.body
                ?.maxBodyBytes,
              1048576,
              1024,
              10485760
            ),

            Boolean(
              request.body
                ?.requireIdempotency
            ),

            stringArray(
              request.body
                ?.allowedCidrs,
              [
                "*",
              ]
            ),

            stringArray(
              request.body
                ?.deniedCidrs,
              []
            ),

            status,

            request.user.id,

            JSON.stringify({
              source:
                "phase16-api-gateway",
            }),
          ]
        );

      await query(
        `
          UPDATE backend_api_keys
          SET
            service_account_id =
              $2,

            updated_at =
              NOW()

          WHERE id =
                $1
        `,
        [
          request.params
            .keyId,

          serviceAccountId,
        ]
      );

      await logAudit({
        userId:
          request.user.id,

        appId:
          "goodos",

        action:
          "api_gateway.policy.saved",

        entityType:
          "api_gateway_policy",

        entityId:
          result.rows[0]
            .id,

        ipAddress:
          request.ip,

        metadata: {
          organizationId,

          apiKeyId:
            request.params
              .keyId,

          serviceAccountId,
        },
      });

      return response.json({
        success: true,

        policy:
          result.rows[0],
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/request-logs",
  async (
    request,
    response,
    next
  ) => {
    try {
      const limit =
        integerValue(
          request.query
            .limit,
          100,
          1,
          500
        );

      const result =
        await query(
          `
            SELECT
              id,

              request_id
                AS "requestId",

              api_key_id
                AS "apiKeyId",

              service_account_id
                AS "serviceAccountId",

              method,
              path,

              status_code
                AS "statusCode",

              duration_ms
                AS "durationMs",

              source_ip
                AS "sourceIp",

              idempotency_key
                AS "idempotencyKey",

              idempotent_replay
                AS "idempotentReplay",

              rate_limit
                AS "rateLimit",

              rate_limit_remaining
                AS "rateLimitRemaining",

              daily_quota
                AS "dailyQuota",

              daily_remaining
                AS "dailyRemaining",

              request_bytes
                AS "requestBytes",

              response_bytes
                AS "responseBytes",

              created_at
                AS "createdAt"

            FROM backend_api_gateway_request_logs

            WHERE organization_id =
                  $1

            ORDER BY
              created_at DESC

            LIMIT $2
          `,
          [
            request.tenantContext
              .organizationId,

            limit,
          ]
        );

      return response.json({
        success: true,

        requestLogs:
          result.rows,
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports =
  router;
