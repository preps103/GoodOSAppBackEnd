"use strict";

const crypto =
  require("crypto");

const {
  query,
} = require(
  "../config/database"
);

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

function extractApiKey(
  request
) {
  const direct =
    request.get(
      "X-GoodOS-API-Key"
    );

  if (direct) {
    return direct.trim();
  }

  const authorization =
    String(
      request.get(
        "Authorization"
      ) || ""
    );

  if (
    authorization
      .toLowerCase()
      .startsWith(
        "bearer "
      )
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return "";
}

function hashApiKey(
  secret
) {
  return crypto
    .createHash("sha256")
    .update(
      String(secret || "")
    )
    .digest("hex");
}

function normalizeIp(
  value
) {
  const ip =
    String(value || "")
      .trim();

  if (
    ip.startsWith(
      "::ffff:"
    )
  ) {
    return ip.slice(7);
  }

  if (
    ip === "::1"
  ) {
    return "127.0.0.1";
  }

  return ip;
}

function ipv4ToInteger(
  value
) {
  const parts =
    String(value || "")
      .split(".")
      .map(part =>
        Number.parseInt(
          part,
          10
        )
      );

  if (
    parts.length !== 4 ||
    parts.some(
      part =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255
    )
  ) {
    return null;
  }

  return (
    (
      (
        parts[0] * 256 +
        parts[1]
      ) * 256 +
      parts[2]
    ) * 256 +
    parts[3]
  ) >>> 0;
}

function ipMatchesRule(
  sourceIp,
  rule
) {
  const source =
    normalizeIp(
      sourceIp
    );

  const normalizedRule =
    normalizeIp(
      rule
    );

  if (
    !normalizedRule
  ) {
    return false;
  }

  if (
    normalizedRule === "*"
  ) {
    return true;
  }

  if (
    normalizedRule === source
  ) {
    return true;
  }

  const [
    network,
    prefixText,
  ] = normalizedRule.split("/");

  if (
    prefixText === undefined
  ) {
    return false;
  }

  const sourceInteger =
    ipv4ToInteger(
      source
    );

  const networkInteger =
    ipv4ToInteger(
      network
    );

  const prefix =
    Number.parseInt(
      prefixText,
      10
    );

  if (
    sourceInteger === null ||
    networkInteger === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  if (
    prefix === 0
  ) {
    return true;
  }

  const mask =
    (
      0xffffffff <<
      (
        32 - prefix
      )
    ) >>> 0;

  return (
    sourceInteger & mask
  ) === (
    networkInteger & mask
  );
}

function requestBodyBytes(
  request
) {
  if (
    request.body === undefined ||
    request.body === null
  ) {
    return 0;
  }

  try {
    return Buffer.byteLength(
      JSON.stringify(
        request.body
      ),
      "utf8"
    );
  } catch {
    return 0;
  }
}

function requestPath(
  request
) {
  return String(
    request.originalUrl ||
    request.url ||
    "/"
  );
}

function requestHash(
  request
) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        method:
          request.method,

        path:
          requestPath(
            request
          ),

        body:
          request.body ===
            undefined
            ? null
            : request.body,
      })
    )
    .digest("hex");
}

function statusError(
  statusCode,
  message,
  code
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  error.code =
    code;

  return error;
}

async function loadApiKey(
  rawKey
) {
  const result =
    await query(
      `
        SELECT
          key_record.id,
          key_record.name,
          key_record.type,
          key_record.status,
          key_record.scopes,

          key_record.allowed_app_ids
            AS "allowedAppIds",

          key_record.revoked_at
            AS "revokedAt",

          key_record.expires_at
            AS "expiresAt",

          key_record.organization_id
            AS "organizationId",

          key_record.project_id
            AS "projectId",

          key_record.environment_id
            AS "environmentId",

          key_record.service_account_id
            AS "serviceAccountId",

          key_record.metadata_json
            AS "keyMetadata",

          service_account.name
            AS "serviceAccountName",

          service_account.status
            AS "serviceAccountStatus",

          COALESCE(
            policy.id,
            'default'
          ) AS "policyId",

          COALESCE(
            policy.requests_per_minute,
            120
          ) AS "requestsPerMinute",

          COALESCE(
            policy.burst_limit,
            30
          ) AS "burstLimit",

          COALESCE(
            policy.daily_quota,
            10000
          ) AS "dailyQuota",

          COALESCE(
            policy.max_body_bytes,
            1048576
          ) AS "maxBodyBytes",

          COALESCE(
            policy.require_idempotency,
            FALSE
          ) AS "requireIdempotency",

          COALESCE(
            policy.allowed_cidrs,
            ARRAY['*']::text[]
          ) AS "allowedCidrs",

          COALESCE(
            policy.denied_cidrs,
            ARRAY[]::text[]
          ) AS "deniedCidrs",

          COALESCE(
            policy.status,
            'active'
          ) AS "policyStatus"

        FROM backend_api_keys
             AS key_record

        LEFT JOIN
          backend_service_accounts
             AS service_account
          ON service_account.id =
             key_record.service_account_id

        LEFT JOIN
          backend_api_gateway_policies
             AS policy
          ON policy.api_key_id =
             key_record.id

        WHERE key_record.key_hash =
              $1

        LIMIT 1
      `,
      [
        hashApiKey(
          rawKey
        ),
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

function validateApiKey(
  apiKey
) {
  if (!apiKey) {
    throw statusError(
      401,
      "Invalid API key.",
      "API_KEY_INVALID"
    );
  }

  if (
    apiKey.status !==
      "active" ||
    apiKey.revokedAt
  ) {
    throw statusError(
      401,
      "API key is revoked or inactive.",
      "API_KEY_INACTIVE"
    );
  }

  if (
    apiKey.expiresAt &&
    new Date(
      apiKey.expiresAt
    ) <= new Date()
  ) {
    throw statusError(
      401,
      "API key has expired.",
      "API_KEY_EXPIRED"
    );
  }

  if (
    apiKey.policyStatus !==
      "active"
  ) {
    throw statusError(
      403,
      "API gateway policy is disabled.",
      "GATEWAY_POLICY_DISABLED"
    );
  }

  if (
    apiKey.serviceAccountId &&
    apiKey.serviceAccountStatus !==
      "active"
  ) {
    throw statusError(
      403,
      "The API key service account is disabled.",
      "SERVICE_ACCOUNT_DISABLED"
    );
  }
}

function enforceNetworkPolicy(
  apiKey,
  sourceIp
) {
  const denied =
    Array.isArray(
      apiKey.deniedCidrs
    )
      ? apiKey.deniedCidrs
      : [];

  const allowed =
    Array.isArray(
      apiKey.allowedCidrs
    )
      ? apiKey.allowedCidrs
      : [
          "*",
        ];

  if (
    denied.some(
      rule =>
        ipMatchesRule(
          sourceIp,
          rule
        )
    )
  ) {
    throw statusError(
      403,
      "Source IP is denied by API gateway policy.",
      "SOURCE_IP_DENIED"
    );
  }

  if (
    allowed.length > 0 &&
    !allowed.some(
      rule =>
        ipMatchesRule(
          sourceIp,
          rule
        )
    )
  ) {
    throw statusError(
      403,
      "Source IP is not permitted by API gateway policy.",
      "SOURCE_IP_NOT_ALLOWED"
    );
  }
}

async function consumeRateLimits(
  apiKey
) {
  const minuteResult =
    await query(
      `
        INSERT INTO
          backend_api_gateway_windows (
            api_key_id,
            window_start,
            request_count
          )
        VALUES (
          $1,
          DATE_TRUNC(
            'minute',
            NOW()
          ),
          1
        )
        ON CONFLICT (
          api_key_id,
          window_start
        )
        DO UPDATE SET
          request_count =
            backend_api_gateway_windows
              .request_count + 1,

          updated_at =
            NOW()

        RETURNING
          request_count,

          window_start +
            INTERVAL '1 minute'
              AS reset_at
      `,
      [
        apiKey.id,
      ]
    );

  const minuteCount =
    Number(
      minuteResult.rows[0]
        ?.request_count ||
      0
    );

  const minuteLimit =
    Number(
      apiKey.requestsPerMinute ||
      120
    );

  if (
    minuteCount >
    minuteLimit
  ) {
    const error =
      statusError(
        429,
        "API rate limit exceeded.",
        "RATE_LIMIT_EXCEEDED"
      );

    error.rateLimit = {
      limit:
        minuteLimit,

      remaining:
        0,

      resetAt:
        minuteResult.rows[0]
          ?.reset_at ||
        null,
    };

    throw error;
  }

  const dailyResult =
    await query(
      `
        INSERT INTO
          backend_api_gateway_daily_usage (
            api_key_id,
            usage_date,
            request_count
          )
        VALUES (
          $1,
          CURRENT_DATE,
          1
        )
        ON CONFLICT (
          api_key_id,
          usage_date
        )
        DO UPDATE SET
          request_count =
            backend_api_gateway_daily_usage
              .request_count + 1,

          updated_at =
            NOW()

        RETURNING
          request_count
      `,
      [
        apiKey.id,
      ]
    );

  const dailyCount =
    Number(
      dailyResult.rows[0]
        ?.request_count ||
      0
    );

  const dailyLimit =
    Number(
      apiKey.dailyQuota ||
      10000
    );

  if (
    dailyCount >
    dailyLimit
  ) {
    const error =
      statusError(
        429,
        "Daily API quota exceeded.",
        "DAILY_QUOTA_EXCEEDED"
      );

    error.rateLimit = {
      limit:
        minuteLimit,

      remaining:
        Math.max(
          0,
          minuteLimit -
            minuteCount
        ),

      resetAt:
        minuteResult.rows[0]
          ?.reset_at ||
        null,

      dailyLimit,

      dailyRemaining:
        0,
    };

    throw error;
  }

  return {
    limit:
      minuteLimit,

    remaining:
      Math.max(
        0,
        minuteLimit -
          minuteCount
      ),

    resetAt:
      minuteResult.rows[0]
        ?.reset_at ||
      null,

    dailyLimit,

    dailyRemaining:
      Math.max(
        0,
        dailyLimit -
          dailyCount
      ),
  };
}

function attachRequestLedger({
  request,
  response,
  apiKey,
  gatewayContext,
}) {
  response.once(
    "finish",
    () => {
      const responseBytes =
        Number.parseInt(
          String(
            response.getHeader(
              "Content-Length"
            ) || "0"
          ),
          10
        ) || 0;

      query(
        `
          INSERT INTO
            backend_api_gateway_request_logs (
              id,
              request_id,
              organization_id,
              api_key_id,
              service_account_id,
              method,
              path,
              status_code,
              duration_ms,
              source_ip,
              user_agent,
              idempotency_key,
              idempotent_replay,
              rate_limit,
              rate_limit_remaining,
              daily_quota,
              daily_remaining,
              request_bytes,
              response_bytes,
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
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20::jsonb
          )
        `,
        [
          identifier(
            "apireq"
          ),

          gatewayContext
            .requestId,

          apiKey
            .organizationId ||
          null,

          apiKey.id,

          apiKey
            .serviceAccountId ||
          null,

          request.method,

          requestPath(
            request
          ),

          response.statusCode,

          Date.now() -
            gatewayContext
              .startedAt,

          normalizeIp(
            request.ip ||
            request.socket
              ?.remoteAddress
          ),

          request.get(
            "User-Agent"
          ) || null,

          gatewayContext
            .idempotencyKey ||
          null,

          Boolean(
            gatewayContext
              .idempotentReplay
          ),

          gatewayContext
            .rate?.limit ||
          null,

          gatewayContext
            .rate?.remaining ??
          null,

          gatewayContext
            .rate?.dailyLimit ||
          null,

          gatewayContext
            .rate
            ?.dailyRemaining ??
          null,

          gatewayContext
            .requestBytes,

          responseBytes,

          JSON.stringify({
            policyId:
              apiKey.policyId,

            apiKeyType:
              apiKey.type,

            serviceAccountName:
              apiKey
                .serviceAccountName ||
              null,
          }),
        ]
      ).catch(
        error => {
          console.error(
            "API gateway request ledger failed:",
            error.message
          );
        }
      );

      if (
        apiKey
          .serviceAccountId
      ) {
        query(
          `
            UPDATE backend_service_accounts
            SET
              last_used_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id =
                  $1
          `,
          [
            apiKey
              .serviceAccountId,
          ]
        ).catch(
          () => {}
        );
      }
    }
  );
}

async function processIdempotency({
  request,
  response,
  apiKey,
  gatewayContext,
}) {
  const mutating =
    ![
      "GET",
      "HEAD",
      "OPTIONS",
    ].includes(
      request.method
    );

  if (!mutating) {
    return {
      handled:
        false,
    };
  }

  const idempotencyKey =
    String(
      request.get(
        "Idempotency-Key"
      ) || ""
    )
      .trim()
      .slice(
        0,
        200
      );

  if (
    apiKey
      .requireIdempotency &&
    !idempotencyKey
  ) {
    throw statusError(
      400,
      "Idempotency-Key is required for this API key.",
      "IDEMPOTENCY_KEY_REQUIRED"
    );
  }

  if (!idempotencyKey) {
    return {
      handled:
        false,
    };
  }

  gatewayContext
    .idempotencyKey =
      idempotencyKey;

  const hash =
    requestHash(
      request
    );

  const recordId =
    identifier(
      "idem"
    );

  const insertResult =
    await query(
      `
        INSERT INTO
          backend_api_idempotency_records (
            id,
            api_key_id,
            idempotency_key,
            request_hash,
            request_method,
            request_path,
            status,
            expires_at
          )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'processing',
          NOW() +
            INTERVAL '24 hours'
        )
        ON CONFLICT (
          api_key_id,
          idempotency_key
        )
        DO NOTHING

        RETURNING id
      `,
      [
        recordId,
        apiKey.id,
        idempotencyKey,
        hash,
        request.method,
        requestPath(
          request
        ),
      ]
    );

  if (
    insertResult.rowCount === 1
  ) {
    request
      .gatewayIdempotency = {
        id:
          recordId,

        hash,
      };

    return {
      handled:
        false,
    };
  }

  const existingResult =
    await query(
      `
        SELECT
          id,
          request_hash,
          status,
          response_status,
          response_headers,
          response_body,
          expires_at

        FROM backend_api_idempotency_records

        WHERE api_key_id =
              $1

          AND idempotency_key =
              $2

        LIMIT 1
      `,
      [
        apiKey.id,
        idempotencyKey,
      ]
    );

  const existing =
    existingResult.rows[0];

  if (!existing) {
    throw statusError(
      409,
      "Idempotency record could not be resolved.",
      "IDEMPOTENCY_CONFLICT"
    );
  }

  if (
    existing.request_hash !==
    hash
  ) {
    throw statusError(
      409,
      "Idempotency-Key was already used with a different request.",
      "IDEMPOTENCY_PAYLOAD_MISMATCH"
    );
  }

  if (
    existing.status ===
      "completed"
  ) {
    gatewayContext
      .idempotentReplay =
        true;

    response.set(
      "X-GoodOS-Idempotent-Replay",
      "true"
    );

    response.set(
      "Idempotency-Key",
      idempotencyKey
    );

    response
      .status(
        existing.response_status ||
        200
      )
      .json(
        existing.response_body ||
        {}
      );

    return {
      handled:
        true,
    };
  }

  throw statusError(
    409,
    "An identical request is already being processed.",
    "IDEMPOTENCY_IN_PROGRESS"
  );
}

async function completeIdempotency(
  request,
  statusCode,
  responseBody,
  responseHeaders = {}
) {
  const record =
    request
      .gatewayIdempotency;

  if (!record?.id) {
    return;
  }

  await query(
    `
      UPDATE backend_api_idempotency_records
      SET
        status =
          'completed',

        response_status =
          $2,

        response_headers =
          $3::jsonb,

        response_body =
          $4::jsonb,

        updated_at =
          NOW()

      WHERE id =
            $1
    `,
    [
      record.id,
      statusCode,
      JSON.stringify(
        responseHeaders
      ),
      JSON.stringify(
        responseBody
      ),
    ]
  );
}

async function authenticateAndEnforce(
  request,
  response,
  next
) {
  const gatewayContext = {
    requestId:
      request.get(
        "X-Request-ID"
      ) ||
      identifier(
        "req"
      ),

    startedAt:
      Date.now(),

    requestBytes:
      requestBodyBytes(
        request
      ),

    rate:
      null,

    idempotencyKey:
      null,

    idempotentReplay:
      false,
  };

  request.gatewayContext =
    gatewayContext;

  response.set(
    "X-Request-ID",
    gatewayContext
      .requestId
  );

  try {
    const rawKey =
      extractApiKey(
        request
      );

    if (!rawKey) {
      throw statusError(
        401,
        "API key required.",
        "API_KEY_REQUIRED"
      );
    }

    const apiKey =
      await loadApiKey(
        rawKey
      );

    validateApiKey(
      apiKey
    );

    request.goodosApiKey =
      apiKey;

    attachRequestLedger({
      request,
      response,
      apiKey,
      gatewayContext,
    });

    const sourceIp =
      normalizeIp(
        request.ip ||
        request.socket
          ?.remoteAddress
      );

    enforceNetworkPolicy(
      apiKey,
      sourceIp
    );

    if (
      gatewayContext
        .requestBytes >
      Number(
        apiKey.maxBodyBytes ||
        1048576
      )
    ) {
      throw statusError(
        413,
        "Request body exceeds the API gateway policy limit.",
        "REQUEST_BODY_TOO_LARGE"
      );
    }

    const rate =
      await consumeRateLimits(
        apiKey
      );

    gatewayContext.rate =
      rate;

    response.set(
      "X-RateLimit-Limit",
      String(
        rate.limit
      )
    );

    response.set(
      "X-RateLimit-Remaining",
      String(
        rate.remaining
      )
    );

    response.set(
      "X-RateLimit-Reset",
      String(
        rate.resetAt ||
        ""
      )
    );

    response.set(
      "X-DailyQuota-Limit",
      String(
        rate.dailyLimit
      )
    );

    response.set(
      "X-DailyQuota-Remaining",
      String(
        rate.dailyRemaining
      )
    );

    const idempotency =
      await processIdempotency({
        request,
        response,
        apiKey,
        gatewayContext,
      });

    if (
      idempotency.handled
    ) {
      return;
    }

    await query(
      `
        UPDATE backend_api_keys
        SET
          last_used_at =
            NOW(),

          updated_at =
            NOW()

        WHERE id =
              $1
      `,
      [
        apiKey.id,
      ]
    );

    return next();
  } catch (error) {
    if (
      error.rateLimit
    ) {
      response.set(
        "X-RateLimit-Limit",
        String(
          error.rateLimit
            .limit ||
          0
        )
      );

      response.set(
        "X-RateLimit-Remaining",
        String(
          error.rateLimit
            .remaining ||
          0
        )
      );

      if (
        error.rateLimit
          .resetAt
      ) {
        response.set(
          "X-RateLimit-Reset",
          String(
            error.rateLimit
              .resetAt
          )
        );
      }
    }

    return response
      .status(
        error.statusCode ||
        500
      )
      .json({
        success: false,

        code:
          error.code ||
          "API_GATEWAY_FAILED",

        message:
          error.message ||
          "API gateway request failed.",

        requestId:
          gatewayContext
            .requestId,
      });
  }
}

function hasScope(
  apiKey,
  requiredScope
) {
  const scopes =
    Array.isArray(
      apiKey?.scopes
    )
      ? apiKey.scopes
      : [];

  const type =
    String(
      apiKey?.type ||
      ""
    ).toLowerCase();

  if (
    [
      "full_access",
      "admin",
      "owner",
    ].includes(type)
  ) {
    return true;
  }

  if (
    scopes.includes("*") ||
    scopes.includes(
      requiredScope
    )
  ) {
    return true;
  }

  const [
    family,
  ] = requiredScope.split(
    ":"
  );

  return (
    scopes.includes(
      `${family}:*`
    ) ||
    (
      requiredScope
        .startsWith(
          "read:"
        ) &&
      scopes.includes(
        "read:*"
      )
    )
  );
}

function requireScope(
  requiredScope
) {
  return (
    request,
    response,
    next
  ) => {
    if (
      !hasScope(
        request.goodosApiKey,
        requiredScope
      )
    ) {
      return response
        .status(403)
        .json({
          success: false,

          code:
            "API_SCOPE_REQUIRED",

          message:
            `API key requires scope: ${requiredScope}`,

          requiredScope,

          requestId:
            request.gatewayContext
              ?.requestId ||
            null,
        });
    }

    return next();
  };
}

module.exports = {
  authenticateAndEnforce,
  completeIdempotency,
  hasScope,
  requireScope,
};
