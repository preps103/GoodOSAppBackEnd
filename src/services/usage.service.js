const crypto = require("crypto");
const database = require("../config/database");

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function monthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return { start, end };
}

function safeRoute(req) {
  return String(req.originalUrl || req.url || "").split("?")[0].slice(0, 500);
}

function ipAddress(req) {
  return String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "").slice(0, 200);
}

function userAgent(req) {
  return String(req.headers?.["user-agent"] || "").slice(0, 1000);
}

async function getBillingSnapshot() {
  const plans = await dbQuery(`
    SELECT
      id,
      name,
      display_name AS "displayName",
      description,
      currency,
      monthly_price_cents AS "monthlyPriceCents",
      annual_price_cents AS "annualPriceCents",
      included_json AS "included",
      limits_json AS "limits",
      features_json AS "features",
      status,
      sort_order AS "sortOrder"
    FROM backend_billing_plans
    WHERE status = 'active'
    ORDER BY sort_order ASC, monthly_price_cents ASC
  `);

  return {
    plans: plans.rows,
  };
}

async function getUsageSnapshot(apiKey = {}) {
  const usageResult = await dbQuery(`
    SELECT
      (SELECT COUNT(*)::bigint FROM backend_api_key_usage_logs WHERE created_at >= date_trunc('month', NOW())) AS "api.calls.monthly",
      (SELECT COUNT(*)::bigint FROM backend_api_keys WHERE status = 'active') AS "api.keys.active",
      (SELECT COUNT(*)::bigint FROM backend_storage_buckets WHERE status = 'active') AS "storage.buckets",
      (SELECT COUNT(*)::bigint FROM backend_storage_files) AS "storage.files",
      COALESCE((SELECT SUM(size_bytes)::bigint FROM backend_storage_files), 0) AS "storage.bytes",
      (SELECT COUNT(*)::bigint FROM backend_webhooks WHERE status = 'active') AS "webhooks.active",
      (SELECT COUNT(*)::bigint FROM backend_webhook_deliveries WHERE created_at >= date_trunc('month', NOW())) AS "webhooks.deliveries.monthly",
      (SELECT COUNT(*)::bigint FROM backend_realtime_messages WHERE created_at >= date_trunc('month', NOW())) AS "realtime.events.monthly",
      (SELECT COUNT(*)::bigint FROM backend_edge_function_runs WHERE created_at >= date_trunc('month', NOW())) AS "functions.runs.monthly",
      (SELECT COUNT(*)::bigint FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS "sessions.active",
      (SELECT COUNT(*)::bigint FROM users WHERE status = 'active') AS "users.active",
      (SELECT COUNT(*)::bigint FROM apps WHERE status = 'active') AS "apps.active"
  `);

  const quotaResult = await dbQuery(`
    SELECT
      id,
      metric_key AS "metricKey",
      label,
      category,
      quota_limit AS "quotaLimit",
      quota_unit AS "quotaUnit",
      warning_percent AS "warningPercent",
      is_enforced AS "isEnforced",
      description,
      status
    FROM backend_usage_quotas
    WHERE status = 'active'
    ORDER BY category ASC, label ASC
  `);

  const rawUsage = usageResult.rows[0] || {};
  const usage = quotaResult.rows.map((quota) => {
    const current = Number(rawUsage[quota.metricKey] || 0);
    const limit = Number(quota.quotaLimit || 0);
    const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;

    let state = "ok";
    if (limit > 0 && current >= limit) state = "over_limit";
    else if (limit > 0 && percent >= Number(quota.warningPercent || 80)) state = "warning";

    return {
      ...quota,
      current,
      percent,
      state,
    };
  });

  const keyUsage = apiKey?.id
    ? await dbQuery(
        `
          SELECT
            COUNT(*)::bigint AS calls,
            MIN(created_at) AS "firstSeenAt",
            MAX(created_at) AS "lastSeenAt"
          FROM backend_api_key_usage_logs
          WHERE api_key_id = $1
            AND created_at >= date_trunc('month', NOW())
        `,
        [apiKey.id]
      )
    : { rows: [{ calls: 0, firstSeenAt: null, lastSeenAt: null }] };

  return {
    usage,
    rawUsage,
    keyUsage: keyUsage.rows[0] || { calls: 0 },
    counts: {
      metrics: usage.length,
      ok: usage.filter((item) => item.state === "ok").length,
      warning: usage.filter((item) => item.state === "warning").length,
      overLimit: usage.filter((item) => item.state === "over_limit").length,
      enforced: usage.filter((item) => item.isEnforced).length,
    },
  };
}

async function enforceApiQuota(req, apiKey = {}) {
  const quotaResult = await dbQuery(
    `
      SELECT metric_key, quota_limit, is_enforced
      FROM backend_usage_quotas
      WHERE metric_key = 'api.calls.monthly'
        AND status = 'active'
      LIMIT 1
    `
  );

  const quota = quotaResult.rows[0];

  if (!quota || !quota.is_enforced || Number(quota.quota_limit || 0) <= 0) {
    return { allowed: true };
  }

  const countResult = await dbQuery(
    `
      SELECT COUNT(*)::bigint AS count
      FROM backend_api_key_usage_logs
      WHERE api_key_id = $1
        AND created_at >= date_trunc('month', NOW())
    `,
    [apiKey.id]
  );

  const current = Number(countResult.rows[0]?.count || 0);
  const limit = Number(quota.quota_limit || 0);

  if (current >= limit) {
    const error = new Error("Monthly API usage quota exceeded.");
    error.statusCode = 429;
    error.code = "usage_quota_exceeded";
    error.metricKey = "api.calls.monthly";
    error.current = current;
    error.limit = limit;
    throw error;
  }

  return { allowed: true, current, limit };
}

async function recordApiUsage(req, apiKey = {}, options = {}) {
  try {
    const metricKey = options.metricKey || "api.calls.monthly";
    const category = options.category || "api";
    const route = safeRoute(req);
    const method = String(req.method || "GET").toUpperCase();
    const quantity = Number(options.quantity || 1);
    const statusCode = Number(options.statusCode || 0) || null;
    const organizationId = apiKey.organizationId || "org_goodos";
    const projectId = apiKey.projectId || "proj_goodos_platform";
    const environmentId = apiKey.environmentId || "env_goodos_production";
    const usageEventId = randomId("usageevt");
    const meterEventId = randomId("meter");
    const apiLogId = randomId("apilog");
    const { start, end } = monthBounds();
    const counterId = `quota_${metricKey.replace(/[^a-zA-Z0-9]/g, "_")}_${organizationId}_${start.toISOString().slice(0, 10).replace(/-/g, "")}`;

    await dbQuery(
      `
        INSERT INTO backend_api_key_usage_logs (
          id,
          api_key_id,
          api_key_prefix,
          metric_key,
          route,
          method,
          status_code,
          scope,
          quantity,
          ip_address,
          user_agent,
          organization_id,
          project_id,
          environment_id,
          metadata_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      `,
      [
        apiLogId,
        apiKey.id || null,
        apiKey.keyPrefix || apiKey.key_prefix || null,
        metricKey,
        route,
        method,
        statusCode,
        route,
        quantity,
        ipAddress(req),
        userAgent(req),
        organizationId,
        projectId,
        environmentId,
        JSON.stringify({ source: "apiKeyRequired", phase: "22A" }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_usage_events (
          id,
          metric_key,
          category,
          source,
          quantity,
          unit,
          api_key_id,
          organization_id,
          project_id,
          environment_id,
          route,
          method,
          status_code,
          request_id,
          ip_address,
          user_agent,
          metadata_json
        )
        VALUES ($1,$2,$3,'public-api',$4,'count',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      `,
      [
        usageEventId,
        metricKey,
        category,
        quantity,
        apiKey.id || null,
        organizationId,
        projectId,
        environmentId,
        route,
        method,
        statusCode,
        randomId("req"),
        ipAddress(req),
        userAgent(req),
        JSON.stringify({ apiLogId }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_meter_events (
          id,
          metric_key,
          meter_name,
          quantity,
          unit,
          billable,
          api_key_id,
          organization_id,
          project_id,
          environment_id,
          usage_event_id,
          metadata_json
        )
        VALUES ($1,$2,$3,$4,'count',true,$5,$6,$7,$8,$9,$10::jsonb)
      `,
      [
        meterEventId,
        metricKey,
        "public_api_calls",
        quantity,
        apiKey.id || null,
        organizationId,
        projectId,
        environmentId,
        usageEventId,
        JSON.stringify({ route, method }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_usage_daily (
          id,
          usage_date,
          metric_key,
          category,
          quantity,
          unit,
          api_key_id,
          organization_id,
          project_id,
          environment_id,
          metadata_json
        )
        VALUES ($1,CURRENT_DATE,$2,$3,$4,'count',$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT (usage_date, metric_key, COALESCE(api_key_id, ''), COALESCE(organization_id, ''), COALESCE(project_id, ''), COALESCE(environment_id, ''))
        DO UPDATE
        SET quantity = backend_usage_daily.quantity + EXCLUDED.quantity,
            updated_at = NOW()
      `,
      [
        randomId("usageday"),
        metricKey,
        category,
        quantity,
        apiKey.id || null,
        organizationId,
        projectId,
        environmentId,
        JSON.stringify({ source: "public-api" }),
      ]
    );

    const quotaResult = await dbQuery(
      "SELECT quota_limit FROM backend_usage_quotas WHERE metric_key = $1 AND status = 'active' LIMIT 1",
      [metricKey]
    );

    const quotaLimit = Number(quotaResult.rows[0]?.quota_limit || 0);

    await dbQuery(
      `
        INSERT INTO backend_quota_counters (
          id,
          metric_key,
          scope_type,
          scope_id,
          period,
          period_start,
          period_end,
          quantity,
          quota_limit,
          status,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2,'organization',$3,'monthly',$4,$5,$6,$7,'ok',$8::jsonb,$3,$9,$10)
        ON CONFLICT (metric_key, scope_type, scope_id, period_start, period_end)
        DO UPDATE
        SET quantity = backend_quota_counters.quantity + EXCLUDED.quantity,
            quota_limit = EXCLUDED.quota_limit,
            status = CASE
              WHEN EXCLUDED.quota_limit > 0 AND backend_quota_counters.quantity + EXCLUDED.quantity >= EXCLUDED.quota_limit THEN 'over_limit'
              WHEN EXCLUDED.quota_limit > 0 AND backend_quota_counters.quantity + EXCLUDED.quantity >= (EXCLUDED.quota_limit * 0.8) THEN 'warning'
              ELSE 'ok'
            END,
            updated_at = NOW()
      `,
      [
        counterId,
        metricKey,
        organizationId,
        start.toISOString(),
        end.toISOString(),
        quantity,
        quotaLimit,
        JSON.stringify({ source: "public-api" }),
        projectId,
        environmentId,
      ]
    );

    return { success: true, usageEventId, apiLogId, meterEventId };
  } catch (error) {
    console.warn("[usage] recordApiUsage failed:", error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  getBillingSnapshot,
  getUsageSnapshot,
  enforceApiQuota,
  recordApiUsage,
};
