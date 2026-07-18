"use strict";

const express =
  require("express");

const {
  query,
} = require(
  "../config/database"
);

const gateway =
  require(
    "../services/api-gateway-v2.service"
  );

const policyEngineV2Middleware =
  require(
    "./policy-engine-v2.middleware"
  );

const storageV2PublicRoutes =
  require(
    "./storage-v2-public.routes"
  );

const router =
  express.Router();

router.use(
  gateway
    .authenticateAndEnforce
);

router.use(
  policyEngineV2Middleware
);

router.use(
  "/storage",
  storageV2PublicRoutes
);

router.get(
  "/health",
  gateway.requireScope(
    "read:health"
  ),
  (
    request,
    response
  ) => {
    return response.json({
      success: true,

      service:
        "GoodOS Enterprise API Gateway V2",

      status:
        "ready",

      requestId:
        request.gatewayContext
          .requestId,

      apiKey: {
        id:
          request.goodosApiKey
            .id,

        name:
          request.goodosApiKey
            .name,

        serviceAccountId:
          request.goodosApiKey
            .serviceAccountId ||
          null,

        serviceAccountName:
          request.goodosApiKey
            .serviceAccountName ||
          null,

        policyId:
          request.goodosApiKey
            .policyId,
      },

      limits: {
        requestsPerMinute:
          request.goodosApiKey
            .requestsPerMinute,

        dailyQuota:
          request.goodosApiKey
            .dailyQuota,

        maxBodyBytes:
          request.goodosApiKey
            .maxBodyBytes,

        requireIdempotency:
          request.goodosApiKey
            .requireIdempotency,
      },

      timestamp:
        new Date()
          .toISOString(),
    });
  }
);

router.get(
  "/whoami",
  gateway.requireScope(
    "read:health"
  ),
  (
    request,
    response
  ) => {
    return response.json({
      success: true,

      requestId:
        request.gatewayContext
          .requestId,

      identity: {
        apiKeyId:
          request.goodosApiKey
            .id,

        apiKeyName:
          request.goodosApiKey
            .name,

        organizationId:
          request.goodosApiKey
            .organizationId,

        projectId:
          request.goodosApiKey
            .projectId,

        environmentId:
          request.goodosApiKey
            .environmentId,

        serviceAccountId:
          request.goodosApiKey
            .serviceAccountId ||
          null,

        serviceAccountName:
          request.goodosApiKey
            .serviceAccountName ||
          null,

        scopes:
          request.goodosApiKey
            .scopes ||
          [],

        allowedAppIds:
          request.goodosApiKey
            .allowedAppIds ||
          [],
      },
    });
  }
);

router.get(
  "/apps",
  gateway.requireScope(
    "read:apps"
  ),
  async (
    request,
    response
  ) => {
    try {
      const allowedAppIds =
        Array.isArray(
          request.goodosApiKey
            .allowedAppIds
        )
          ? request.goodosApiKey
              .allowedAppIds
          : [
              "*",
            ];

      const unrestricted =
        allowedAppIds.includes(
          "*"
        );

      const result =
        await query(
          `
            SELECT
              app.id,
              app.name,
              app.domain,
              app.status,

              COUNT(
                membership.user_id
              )::int
                AS "memberCount"

            FROM apps app

            LEFT JOIN
              app_memberships
                 AS membership
              ON membership.app_id =
                 app.id

             AND membership.status =
                 'active'

            WHERE (
              $1::boolean =
                TRUE

              OR app.id =
                 ANY(
                   $2::text[]
                 )
            )

            GROUP BY
              app.id,
              app.name,
              app.domain,
              app.status

            ORDER BY
              app.name
          `,
          [
            unrestricted,
            allowedAppIds,
          ]
        );

      return response.json({
        success: true,

        requestId:
          request.gatewayContext
            .requestId,

        data: {
          applications:
            result.rows,

          total:
            result.rows
              .length,

          unrestricted,

          allowedAppIds,
        },
      });
    } catch (error) {
      return response
        .status(500)
        .json({
          success: false,

          code:
            "APPLICATIONS_LOAD_FAILED",

          message:
            error.message,

          requestId:
            request.gatewayContext
              .requestId,
        });
    }
  }
);

router.get(
  "/usage",
  gateway.requireScope(
    "read:usage"
  ),
  async (
    request,
    response
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              (
                SELECT
                  request_count

                FROM backend_api_gateway_windows

                WHERE api_key_id =
                      $1

                  AND window_start =
                      DATE_TRUNC(
                        'minute',
                        NOW()
                      )
              ) AS minute_count,

              (
                SELECT
                  request_count

                FROM backend_api_gateway_daily_usage

                WHERE api_key_id =
                      $1

                  AND usage_date =
                      CURRENT_DATE
              ) AS daily_count,

              (
                SELECT
                  COUNT(*)::int

                FROM backend_api_gateway_request_logs

                WHERE api_key_id =
                      $1
              ) AS total_logged_requests
          `,
          [
            request.goodosApiKey
              .id,
          ]
        );

      const row =
        result.rows[0] ||
        {};

      return response.json({
        success: true,

        requestId:
          request.gatewayContext
            .requestId,

        usage: {
          currentMinute:
            Number(
              row.minute_count ||
              0
            ),

          currentDay:
            Number(
              row.daily_count ||
              0
            ),

          totalLoggedRequests:
            Number(
              row.total_logged_requests ||
              0
            ),

          limits: {
            requestsPerMinute:
              request.goodosApiKey
                .requestsPerMinute,

            dailyQuota:
              request.goodosApiKey
                .dailyQuota,
          },
        },
      });
    } catch (error) {
      return response
        .status(500)
        .json({
          success: false,

          code:
            "USAGE_LOAD_FAILED",

          message:
            error.message,

          requestId:
            request.gatewayContext
              .requestId,
        });
    }
  }
);

router.post(
  "/echo",
  gateway.requireScope(
    "read:health"
  ),
  async (
    request,
    response
  ) => {
    const payload = {
      success: true,

      requestId:
        request.gatewayContext
          .requestId,

      received:
        request.body ||
        {},

      serviceAccountId:
        request.goodosApiKey
          .serviceAccountId ||
        null,

      processedAt:
        new Date()
          .toISOString(),
    };

    await gateway
      .completeIdempotency(
        request,
        201,
        payload,
        {
          "Content-Type":
            "application/json",
        }
      );

    return response
      .status(201)
      .json(payload);
  }
);

module.exports =
  router;
