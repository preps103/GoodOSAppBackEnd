const crypto = require("crypto");
const express = require("express");
const { Kind, parse } = require("graphql");

const database = require("../config/database");
const {
  dataPlaneAuth,
} = require("./data-plane.routes");

const router = express.Router();
const healthRouter = express.Router();

const API_SCHEMA =
  process.env.GOODBASE_DATA_API_SCHEMA ||
  "goodos_api";

function httpError(statusCode, code, message) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.code = code;

  return error;
}

function byteLength(value) {
  return Buffer.byteLength(
    JSON.stringify(value ?? null),
    "utf8"
  );
}

function queryHash(query) {
  return crypto
    .createHash("sha256")
    .update(String(query), "utf8")
    .digest("hex");
}

function analyzeGraphQL(
  query,
  operationName,
  limits
) {
  let document;

  try {
    document = parse(query, {
      maxTokens: 20000,
    });
  } catch {
    throw httpError(
      400,
      "GOODBASE_GRAPHQL_PARSE_FAILED",
      "GraphQL query syntax is invalid."
    );
  }

  const operations =
    document.definitions.filter(
      (definition) =>
        definition.kind ===
        Kind.OPERATION_DEFINITION
    );

  const fragments = new Map(
    document.definitions
      .filter(
        (definition) =>
          definition.kind ===
          Kind.FRAGMENT_DEFINITION
      )
      .map(
        (definition) => [
          definition.name.value,
          definition,
        ]
      )
  );

  let operation;

  if (operationName) {
    operation = operations.find(
      (item) =>
        item.name?.value === operationName
    );
  } else if (operations.length === 1) {
    [operation] = operations;
  }

  if (!operation) {
    throw httpError(
      400,
      "GOODBASE_GRAPHQL_OPERATION_REQUIRED",
      "A valid operationName is required."
    );
  }

  const metrics = {
    operationName:
      operationName ||
      operation.name?.value ||
      null,
    operationType:
      operation.operation,
    depth: 0,
    complexity: 0,
    aliases: 0,
    introspection: false,
  };

  function walk(
    selectionSet,
    depth,
    seenFragments
  ) {
    if (!selectionSet) return;

    metrics.depth = Math.max(
      metrics.depth,
      depth
    );

    for (
      const selection
      of selectionSet.selections
    ) {
      if (
        selection.kind ===
        Kind.FIELD
      ) {
        metrics.complexity += 1;

        if (selection.alias) {
          metrics.aliases += 1;
        }

        if (
          selection.name.value.startsWith(
            "__"
          )
        ) {
          metrics.introspection = true;
        }

        walk(
          selection.selectionSet,
          depth + 1,
          seenFragments
        );

        continue;
      }

      if (
        selection.kind ===
        Kind.INLINE_FRAGMENT
      ) {
        walk(
          selection.selectionSet,
          depth,
          seenFragments
        );

        continue;
      }

      if (
        selection.kind ===
        Kind.FRAGMENT_SPREAD
      ) {
        const name =
          selection.name.value;

        if (seenFragments.has(name)) {
          throw httpError(
            400,
            "GOODBASE_GRAPHQL_FRAGMENT_CYCLE",
            "GraphQL fragment cycles are not allowed."
          );
        }

        const fragment =
          fragments.get(name);

        if (!fragment) {
          throw httpError(
            400,
            "GOODBASE_GRAPHQL_UNKNOWN_FRAGMENT",
            "GraphQL query contains an unknown fragment."
          );
        }

        const nextSeen =
          new Set(seenFragments);

        nextSeen.add(name);

        walk(
          fragment.selectionSet,
          depth,
          nextSeen
        );
      }
    }
  }

  walk(
    operation.selectionSet,
    1,
    new Set()
  );

  if (
    metrics.depth >
    limits.maxDepth
  ) {
    throw httpError(
      400,
      "GOODBASE_GRAPHQL_DEPTH_LIMIT",
      "GraphQL query depth limit exceeded."
    );
  }

  if (
    metrics.complexity >
    limits.maxComplexity
  ) {
    throw httpError(
      400,
      "GOODBASE_GRAPHQL_COMPLEXITY_LIMIT",
      "GraphQL query complexity limit exceeded."
    );
  }

  if (
    metrics.aliases >
    limits.maxAliases
  ) {
    throw httpError(
      400,
      "GOODBASE_GRAPHQL_ALIAS_LIMIT",
      "GraphQL alias limit exceeded."
    );
  }

  return metrics;
}

async function getSettings() {
  const result =
    await database.query(`
      SELECT
        introspection_enabled
          AS "introspectionEnabled",
        max_depth
          AS "maxDepth",
        max_complexity
          AS "maxComplexity",
        max_aliases
          AS "maxAliases",
        max_query_bytes
          AS "maxQueryBytes",
        max_variable_bytes
          AS "maxVariableBytes",
        execution_timeout_ms
          AS "executionTimeoutMs"
      FROM backend_graphql_settings
      WHERE id = 'default'
      LIMIT 1
    `);

  return result.rows[0];
}

async function logOperation(
  request,
  details
) {
  await database.query(
    `
      INSERT INTO backend_graphql_operation_logs (
        id,
        request_id,
        query_hash,
        operation_name,
        operation_type,
        user_id,
        session_id,
        response_status,
        duration_ms,
        depth,
        complexity,
        alias_count,
        request_bytes,
        response_bytes,
        introspection,
        has_errors,
        error_codes,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::uuid,
        $7::uuid,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17::jsonb,
        NOW()
      )
    `,
    [
      `gql_${crypto
        .randomUUID()
        .replaceAll("-", "")}`,
      request.id ||
        request.get("x-request-id") ||
        null,
      details.queryHash,
      details.operationName,
      details.operationType,
      request.user?.id || null,
      request.auth?.sessionId || null,
      details.status,
      details.duration,
      details.depth,
      details.complexity,
      details.aliases,
      details.requestBytes,
      details.responseBytes,
      details.introspection,
      details.hasErrors,
      JSON.stringify(
        details.errorCodes || []
      ),
    ]
  );
}

async function executeGraphQL(
  request,
  input,
  timeoutMs
) {
  const client =
    await database.pool.connect();

  const claims = {
    ...(request.auth?.decoded || {}),
    sub: request.user.id,
    sid: request.auth.sessionId,
    email: request.user.email,
    role: "goodos_authenticated",
    tokenUse: "data_plane",
    aal:
      request.auth.authLevel ||
      "password",
    mfaVerified:
      Boolean(
        request.auth.mfaVerified
      ),
  };

  try {
    await client.query("BEGIN");

    await client.query(
      "SET LOCAL ROLE goodos_authenticated"
    );

    await client.query(
      `
        SELECT set_config(
          'request.jwt.claims',
          $1,
          TRUE
        )
      `,
      [JSON.stringify(claims)]
    );

    await client.query(
      `
        SELECT set_config(
          'statement_timeout',
          $1,
          TRUE
        )
      `,
      [`${timeoutMs}ms`]
    );

    await client.query(
      `
        SELECT set_config(
          'search_path',
          $1,
          TRUE
        )
      `,
      [
        `${API_SCHEMA},goodos_auth,graphql,pg_temp`,
      ]
    );

    await client.query(
      "SELECT goodos_auth.check_session()"
    );

    const result =
      await client.query(
        `
          SELECT graphql.resolve(
            query => $1::text,
            variables => $2::jsonb,
            "operationName" => $3::text,
            extensions => $4::jsonb
          ) AS response
        `,
        [
          input.query,
          JSON.stringify(
            input.variables || {}
          ),
          input.operationName || null,
          JSON.stringify(
            input.extensions || {}
          ),
        ]
      );

    await client.query("COMMIT");

    return (
      result.rows[0]?.response || {
        data: null,
      }
    );
  } catch (error) {
    await client
      .query("ROLLBACK")
      .catch(() => null);

    throw error;
  } finally {
    client.release();
  }
}

healthRouter.get(
  "/health",
  async (
    request,
    response
  ) => {
    response.set(
      "Cache-Control",
      "no-store"
    );

    try {
      const result =
        await database.query(`
          SELECT
            extversion AS version,
            to_regnamespace(
              'graphql'
            ) IS NOT NULL
              AS schema_ready,
            to_regprocedure(
              'graphql.resolve(text,jsonb,text,jsonb)'
            ) IS NOT NULL
              AS resolver_ready
          FROM pg_extension
          WHERE extname = 'pg_graphql'
        `);

      const state =
        result.rows[0];

      const healthy =
        Boolean(
          state?.schema_ready &&
          state?.resolver_ready
        );

      return response
        .status(
          healthy ? 200 : 503
        )
        .json({
          success: healthy,
          service:
            "Goodbase Automatic GraphQL",
          status:
            healthy
              ? "operational"
              : "degraded",
          endpoint:
            "https://base.goodos.app/graphql/v1",
          version:
            state?.version || null,
        });
    } catch {
      return response
        .status(503)
        .json({
          success: false,
          service:
            "Goodbase Automatic GraphQL",
          status: "degraded",
        });
    }
  }
);

router.use(dataPlaneAuth);

router.post(
  "/",
  async (
    request,
    response
  ) => {
    const startedAt =
      Date.now();

    const requestBytes =
      byteLength(
        request.body
      );

    let metrics = {
      operationName: null,
      operationType: null,
      depth: 0,
      complexity: 0,
      aliases: 0,
      introspection: false,
    };

    let currentHash =
      queryHash("");

    response.set(
      "Cache-Control",
      "no-store"
    );

    response.set(
      "X-Content-Type-Options",
      "nosniff"
    );

    response.set(
      "X-Goodbase-Data-Plane",
      "pg_graphql-1.6.1"
    );

    try {
      if (
        !request.is(
          "application/json"
        )
      ) {
        throw httpError(
          415,
          "GOODBASE_GRAPHQL_CONTENT_TYPE_REQUIRED",
          "GraphQL requires application/json."
        );
      }

      const limits =
        await getSettings();

      const body =
        request.body || {};

      const query =
        String(
          body.query || ""
        ).trim();

      if (!query) {
        throw httpError(
          400,
          "GOODBASE_GRAPHQL_QUERY_REQUIRED",
          "GraphQL query is required."
        );
      }

      if (
        Buffer.byteLength(
          query,
          "utf8"
        ) >
        limits.maxQueryBytes
      ) {
        throw httpError(
          413,
          "GOODBASE_GRAPHQL_QUERY_SIZE_LIMIT",
          "GraphQL query is too large."
        );
      }

      if (
        byteLength(
          body.variables || {}
        ) >
        limits.maxVariableBytes
      ) {
        throw httpError(
          413,
          "GOODBASE_GRAPHQL_VARIABLE_SIZE_LIMIT",
          "GraphQL variables are too large."
        );
      }

      currentHash =
        queryHash(query);

      metrics =
        analyzeGraphQL(
          query,
          body.operationName || null,
          limits
        );

      if (
        metrics.introspection &&
        !limits.introspectionEnabled
      ) {
        throw httpError(
          403,
          "GOODBASE_GRAPHQL_INTROSPECTION_DISABLED",
          "GraphQL introspection is disabled."
        );
      }

      const payload =
        await executeGraphQL(
          request,
          {
            query,
            variables:
              body.variables || {},
            operationName:
              metrics.operationName,
            extensions:
              body.extensions || {},
          },
          limits.executionTimeoutMs
        );

      const errorCodes =
        Array.isArray(
          payload?.errors
        )
          ? [
              ...new Set(
                payload.errors.map(
                  (item) =>
                    item?.extensions
                      ?.code ||
                    "GRAPHQL_ERROR"
                )
              ),
            ]
          : [];

      await logOperation(
        request,
        {
          queryHash:
            currentHash,
          ...metrics,
          status: 200,
          duration:
            Date.now() -
            startedAt,
          requestBytes,
          responseBytes:
            byteLength(payload),
          hasErrors:
            errorCodes.length >
            0,
          errorCodes,
        }
      ).catch(() => null);

      return response.json(
        payload
      );
    } catch (error) {
      const status =
        error.statusCode ||
        (
          error.code ===
          "57014"
            ? 408
            : 500
        );

      const code =
        error.code ===
          "57014"
          ? "GOODBASE_GRAPHQL_EXECUTION_TIMEOUT"
          : error.code ||
            "GOODBASE_GRAPHQL_FAILED";

      await logOperation(
        request,
        {
          queryHash:
            currentHash,
          ...metrics,
          status,
          duration:
            Date.now() -
            startedAt,
          requestBytes,
          responseBytes: 0,
          hasErrors: true,
          errorCodes: [code],
        }
      ).catch(() => null);

      return response
        .status(status)
        .json({
          data: null,
          errors: [
            {
              message:
                status >= 500
                  ? "Goodbase GraphQL is temporarily unavailable."
                  : error.message,
              extensions: {
                code,
              },
            },
          ],
        });
    }
  }
);

router.all(
  "/",
  (
    request,
    response
  ) => {
    response.set(
      "Allow",
      "POST"
    );

    return response
      .status(405)
      .json({
        data: null,
        errors: [
          {
            message:
              "Goodbase GraphQL accepts POST requests only.",
            extensions: {
              code:
                "GOODBASE_GRAPHQL_METHOD_NOT_ALLOWED",
            },
          },
        ],
      });
  }
);

module.exports = {
  router,
  healthRouter,
  __test: {
    analyzeGraphQL,
    queryHash,
    byteLength,
  },
};
