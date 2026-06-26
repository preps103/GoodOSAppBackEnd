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
          revoked_at AS "revokedAt"
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


router.get("/functions/:slug", apiKeyRequired, requireScope("execute:functions"), publicCallableFunctionHandler);
router.post("/functions/:slug", apiKeyRequired, requireScope("execute:functions"), publicCallableFunctionHandler);

module.exports = router;
