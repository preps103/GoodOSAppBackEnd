const express = require("express");
const crypto = require("crypto");
const database = require("../config/database");

const router = express.Router();

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

function extractApiKey(req) {
  const headerKey = req.get("X-GoodOS-API-Key");
  if (headerKey) return headerKey.trim();

  const auth = req.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return "";
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}

function hasScope(apiKey, requiredScope) {
  const scopes = normalizeList(apiKey.scopes, []);
  const type = String(apiKey.type || "").toLowerCase();

  if (type === "full_access" || type === "admin" || type === "owner") return true;
  if (scopes.includes("*")) return true;
  if (scopes.includes(requiredScope)) return true;

  const [family] = requiredScope.split(":");
  if (scopes.includes(`${family}:*`)) return true;

  if (requiredScope.startsWith("read:") && scopes.includes("read:*")) return true;
  if (requiredScope.startsWith("write:") && scopes.includes("write:*")) return true;

  return false;
}

function allowedApps(apiKey) {
  return normalizeList(apiKey.allowedAppIds || apiKey.allowed_app_ids, ["*"]);
}

async function apiKeyRequired(req, res, next) {
  try {
    const key = extractApiKey(req);

    if (!key) {
      return res.status(401).json({
        success: false,
        message: "API key required. Use X-GoodOS-API-Key or Authorization: Bearer.",
      });
    }

    const keyHash = hashKey(key);

    const result = await dbQuery(
      `
        SELECT
          id,
          name,
          type,
          key_prefix AS "keyPrefix",
          key_hash AS "keyHash",
          scopes,
          allowed_app_ids AS "allowedAppIds",
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          last_used_at AS "lastUsedAt",
          revoked_at AS "revokedAt",
          organization_id AS "organizationId",
          project_id AS "projectId",
          environment_id AS "environmentId"
        FROM backend_api_keys
        WHERE key_hash = $1
        LIMIT 1
      `,
      [keyHash]
    );

    const apiKey = result.rows[0];

    if (!apiKey || apiKey.status !== "active" || apiKey.revokedAt) {
      return res.status(401).json({
        success: false,
        message: "Invalid or revoked API key.",
      });
    }

    await dbQuery(
      `
        UPDATE backend_api_keys
        SET last_used_at = NOW()
        WHERE id = $1
      `,
      [apiKey.id]
    );

    req.goodosApiKey = apiKey;
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "API key validation failed.",
      detail: error.message,
    });
  }
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req.goodosApiKey, scope)) {
      return res.status(403).json({
        success: false,
        message: `API key missing required scope: ${scope}`,
        requiredScope: scope,
        keyScopes: req.goodosApiKey.scopes || [],
      });
    }

    return next();
  };
}




function policyContextList(value, fallback = []) {
  return normalizeList(value, fallback);
}

function policyIntersects(left = [], right = []) {
  const a = policyContextList(left, []);
  const b = policyContextList(right, []);
  if (a.includes("*") || b.includes("*")) return true;
  return a.some((item) => b.includes(item));
}

function policyConditionMatches(policy, context = {}) {
  const condition = policy.conditionJson || {};
  const apiKey = context.apiKey || {};
  const apiKeyScopes = policyContextList(apiKey.scopes, []);
  const apiKeyAllowedApps = allowedApps(apiKey);

  const requiredScopes = policyContextList(condition.requiredScopes || condition.required_scopes, []);
  if (requiredScopes.length && !requiredScopes.every((scope) => hasScope(apiKey, scope))) return false;

  const anyScopes = policyContextList(condition.anyScopes || condition.any_scopes, []);
  if (anyScopes.length && !anyScopes.some((scope) => hasScope(apiKey, scope))) return false;

  const deniedScopes = policyContextList(condition.deniedScopes || condition.denied_scopes, []);
  if (deniedScopes.length && deniedScopes.some((scope) => apiKeyScopes.includes(scope))) return false;

  const allowedAppIds = policyContextList(condition.allowedAppIds || condition.allowed_app_ids, []);
  if (allowedAppIds.length && !policyIntersects(allowedAppIds, apiKeyAllowedApps)) return false;

  const deniedAppIds = policyContextList(condition.deniedAppIds || condition.denied_app_ids, []);
  if (deniedAppIds.length && policyIntersects(deniedAppIds, apiKeyAllowedApps)) return false;

  const apiKeyIds = policyContextList(condition.apiKeyIds || condition.api_key_ids, []);
  if (apiKeyIds.length && !apiKeyIds.includes(String(apiKey.id || ""))) return false;

  const projectIds = policyContextList(condition.projectIds || condition.project_ids, []);
  if (projectIds.length && !projectIds.includes(String(apiKey.projectId || context.projectId || ""))) return false;

  const environmentIds = policyContextList(condition.environmentIds || condition.environment_ids, []);
  if (environmentIds.length && !environmentIds.includes(String(apiKey.environmentId || context.environmentId || ""))) return false;

  const tableSlugs = policyContextList(condition.tableSlugs || condition.table_slugs, []);
  if (tableSlugs.length && !tableSlugs.includes(String(context.tableSlug || context.apiSlug || ""))) return false;

  const tableNames = policyContextList(condition.tableNames || condition.table_names, []);
  if (tableNames.length && !tableNames.includes(String(context.tableName || ""))) return false;

  return true;
}

async function logGoodOSPolicyEvaluation({
  policyId = null,
  decision = "allow",
  reason = "",
  targetType,
  targetId,
  operation,
  actorType = "api_key",
  actorId = null,
  apiKey = {},
  context = {},
} = {}) {
  try {
    await dbQuery(
      `
        INSERT INTO backend_policy_evaluations (
          id,
          policy_id,
          decision,
          reason,
          target_type,
          target_id,
          operation,
          actor_type,
          actor_id,
          api_key_id,
          organization_id,
          project_id,
          environment_id,
          context_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      `,
      [
        `poleval_${crypto.randomUUID().replace(/-/g, "")}`,
        policyId,
        decision,
        reason,
        String(targetType || "*"),
        String(targetId || "*"),
        String(operation || "*"),
        actorType,
        actorId,
        apiKey.id || null,
        apiKey.organizationId || context.organizationId || null,
        apiKey.projectId || context.projectId || null,
        apiKey.environmentId || context.environmentId || null,
        JSON.stringify({
          ...context,
          apiKey: apiKey.id
            ? {
                id: apiKey.id,
                name: apiKey.name,
                type: apiKey.type,
                scopes: apiKey.scopes || [],
                allowedAppIds: apiKey.allowedAppIds || [],
              }
            : null,
        }),
      ]
    );
  } catch {
    // Policy evaluation logging must never break public API traffic.
  }
}

async function evaluateGoodOSPolicy({
  targetType,
  targetId = "*",
  operation = "*",
  actorType = "api_key",
  actorId = null,
  apiKey = {},
  context = {},
} = {}) {
  const result = await dbQuery(
    `
      SELECT
        id,
        name,
        description,
        target_type AS "targetType",
        target_id AS "targetId",
        operation,
        effect,
        priority,
        condition_json AS "conditionJson",
        message,
        status,
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId"
      FROM backend_policy_rules
      WHERE status = 'active'
        AND (target_type = '*' OR target_type = $1)
        AND (target_id = '*' OR target_id = $2)
        AND (operation = '*' OR operation = $3)
      ORDER BY priority ASC, created_at ASC
    `,
    [String(targetType || "*"), String(targetId || "*"), String(operation || "*")]
  );

  const matchedPolicies = result.rows.filter((policy) => policyConditionMatches(policy, {
    ...context,
    targetType,
    targetId,
    operation,
    apiKey,
  }));

  const denyPolicy = matchedPolicies.find((policy) => String(policy.effect || "").toLowerCase() === "deny");
  const allowPolicy = matchedPolicies.find((policy) => String(policy.effect || "").toLowerCase() === "allow");

  if (denyPolicy) {
    const decision = {
      allowed: false,
      decision: "deny",
      policyId: denyPolicy.id,
      policyName: denyPolicy.name,
      reason: denyPolicy.message || "Request denied by GoodOS policy.",
    };

    await logGoodOSPolicyEvaluation({
      policyId: denyPolicy.id,
      decision: "deny",
      reason: decision.reason,
      targetType,
      targetId,
      operation,
      actorType,
      actorId,
      apiKey,
      context,
    });

    return decision;
  }

  if (allowPolicy) {
    const decision = {
      allowed: true,
      decision: "allow",
      policyId: allowPolicy.id,
      policyName: allowPolicy.name,
      reason: allowPolicy.message || "Request allowed by GoodOS policy.",
    };

    await logGoodOSPolicyEvaluation({
      policyId: allowPolicy.id,
      decision: "allow",
      reason: decision.reason,
      targetType,
      targetId,
      operation,
      actorType,
      actorId,
      apiKey,
      context,
    });

    return decision;
  }

  const decision = {
    allowed: true,
    decision: "allow",
    policyId: null,
    policyName: null,
    reason: "No matching policy. Existing API scope/table controls allowed the request.",
  };

  await logGoodOSPolicyEvaluation({
    policyId: null,
    decision: "allow",
    reason: decision.reason,
    targetType,
    targetId,
    operation,
    actorType,
    actorId,
    apiKey,
    context,
  });

  return decision;
}

async function enforceGoodOSPolicy(params = {}) {
  const decision = await evaluateGoodOSPolicy(params);

  if (!decision.allowed) {
    const error = new Error(decision.reason || "Denied by GoodOS policy.");
    error.statusCode = 403;
    error.policyDecision = decision;
    throw error;
  }

  return decision;
}

function functionSlugFromPath(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/^api\/v1\/functions\//, "")
    .replace(/^api\/functions\//, "")
    .replace(/^functions\//, "")
    .replace(/[^a-zA-Z0-9:_-]/g, "-")
    .slice(0, 120);
}

function normalizePublicFunctionInput(req) {
  if (req.method === "GET") {
    return {
      query: req.query || {},
      method: "GET",
      calledAt: new Date().toISOString(),
    };
  }

  return {
    ...(req.body && typeof req.body === "object" ? req.body : {}),
    method: req.method,
    calledAt: new Date().toISOString(),
  };
}

async function executePublicControlledFunction(fn, input = {}, apiKey = {}) {
  const startedAt = Date.now();
  const id = String(fn.id || "");
  const routePath = String(fn.route_path || fn.routePath || "");
  const triggerType = String(fn.trigger_type || fn.triggerType || "manual");
  const type = String(fn.type || "http");

  if (id === "fn_http_health_check" || routePath === "/api/functions/health-check") {
    const dbTime = await dbQuery("SELECT NOW() AS now");

    return {
      status: "success",
      output: {
        ok: true,
        functionId: id,
        name: fn.name,
        routePath,
        type,
        triggerType,
        service: "GoodAppBackEnd Public Callable Function",
        runtime: process.version,
        databaseTime: dbTime.rows[0]?.now || null,
        uptimeSeconds: Math.floor(process.uptime()),
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          type: apiKey.type,
          scopes: apiKey.scopes || [],
          allowedAppIds: apiKey.allowedAppIds || [],
        },
        input,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  if (id === "fn_event_webhook_dispatcher" || triggerType === "webhook.event") {
    const eventPayload = {
      id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      eventType: String(input.eventType || "public.function.event"),
      source: "public-callable-function",
      message: String(input.message || "Public callable function event created."),
      payload: {
        functionId: id,
        functionName: fn.name,
        input,
      },
    };

    await dbQuery(
      `
        INSERT INTO backend_events (id, event_type, source, message, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        eventPayload.id,
        eventPayload.eventType,
        eventPayload.source,
        eventPayload.message,
        JSON.stringify(eventPayload.payload),
      ]
    );

    return {
      status: "success",
      output: {
        ok: true,
        functionId: id,
        name: fn.name,
        createdEvent: eventPayload,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    status: "success",
    output: {
      ok: true,
      functionId: id,
      name: fn.name,
      type,
      triggerType,
      note: "Public controlled function executed.",
      input,
    },
    durationMs: Date.now() - startedAt,
  };
}

async function runPublicEdgeFunction(fn, input = {}, apiKey = {}) {
  const runId = `fnrun_${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = Date.now();

  await dbQuery(
    `
      INSERT INTO backend_edge_function_runs (
        id,
        function_id,
        function_name,
        trigger_type,
        status,
        input_json,
        created_by
      )
      VALUES ($1, $2, $3, 'public_api', 'started', $4::jsonb, $5)
    `,
    [
      runId,
      fn.id,
      fn.name,
      JSON.stringify(input || {}),
      apiKey.id || "public-api-key",
    ]
  );

  try {
    const execution = await executePublicControlledFunction(fn, input, apiKey);
    const durationMs = Number(execution.durationMs || (Date.now() - startedAt));

    const runResult = await dbQuery(
      `
        UPDATE backend_edge_function_runs
        SET
          status = $2,
          output_json = $3::jsonb,
          error_message = NULL,
          duration_ms = $4,
          completed_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          function_id AS "functionId",
          function_name AS "functionName",
          trigger_type AS "triggerType",
          status,
          input_json AS "input",
          output_json AS "output",
          error_message AS "errorMessage",
          duration_ms AS "durationMs",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_by AS "createdBy"
      `,
      [
        runId,
        execution.status || "success",
        JSON.stringify(execution.output || {}),
        durationMs,
      ]
    );

    await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          last_run_at = NOW(),
          last_status = $2,
          last_error = NULL,
          run_count = run_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [fn.id, execution.status || "success"]
    );

    return runResult.rows[0];
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    const runResult = await dbQuery(
      `
        UPDATE backend_edge_function_runs
        SET
          status = 'failed',
          error_message = $2,
          duration_ms = $3,
          completed_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          function_id AS "functionId",
          function_name AS "functionName",
          trigger_type AS "triggerType",
          status,
          input_json AS "input",
          output_json AS "output",
          error_message AS "errorMessage",
          duration_ms AS "durationMs",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_by AS "createdBy"
      `,
      [runId, error.message, durationMs]
    );

    await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          last_run_at = NOW(),
          last_status = 'failed',
          last_error = $2,
          run_count = run_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [fn.id, error.message]
    );

    return runResult.rows[0];
  }
}

async function publicCallableFunctionHandler(req, res) {
  try {
    const slug = functionSlugFromPath(req.params.slug || req.params[0] || "");

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Function slug is required.",
      });
    }

    const routePath = `/api/functions/${slug}`;

    const functionResult = await dbQuery(
      `
        SELECT
          id,
          name,
          type,
          runtime,
          trigger_type,
          route_path,
          schedule,
          description,
          status,
          timeout_seconds,
          run_count,
          last_status,
          last_error,
          last_run_at,
          created_at,
          updated_at
        FROM backend_edge_functions
        WHERE
          id = $1
          OR route_path = $2
          OR route_path = $3
        LIMIT 1
      `,
      [
        slug,
        routePath,
        `/api/v1/functions/${slug}`,
      ]
    );

    const fn = functionResult.rows[0];

    if (!fn) {
      return res.status(404).json({
        success: false,
        message: `Callable function not found: ${slug}`,
      });
    }

    if (fn.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Callable function is not active.",
        functionId: fn.id,
        status: fn.status,
      });
    }

    if (fn.type !== "http") {
      return res.status(400).json({
        success: false,
        message: "Only HTTP Edge Functions can be called through the public function endpoint.",
        functionId: fn.id,
        type: fn.type,
      });
    }

    const input = normalizePublicFunctionInput(req);

    await enforceGoodOSPolicy({
      targetType: "function",
      targetId: fn.id,
      operation: "execute",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        functionId: fn.id,
        functionName: fn.name,
        routePath: fn.route_path,
        method: req.method,
        inputPreview: input,
      }
    });

    const run = await runPublicEdgeFunction(fn, input, req.goodosApiKey);

    return res.json({
      success: run.status !== "failed",
      data: {
        function: {
          id: fn.id,
          name: fn.name,
          routePath: fn.route_path,
          status: fn.status,
        },
        run: {
          id: run.id,
          status: run.status,
          durationMs: run.durationMs,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        },
        output: run.output,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Callable function execution failed.",
      detail: error.message,
    });
  }
}

router.get("/health", apiKeyRequired, requireScope("read:health"), async (req, res) => {
  return res.json({
    success: true,
    service: "GoodAppBackEnd Public API",
    status: "ok",
    apiKey: {
      id: req.goodosApiKey.id,
      name: req.goodosApiKey.name,
      type: req.goodosApiKey.type,
      scopes: req.goodosApiKey.scopes || [],
      allowedAppIds: req.goodosApiKey.allowedAppIds || [],
    },
    time: new Date().toISOString(),
  });
});

router.get("/apps", apiKeyRequired, requireScope("read:apps"), async (req, res) => {
  try {
    const appIds = allowedApps(req.goodosApiKey);
    const unrestricted = appIds.includes("*");

    const result = await dbQuery(
      `
        SELECT
          a.id,
          a.name,
          a.domain,
          a.status,
          COUNT(m.user_id)::int AS "memberCount"
        FROM apps a
        LEFT JOIN app_memberships m ON m.app_id = a.id AND m.status = 'active'
        WHERE ($1::boolean = true OR a.id = ANY($2::text[]))
        GROUP BY a.id, a.name, a.domain, a.status
        ORDER BY a.name ASC
      `,
      [unrestricted, appIds]
    );

    return res.json({
      success: true,
      data: {
        apps: result.rows,
        access: {
          unrestricted,
          allowedAppIds: appIds,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load apps.",
      detail: error.message,
    });
  }
});

router.get("/storage/buckets", apiKeyRequired, requireScope("read:storage"), async (req, res) => {
  try {
    await enforceGoodOSPolicy({
      targetType: "storage",
      targetId: "buckets",
      operation: "read",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: { route: "/storage/buckets", method: req.method }
    });
    const result = await dbQuery(`
      SELECT
        b.id,
        b.name,
        b.visibility,
        b.status,
        b.created_at AS "createdAt",
        COUNT(f.id)::int AS "fileCount",
        COALESCE(SUM(f.size_bytes), 0)::bigint AS "totalBytes"
      FROM backend_storage_buckets b
      LEFT JOIN backend_storage_files f ON f.bucket_id = b.id AND f.status = 'active'
      GROUP BY b.id, b.name, b.visibility, b.status, b.created_at
      ORDER BY b.created_at DESC
    `);

    return res.json({
      success: true,
      data: {
        buckets: result.rows,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load storage buckets.",
      detail: error.message,
    });
  }
});

router.get("/storage/files", apiKeyRequired, requireScope("read:storage"), async (req, res) => {
  try {
    await enforceGoodOSPolicy({
      targetType: "storage",
      targetId: "files",
      operation: "read",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: { route: "/storage/files", method: req.method }
    });
    const result = await dbQuery(`
      SELECT
        f.id,
        f.bucket_id AS "bucketId",
        b.name AS "bucketName",
        f.filename,
        f.original_filename AS "originalFilename",
        f.mime_type AS "mimeType",
        f.size_bytes AS "sizeBytes",
        f.status,
        f.created_at AS "createdAt"
      FROM backend_storage_files f
      JOIN backend_storage_buckets b ON b.id = f.bucket_id
      ORDER BY f.created_at DESC
      LIMIT 500
    `);

    return res.json({
      success: true,
      data: {
        files: result.rows,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load storage files.",
      detail: error.message,
    });
  }
});




function normalizeDbApiSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function quoteDbApiIdentifier(value) {
  const identifier = String(value || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    const error = new Error("Unsafe database identifier.");
    error.statusCode = 400;
    throw error;
  }
  return '"' + identifier.replace(/"/g, '""') + '"';
}

function intersectsList(left = [], right = []) {
  const a = normalizeList(left, []);
  const b = normalizeList(right, []);
  if (a.includes("*") || b.includes("*")) return true;
  return a.some((item) => b.includes(item));
}

function dbApiAllowedByApp(rule, apiKey) {
  return intersectsList(rule.allowedAppIds || rule.allowed_app_ids || ["*"], allowedApps(apiKey));
}

async function getDbApiRule(apiSlug, operation, apiKey) {
  const slug = normalizeDbApiSlug(apiSlug);

  if (!slug) {
    const error = new Error("Database API table slug is required.");
    error.statusCode = 400;
    throw error;
  }

  const result = await dbQuery(
    `
      SELECT
        id,
        table_name AS "tableName",
        api_slug AS "apiSlug",
        display_name AS "displayName",
        description,
        read_enabled AS "readEnabled",
        write_enabled AS "writeEnabled",
        insert_enabled AS "insertEnabled",
        update_enabled AS "updateEnabled",
        delete_enabled AS "deleteEnabled",
        exposed_columns AS "exposedColumns",
        searchable_columns AS "searchableColumns",
        allowed_api_key_scopes AS "allowedApiKeyScopes",
        allowed_app_ids AS "allowedAppIds",
        max_rows AS "maxRows",
        status,
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        metadata_json AS "metadata"
      FROM backend_table_api_rules
      WHERE api_slug = $1
        AND status = 'active'
      LIMIT 1
    `,
    [slug]
  );

  const rule = result.rows[0];

  if (!rule) {
    const error = new Error(`Published table not found: ${slug}`);
    error.statusCode = 404;
    throw error;
  }

  if (!dbApiAllowedByApp(rule, apiKey)) {
    const error = new Error("API key is not allowed to access this published table.");
    error.statusCode = 403;
    throw error;
  }

  if (operation === "read" && !rule.readEnabled) {
    const error = new Error("Read access is not enabled for this table.");
    error.statusCode = 403;
    throw error;
  }

  if (operation === "insert" && (!rule.writeEnabled || !rule.insertEnabled)) {
    const error = new Error("Insert access is not enabled for this table.");
    error.statusCode = 403;
    throw error;
  }

  if (operation === "update" && (!rule.writeEnabled || !rule.updateEnabled)) {
    const error = new Error("Update access is not enabled for this table.");
    error.statusCode = 403;
    throw error;
  }

  if (operation === "delete" && (!rule.writeEnabled || !rule.deleteEnabled)) {
    const error = new Error("Delete access is not enabled for this table.");
    error.statusCode = 403;
    throw error;
  }

  return rule;
}

async function getDbApiColumns(tableName, exposedColumns = []) {
  const result = await dbQuery(
    `
      SELECT
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault",
        is_identity AS "isIdentity",
        is_generated AS "isGenerated",
        ordinal_position AS "position"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName]
  );

  const realColumns = result.rows;
  const allowed = normalizeList(exposedColumns, []);

  if (!allowed.length) return realColumns;

  const allowedSet = new Set(allowed);
  return realColumns.filter((column) => allowedSet.has(column.columnName));
}

async function getDbApiPrimaryKey(tableName) {
  const result = await dbQuery(
    `
      SELECT kcu.column_name AS "columnName"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position ASC
      LIMIT 1
    `,
    [tableName]
  );

  return result.rows[0]?.columnName || "id";
}

function normalizeDbApiValue(value, column) {
  if (value === undefined) return null;
  if (value === "") return null;

  if (column && ["json", "jsonb"].includes(column.dataType)) {
    if (typeof value === "string") {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  return value;
}

function dbApiValueExpression(index, column) {
  if (column && column.dataType === "jsonb") return `$${index}::jsonb`;
  if (column && column.dataType === "json") return `$${index}::json`;
  return `$${index}`;
}

function dbApiSafePublicError(res, error) {
  const status = Number(error.statusCode || error.status || 500);
  return res.status(status).json({
    success: false,
    message: error.message || "Database API request failed.",
  });
}

router.get("/db/tables", apiKeyRequired, requireScope("read:db"), async (req, res) => {
  try {
    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: "*",
      operation: "read",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: { route: "/db/tables", method: req.method }
    });
    const result = await dbQuery(
      `
        SELECT
          id,
          table_name AS "tableName",
          api_slug AS "apiSlug",
          display_name AS "displayName",
          description,
          read_enabled AS "readEnabled",
          write_enabled AS "writeEnabled",
          insert_enabled AS "insertEnabled",
          update_enabled AS "updateEnabled",
          delete_enabled AS "deleteEnabled",
          exposed_columns AS "exposedColumns",
          searchable_columns AS "searchableColumns",
          max_rows AS "maxRows",
          status,
          organization_id AS "organizationId",
          project_id AS "projectId",
          environment_id AS "environmentId"
        FROM backend_table_api_rules
        WHERE status = 'active'
          AND read_enabled = true
        ORDER BY display_name ASC, api_slug ASC
      `
    );

    const tables = result.rows.filter((rule) => dbApiAllowedByApp(rule, req.goodosApiKey));

    return res.json({
      success: true,
      data: {
        tables,
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.get("/db/:tableSlug/rows", apiKeyRequired, requireScope("read:db"), async (req, res) => {
  try {
    const rule = await getDbApiRule(req.params.tableSlug, "read", req.goodosApiKey);

    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: rule.apiSlug,
      operation: "read",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        route: req.path,
        method: req.method,
        tableSlug: rule.apiSlug,
        tableName: rule.tableName,
        tableRuleId: rule.id
      }
    });

    const columns = await getDbApiColumns(rule.tableName, rule.exposedColumns);
    const columnNames = columns.map((column) => column.columnName);

    if (!columnNames.length) {
      return res.json({
        success: true,
        data: {
          table: rule,
          columns: [],
          rows: [],
          pagination: { limit: 0, offset: 0, total: 0, hasMore: false },
        },
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), Math.min(Number(rule.maxRows || 100), 500));
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const search = String(req.query.search || "").trim();

    const quotedTable = quoteDbApiIdentifier(rule.tableName);
    const selectSql = columnNames.map(quoteDbApiIdentifier).join(", ");

    let whereSql = "";
    let countParams = [];
    let rowsParams = [limit, offset];

    if (search) {
      const searchable = normalizeList(rule.searchableColumns, []).filter((column) => columnNames.includes(column));
      const searchColumns = searchable.length ? searchable : columnNames;

      whereSql = `WHERE (${searchColumns.map((column) => `COALESCE(${quoteDbApiIdentifier(column)}::text, '')`).join(" || ' ' || ")}) ILIKE $1`;
      countParams = [`%${search}%`];
      rowsParams = [`%${search}%`, limit, offset];
    }

    const primaryKey = await getDbApiPrimaryKey(rule.tableName);
    const orderColumn = columnNames.includes("created_at") ? "created_at" : (columnNames.includes(primaryKey) ? primaryKey : columnNames[0]);
    const orderDirection = orderColumn === "created_at" ? "DESC" : "ASC";

    const countResult = await dbQuery(
      `
        SELECT COUNT(*)::int AS count
        FROM ${quotedTable}
        ${whereSql}
      `,
      countParams
    );

    const rowsResult = await dbQuery(
      `
        SELECT ${selectSql}
        FROM ${quotedTable}
        ${whereSql}
        ORDER BY ${quoteDbApiIdentifier(orderColumn)} ${orderDirection}
        LIMIT $${search ? 2 : 1}
        OFFSET $${search ? 3 : 2}
      `,
      rowsParams
    );

    const total = Number(countResult.rows[0]?.count || 0);

    return res.json({
      success: true,
      data: {
        table: rule,
        columns,
        rows: rowsResult.rows,
        pagination: {
          limit,
          offset,
          total,
          nextOffset: offset + rowsResult.rows.length,
          hasMore: offset + rowsResult.rows.length < total,
        },
        search,
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.get("/db/:tableSlug/rows/:id", apiKeyRequired, requireScope("read:db"), async (req, res) => {
  try {
    const rule = await getDbApiRule(req.params.tableSlug, "read", req.goodosApiKey);

    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: rule.apiSlug,
      operation: "read",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        route: req.path,
        method: req.method,
        tableSlug: rule.apiSlug,
        tableName: rule.tableName,
        tableRuleId: rule.id
      }
    });

    const columns = await getDbApiColumns(rule.tableName, rule.exposedColumns);
    const columnNames = columns.map((column) => column.columnName);
    const primaryKey = await getDbApiPrimaryKey(rule.tableName);

    if (!columnNames.includes(primaryKey)) {
      const error = new Error("Primary key is not exposed for this table.");
      error.statusCode = 403;
      throw error;
    }

    const result = await dbQuery(
      `
        SELECT ${columnNames.map(quoteDbApiIdentifier).join(", ")}
        FROM ${quoteDbApiIdentifier(rule.tableName)}
        WHERE ${quoteDbApiIdentifier(primaryKey)}::text = $1
        LIMIT 1
      `,
      [String(req.params.id || "")]
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Row not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        table: rule,
        row,
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.post("/db/:tableSlug/rows", apiKeyRequired, requireScope("write:db"), async (req, res) => {
  try {
    const rule = await getDbApiRule(req.params.tableSlug, "insert", req.goodosApiKey);

    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: rule.apiSlug,
      operation: "insert",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        route: req.path,
        method: req.method,
        tableSlug: rule.apiSlug,
        tableName: rule.tableName,
        tableRuleId: rule.id
      }
    });

    const columns = await getDbApiColumns(rule.tableName, rule.exposedColumns);
    const columnMap = new Map(columns.map((column) => [column.columnName, column]));
    const input = req.body?.row && typeof req.body.row === "object" ? req.body.row : (req.body && typeof req.body === "object" ? req.body : {});

    if (columnMap.has("id") && !input.id) {
      input.id = `row_${crypto.randomUUID().replace(/-/g, "")}`;
    }

    const entries = Object.entries(input).filter(([key]) => {
      const column = columnMap.get(key);
      if (!column) return false;
      if (["created_at", "updated_at"].includes(key)) return false;
      if (column.isGenerated === "ALWAYS" || column.isIdentity === "YES") return false;
      return true;
    });

    if (!entries.length) {
      return res.status(400).json({
        success: false,
        message: "No valid writable columns provided.",
      });
    }

    const params = [];
    const quotedColumns = [];
    const valueExpressions = [];

    entries.forEach(([key, value], index) => {
      const column = columnMap.get(key);
      params.push(normalizeDbApiValue(value, column));
      quotedColumns.push(quoteDbApiIdentifier(key));
      valueExpressions.push(dbApiValueExpression(index + 1, column));
    });

    const result = await dbQuery(
      `
        INSERT INTO ${quoteDbApiIdentifier(rule.tableName)} (${quotedColumns.join(", ")})
        VALUES (${valueExpressions.join(", ")})
        RETURNING ${columns.map((column) => quoteDbApiIdentifier(column.columnName)).join(", ")}
      `,
      params
    );

    return res.status(201).json({
      success: true,
      data: {
        table: rule,
        row: result.rows[0],
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.patch("/db/:tableSlug/rows/:id", apiKeyRequired, requireScope("write:db"), async (req, res) => {
  try {
    const rule = await getDbApiRule(req.params.tableSlug, "update", req.goodosApiKey);

    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: rule.apiSlug,
      operation: "update",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        route: req.path,
        method: req.method,
        tableSlug: rule.apiSlug,
        tableName: rule.tableName,
        tableRuleId: rule.id,
        rowId: String(req.params.id || "")
      }
    });

    const columns = await getDbApiColumns(rule.tableName, rule.exposedColumns);
    const columnMap = new Map(columns.map((column) => [column.columnName, column]));
    const primaryKey = await getDbApiPrimaryKey(rule.tableName);
    const input = req.body?.row && typeof req.body.row === "object" ? req.body.row : (req.body && typeof req.body === "object" ? req.body : {});

    if (!columnMap.has(primaryKey)) {
      const error = new Error("Primary key is not exposed for this table.");
      error.statusCode = 403;
      throw error;
    }

    const entries = Object.entries(input).filter(([key]) => {
      const column = columnMap.get(key);
      if (!column) return false;
      if ([primaryKey, "id", "created_at", "updated_at"].includes(key)) return false;
      if (column.isGenerated === "ALWAYS" || column.isIdentity === "YES") return false;
      return true;
    });

    if (!entries.length) {
      return res.status(400).json({
        success: false,
        message: "No valid writable columns provided.",
      });
    }

    const params = [];
    const assignments = [];

    entries.forEach(([key, value], index) => {
      const column = columnMap.get(key);
      params.push(normalizeDbApiValue(value, column));
      assignments.push(`${quoteDbApiIdentifier(key)} = ${dbApiValueExpression(index + 1, column)}`);
    });

    if (columnMap.has("updated_at")) {
      assignments.push(`${quoteDbApiIdentifier("updated_at")} = NOW()`);
    }

    params.push(String(req.params.id || ""));

    const result = await dbQuery(
      `
        UPDATE ${quoteDbApiIdentifier(rule.tableName)}
        SET ${assignments.join(", ")}
        WHERE ${quoteDbApiIdentifier(primaryKey)}::text = $${params.length}
        RETURNING ${columns.map((column) => quoteDbApiIdentifier(column.columnName)).join(", ")}
      `,
      params
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        message: "Row not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        table: rule,
        row: result.rows[0],
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.delete("/db/:tableSlug/rows/:id", apiKeyRequired, requireScope("write:db"), async (req, res) => {
  try {
    const rule = await getDbApiRule(req.params.tableSlug, "delete", req.goodosApiKey);

    await enforceGoodOSPolicy({
      targetType: "db_api",
      targetId: rule.apiSlug,
      operation: "delete",
      actorType: "api_key",
      actorId: req.goodosApiKey.id,
      apiKey: req.goodosApiKey,
      context: {
        route: req.path,
        method: req.method,
        tableSlug: rule.apiSlug,
        tableName: rule.tableName,
        tableRuleId: rule.id,
        rowId: String(req.params.id || "")
      }
    });

    const columns = await getDbApiColumns(rule.tableName, rule.exposedColumns);
    const columnNames = columns.map((column) => column.columnName);
    const primaryKey = await getDbApiPrimaryKey(rule.tableName);

    if (!columnNames.includes(primaryKey)) {
      const error = new Error("Primary key is not exposed for this table.");
      error.statusCode = 403;
      throw error;
    }

    let result;

    if (columnNames.includes("status")) {
      result = await dbQuery(
        `
          UPDATE ${quoteDbApiIdentifier(rule.tableName)}
          SET status = 'deleted'${columnNames.includes("updated_at") ? ', updated_at = NOW()' : ''}
          WHERE ${quoteDbApiIdentifier(primaryKey)}::text = $1
          RETURNING ${columnNames.map(quoteDbApiIdentifier).join(", ")}
        `,
        [String(req.params.id || "")]
      );
    } else {
      result = await dbQuery(
        `
          DELETE FROM ${quoteDbApiIdentifier(rule.tableName)}
          WHERE ${quoteDbApiIdentifier(primaryKey)}::text = $1
          RETURNING ${columnNames.map(quoteDbApiIdentifier).join(", ")}
        `,
        [String(req.params.id || "")]
      );
    }

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        message: "Row not found.",
      });
    }

    return res.json({
      success: true,
      data: {
        table: rule,
        row: result.rows[0],
      },
    });
  } catch (error) {
    return dbApiSafePublicError(res, error);
  }
});

router.get("/functions/:slug", apiKeyRequired, requireScope("execute:functions"), publicCallableFunctionHandler);
router.post("/functions/:slug", apiKeyRequired, requireScope("execute:functions"), publicCallableFunctionHandler);

module.exports = router;
