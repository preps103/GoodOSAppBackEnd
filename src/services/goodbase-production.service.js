"use strict";

const crypto = require("crypto");
const net = require("net");
const { execFileSync } = require("child_process");

const database = require("../config/database");

const CANONICAL_ORIGIN = "https://base.goodos.app";
const DEFAULT_SCOPE = {
  organizationId: "org_goodos",
  projectId: "proj_goodos_platform",
  environmentId: "env_goodos_production"
};

const HTTP_CHECKS = Object.freeze([
  { key: "live", category: "runtime", path: "/api/health/live", accepted: [200], critical: true },
  { key: "ready", category: "runtime", path: "/api/health/ready", accepted: [200], critical: true },
  { key: "data-platform-health", category: "data", path: "/api/data-platform/health", accepted: [200, 401, 403], critical: true },
  { key: "data-platform-readiness", category: "data", path: "/api/data-platform/readiness", accepted: [200, 401, 403], critical: true },
  { key: "rest", category: "api", path: "/rest/v1", accepted: [200, 401, 403], critical: true },
  { key: "graphql", category: "api", path: "/graphql/v1", accepted: [200, 400, 401, 403, 405], critical: true },
  { key: "realtime", category: "realtime", path: "/realtime/v1/websocket", accepted: [101, 400, 401, 403, 426], critical: true },
  { key: "storage", category: "storage", path: "/storage/v2/health", accepted: [200], critical: true },
  { key: "enterprise", category: "enterprise", path: "/api/goodbase/v1/enterprise/overview", accepted: [401, 403], critical: true },
  { key: "production-auth-boundary", category: "security", path: "/api/goodbase/v1/production/overview", accepted: [401, 403], critical: true }
]);

function resolveCommit() {
  const configured = String(
    process.env.GOODBASE_RELEASE_COMMIT || ""
  ).trim();
  if (/^[0-9a-f]{7,64}$/i.test(configured)) return configured.toLowerCase();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
  } catch {
    return "0000000";
  }
}

async function httpCheck(check, origin = CANONICAL_ORIGIN) {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${origin}${check.path}`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "Goodbase-Production-Verifier/1.0"
      }
    });
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      ...check,
      target: `${origin}${check.path}`,
      status: check.accepted.includes(response.status) ? "passed" : "failed",
      statusCode: response.status,
      latencyMs,
      version: response.headers.get("x-goodbase-version") || null,
      detail: { contentType: response.headers.get("content-type") || null }
    };
  } catch (error) {
    return {
      ...check,
      target: `${origin}${check.path}`,
      status: "failed",
      statusCode: null,
      latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
      version: null,
      detail: { error: error.name === "AbortError" ? "timeout" : String(error.message).slice(0, 300) }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function tcpCheck(key, port, critical = true) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (status, detail = {}) => {
      socket.destroy();
      resolve({
        key,
        category: "pooling",
        target: `tcp://127.0.0.1:${port}`,
        critical,
        status,
        statusCode: null,
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        version: null,
        detail
      });
    };
    socket.setTimeout(3000);
    socket.once("connect", () => finish("passed"));
    socket.once("timeout", () => finish("failed", { error: "timeout" }));
    socket.once("error", (error) => finish("failed", { error: String(error.code || error.message).slice(0, 100) }));
  });
}

async function runProductionVerification({
  scope = DEFAULT_SCOPE,
  triggerType = "manual",
  requestedBy = null,
  origin = CANONICAL_ORIGIN
} = {}) {
  const run = await database.query(
    `INSERT INTO goodbase_verification_runs
      (organization_id,project_id,environment_id,git_commit,trigger_type,status,started_at,requested_by)
     VALUES($1,$2,$3,$4,$5,'running',NOW(),$6) RETURNING *`,
    [scope.organizationId, scope.projectId, scope.environmentId, resolveCommit(), triggerType, requestedBy]
  );

  const checks = await Promise.all([
    ...HTTP_CHECKS.map((check) => httpCheck(check, origin)),
    tcpCheck("transaction-pool", 6543),
    tcpCheck("session-pool", 5433)
  ]);

  for (const check of checks) {
    await database.query(
      `INSERT INTO goodbase_verification_checks
        (run_id,check_key,category,target,critical,status,status_code,latency_ms,version,detail_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [run.rows[0].id, check.key, check.category, check.target, check.critical, check.status,
        check.statusCode, check.latencyMs, check.version, JSON.stringify(check.detail || {})]
    );
  }

  const criticalFailures = checks.filter((check) => check.critical && check.status !== "passed").length;
  const status = criticalFailures === 0 ? "passed" : "failed";
  const completed = await database.query(
    `UPDATE goodbase_verification_runs
     SET status=$2,critical_failures=$3,completed_at=NOW(),report_json=$4::jsonb
     WHERE id=$1 RETURNING *`,
    [run.rows[0].id, status, criticalFailures, JSON.stringify({ origin, checks: checks.length })]
  );
  return { run: completed.rows[0], checks };
}

function secretValue(reference) {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(String(reference || ""))) return null;
  return process.env[reference] || null;
}

function controllerUrl(registration, path) {
  const url = new URL(path, String(registration.base_url).replace(/\/+$/, "") + "/");
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Controller endpoints must use HTTPS.");
  }
  return url;
}

async function callController(registration, path, { method = "POST", body = null } = {}) {
  const secret = secretValue(registration.secret_ref);
  if (!secret) {
    const error = new Error(`Controller secret ${registration.secret_ref} is not configured.`);
    error.code = "GOODBASE_CONTROLLER_SECRET_MISSING";
    throw error;
  }
  const timestamp = String(Date.now());
  const payload = body ? JSON.stringify(body) : "";
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(controllerUrl(registration, path), {
      method,
      signal: abort.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Goodbase-Timestamp": timestamp,
        "X-Goodbase-Signature": `sha256=${signature}`,
        "Idempotency-Key": body?.idempotencyKey || crypto.randomUUID()
      },
      body: body ? payload : undefined
    });
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(responsePayload.message || `Controller returned ${response.status}.`);
    return { statusCode: response.status, payload: responsePayload };
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchControllerOperations(limit = 10) {
  const operations = await database.query(
    `WITH candidates AS (
       SELECT operation.id
       FROM goodbase_controller_operations operation
       JOIN goodbase_controller_registrations controller ON controller.id=operation.controller_id
       WHERE operation.status IN('queued','failed') AND operation.next_attempt_at<=NOW()
         AND operation.attempts<5 AND controller.status='ready'
       ORDER BY operation.created_at FOR UPDATE OF operation SKIP LOCKED LIMIT $1
     ), claimed AS (
       UPDATE goodbase_controller_operations operation
       SET status='running',attempts=attempts+1,started_at=COALESCE(started_at,NOW())
       FROM candidates WHERE operation.id=candidates.id RETURNING operation.*
     )
     SELECT claimed.*,controller.base_url,controller.secret_ref,controller.controller_type
     FROM claimed JOIN goodbase_controller_registrations controller ON controller.id=claimed.controller_id`,
    [Math.min(Math.max(Number(limit) || 10, 1), 50)]
  );
  let succeeded = 0;
  for (const operation of operations.rows) {
    try {
      const result = await callController(operation, "/v1/operations", {
        body: {
          id: operation.id,
          idempotencyKey: operation.idempotency_key,
          type: operation.operation_type,
          scope: {
            organizationId: operation.organization_id,
            projectId: operation.project_id,
            environmentId: operation.environment_id
          },
          parameters: operation.request_json
        }
      });
      await database.query(
        `UPDATE goodbase_controller_operations SET status='succeeded',result_json=$2::jsonb,
         controller_request_id=$3,completed_at=NOW(),error_message=NULL WHERE id=$1`,
        [operation.id, JSON.stringify(result.payload), result.payload.requestId || null]
      );
      succeeded += 1;
    } catch (error) {
      await database.query(
        `UPDATE goodbase_controller_operations SET status='failed',error_message=$2,
         next_attempt_at=NOW()+(LEAST(3600,POWER(2,attempts)*10)::text||' seconds')::interval WHERE id=$1`,
        [operation.id, String(error.message).slice(0, 1000)]
      );
    }
  }
  return { selected: operations.rowCount, succeeded };
}

module.exports = {
  CANONICAL_ORIGIN,
  HTTP_CHECKS,
  callController,
  dispatchControllerOperations,
  resolveCommit,
  runProductionVerification
};
