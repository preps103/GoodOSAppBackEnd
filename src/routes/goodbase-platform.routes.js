const crypto = require("crypto");
const express = require("express");
const net = require("net");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");
const { dataPlaneAdminRequired } = require("./data-plane.routes");

const router = express.Router();
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const POLICY_TEMPLATES = new Set(["tenant", "tenant_admin", "public_read", "service"]);
const REALTIME_OPERATIONS = new Set(["INSERT", "UPDATE", "DELETE"]);

function id(value, label = "identifier") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) {
    const error = new Error(`Invalid ${label}.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function quoteId(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, minimum), maximum)
    : fallback;
}

async function audit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user?.id || null,
    appId: "goodbase",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: { brand: "Goodbase", ...metadata }
  });
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ available, host, port, latencyMs: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function rlsFindings() {
  const result = await database.query(`
    WITH exposed AS (
      SELECT
        source_namespace.nspname AS source_schema,
        source_relation.relname AS source_name,
        source_relation.relrowsecurity AS rls_enabled,
        source_relation.relforcerowsecurity AS rls_forced,
        api_relation.relname AS api_name,
        COALESCE((SELECT option_value = 'true'
          FROM pg_options_to_table(api_relation.reloptions)
          WHERE option_name = 'security_invoker'), false) AS security_invoker
      FROM pg_class AS api_relation
      JOIN pg_namespace AS api_namespace ON api_namespace.oid = api_relation.relnamespace
      JOIN pg_rewrite AS rewrite ON rewrite.ev_class = api_relation.oid
      JOIN pg_depend AS dependency ON dependency.objid = rewrite.oid
      JOIN pg_class AS source_relation ON source_relation.oid = dependency.refobjid
      JOIN pg_namespace AS source_namespace ON source_namespace.oid = source_relation.relnamespace
      WHERE api_namespace.nspname = 'goodos_api'
        AND api_relation.relkind = 'v'
        AND source_relation.relkind IN ('r', 'p')
    )
    SELECT DISTINCT
      source_schema, source_name, api_name, rls_enabled, rls_forced,
      security_invoker,
      CASE
        WHEN NOT rls_enabled THEN 'missing_rls'
        WHEN NOT security_invoker THEN 'unsafe_view'
        WHEN NOT rls_forced THEN 'rls_not_forced'
        ELSE 'healthy'
      END AS finding
    FROM exposed
    ORDER BY source_schema, source_name, api_name
  `);
  return result.rows;
}

router.use(authRequired, dataPlaneAdminRequired);

router.get("/security/rls/audit", async (request, response, next) => {
  try {
    const findings = await rlsFindings();
    const unsafe = findings.filter((row) => row.finding !== "healthy");
    const runId = `rlsaudit_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.query(
      `INSERT INTO backend_rls_audit_runs (
         id, exposed_relations, missing_rls, unsafe_views, findings_json, created_by
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid)`,
      [
        runId,
        findings.length,
        findings.filter((row) => row.finding === "missing_rls").length,
        findings.filter((row) => row.finding === "unsafe_view").length,
        JSON.stringify(findings),
        request.user.id
      ]
    );
    return response.json({
      success: true,
      healthy: unsafe.length === 0,
      runId,
      summary: { exposed: findings.length, unsafe: unsafe.length },
      findings
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/security/rls/policies", async (request, response, next) => {
  let client;
  try {
    const sourceSchema = id(request.body?.sourceSchema || "public", "source schema");
    const sourceTable = id(request.body?.sourceTable, "source table");
    const policyName = id(request.body?.policyName, "policy name");
    const template = String(request.body?.template || "tenant").trim().toLowerCase();
    if (!POLICY_TEMPLATES.has(template)) {
      return response.status(400).json({ success: false, message: "Unsupported RLS template." });
    }

    const columns = {
      organization: id(request.body?.organizationColumn || "organization_id", "organization column"),
      project: id(request.body?.projectColumn || "project_id", "project column"),
      environment: id(request.body?.environmentColumn || "environment_id", "environment column")
    };
    const relation = `${quoteId(sourceSchema)}.${quoteId(sourceTable)}`;
    let expression = "true";
    let command = "SELECT";
    let roles = "goodos_authenticated";
    if (template === "tenant") {
      command = "ALL";
      expression = `${quoteId(columns.organization)} = goodos_auth.organization_id() AND (${quoteId(columns.project)} IS NULL OR ${quoteId(columns.project)} = goodos_auth.project_id()) AND (${quoteId(columns.environment)} IS NULL OR ${quoteId(columns.environment)} = goodos_auth.environment_id())`;
    } else if (template === "tenant_admin") {
      command = "ALL";
      expression = `${quoteId(columns.organization)} = goodos_auth.organization_id() AND goodos_auth.is_tenant_admin()`;
    } else if (template === "public_read") {
      roles = "goodos_anon, goodos_authenticated";
    } else if (template === "service") {
      command = "ALL";
      roles = "goodapp_backend_user";
    }

    client = await database.pool.connect();
    await client.query("BEGIN");
    const relationCheck = await client.query(
      `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')`,
      [sourceSchema, sourceTable]
    );
    if (!relationCheck.rowCount) {
      const error = new Error("Source table does not exist.");
      error.statusCode = 404;
      throw error;
    }
    await client.query(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS ${quoteId(policyName)} ON ${relation}`);
    const withCheck = command === "ALL" ? ` WITH CHECK (${expression})` : "";
    await client.query(
      `CREATE POLICY ${quoteId(policyName)} ON ${relation} FOR ${command} TO ${roles} USING (${expression})${withCheck}`
    );
    if (command === "ALL") {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${relation} TO ${roles}`);
    } else {
      await client.query(`GRANT SELECT ON ${relation} TO ${roles}`);
    }
    await client.query(
      `INSERT INTO backend_rls_policy_registry (
         id, source_schema, source_table, policy_name, template,
         operations_json, organization_column, project_column,
         environment_column, status, created_by, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'active',$10::uuid,$11::jsonb)
       ON CONFLICT (source_schema, source_table, policy_name) DO UPDATE SET
         template = EXCLUDED.template, operations_json = EXCLUDED.operations_json,
         organization_column = EXCLUDED.organization_column,
         project_column = EXCLUDED.project_column,
         environment_column = EXCLUDED.environment_column,
         status = 'active', updated_at = NOW()`,
      [
        `rlspol_${crypto.randomUUID().replaceAll("-", "")}`,
        sourceSchema, sourceTable, policyName, template,
        JSON.stringify(command === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : ["SELECT"]),
        columns.organization, columns.project, columns.environment,
        request.user.id, JSON.stringify({ managedBy: "Goodbase" })
      ]
    );
    await client.query("COMMIT");
    await audit(request, "goodbase.rls.policy.upsert", "rls_policy", policyName, {
      sourceSchema, sourceTable, template
    });
    return response.status(201).json({ success: true, policy: { sourceSchema, sourceTable, policyName, template } });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => null);
    return next(error);
  } finally {
    client?.release();
  }
});

router.get("/connections", async (request, response, next) => {
  try {
    const [transaction, session, budgets] = await Promise.all([
      tcpProbe("127.0.0.1", bounded(process.env.GOODBASE_TRANSACTION_POOL_PORT, 6543, 1, 65535)),
      tcpProbe("127.0.0.1", bounded(process.env.GOODBASE_SESSION_POOL_PORT, 5433, 1, 65535)),
      database.query(`SELECT * FROM backend_connection_budgets ORDER BY project_id, environment_id NULLS FIRST`)
    ]);
    return response.json({
      success: true,
      healthy: transaction.available && session.available,
      endpoints: {
        transaction: { ...transaction, publicPort: 6543, poolMode: "transaction" },
        session: { ...session, publicPort: 5433, poolMode: "session" }
      },
      budgets: budgets.rows
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/connections/budgets/:id", async (request, response, next) => {
  try {
    const budgetId = id(request.params.id, "budget id");
    const result = await database.query(
      `UPDATE backend_connection_budgets SET
         transaction_pool_size = $2, session_pool_size = $3,
         max_client_connections = $4, reserve_pool_size = $5,
         query_timeout_seconds = $6, idle_transaction_timeout_seconds = $7,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        budgetId,
        bounded(request.body?.transactionPoolSize, 20, 1, 500),
        bounded(request.body?.sessionPoolSize, 10, 1, 500),
        bounded(request.body?.maxClientConnections, 200, 10, 10000),
        bounded(request.body?.reservePoolSize, 5, 0, 100),
        bounded(request.body?.queryTimeoutSeconds, 60, 1, 3600),
        bounded(request.body?.idleTransactionTimeoutSeconds, 60, 1, 3600)
      ]
    );
    if (!result.rowCount) return response.status(404).json({ success: false, message: "Connection budget not found." });
    await audit(request, "goodbase.connections.budget.update", "connection_budget", budgetId);
    return response.json({ success: true, budget: result.rows[0], requiresPoolReload: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/realtime", async (request, response, next) => {
  try {
    const [service, settings, publications, slots] = await Promise.all([
      tcpProbe("127.0.0.1", bounded(process.env.GOODBASE_REALTIME_PORT, 8400, 1, 65535)),
      database.query(`SELECT current_setting('wal_level') AS wal_level,
        current_setting('max_replication_slots')::int AS max_replication_slots,
        current_setting('max_wal_senders')::int AS max_wal_senders,
        current_setting('max_slot_wal_keep_size') AS max_slot_wal_keep_size`),
      database.query(`SELECT * FROM backend_realtime_publications ORDER BY project_id, environment_id, source_table`),
      database.query(`SELECT slot_name, plugin, slot_type, active,
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS retained_wal_bytes
        FROM pg_replication_slots ORDER BY slot_name`)
    ]);
    const postgres = settings.rows[0];
    return response.json({
      success: true,
      healthy: service.available && postgres.wal_level === "logical",
      endpoint: "wss://base.goodos.app/realtime/v1/websocket",
      service,
      postgres,
      publications: publications.rows,
      slots: slots.rows,
      delivery: "Realtime clients must reconnect, resubscribe, and tolerate duplicate or missed events. Durable workflows must use queues."
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/realtime/publications", async (request, response, next) => {
  let client;
  try {
    const sourceSchema = id(request.body?.sourceSchema || "public", "source schema");
    const sourceTable = id(request.body?.sourceTable, "source table");
    const publicationName = id(request.body?.publicationName, "publication name");
    const projectId = id(request.body?.projectId, "project id");
    const environmentId = id(request.body?.environmentId, "environment id");
    const operations = [...new Set((request.body?.operations || ["INSERT", "UPDATE", "DELETE"])
      .map((value) => String(value).trim().toUpperCase()))];
    if (!operations.length || operations.some((value) => !REALTIME_OPERATIONS.has(value))) {
      return response.status(400).json({ success: false, message: "Realtime operations may include INSERT, UPDATE, and DELETE." });
    }
    const relation = `${quoteId(sourceSchema)}.${quoteId(sourceTable)}`;

    client = await database.pool.connect();
    await client.query("BEGIN");
    const relationCheck = await client.query(
      `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')`,
      [sourceSchema, sourceTable]
    );
    if (!relationCheck.rowCount) {
      const error = new Error("Realtime source table does not exist.");
      error.statusCode = 404;
      throw error;
    }
    if (!relationCheck.rows[0].relrowsecurity) {
      const error = new Error("Enable RLS before publishing a table to Realtime.");
      error.statusCode = 409;
      throw error;
    }
    const existing = await client.query("SELECT 1 FROM pg_publication WHERE pubname = $1", [publicationName]);
    if (!existing.rowCount) {
      await client.query(`CREATE PUBLICATION ${quoteId(publicationName)} WITH (publish = '${operations.map((value) => value.toLowerCase()).join(", ")}')`);
    }
    const member = await client.query(
      `SELECT 1 FROM pg_publication_tables WHERE pubname = $1 AND schemaname = $2 AND tablename = $3`,
      [publicationName, sourceSchema, sourceTable]
    );
    if (!member.rowCount) await client.query(`ALTER PUBLICATION ${quoteId(publicationName)} ADD TABLE ${relation}`);
    await client.query(
      `INSERT INTO backend_realtime_publications (
         id, project_id, environment_id, publication_name, source_schema,
         source_table, operations_json, status, max_payload_bytes,
         events_per_second, created_by, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8,$9,$10::uuid,$11::jsonb)
       ON CONFLICT (project_id, environment_id, source_schema, source_table) DO UPDATE SET
         publication_name = EXCLUDED.publication_name,
         operations_json = EXCLUDED.operations_json, status = 'active',
         max_payload_bytes = EXCLUDED.max_payload_bytes,
         events_per_second = EXCLUDED.events_per_second, updated_at = NOW()
       RETURNING *`,
      [
        `rtpub_${crypto.randomUUID().replaceAll("-", "")}`,
        projectId, environmentId, publicationName, sourceSchema, sourceTable,
        JSON.stringify(operations), bounded(request.body?.maxPayloadBytes, 1048576, 1024, 10485760),
        bounded(request.body?.eventsPerSecond, 100, 1, 10000),
        request.user.id, JSON.stringify({ managedBy: "Goodbase" })
      ]
    );
    await client.query("COMMIT");
    await audit(request, "goodbase.realtime.publication.upsert", "realtime_publication", publicationName, {
      sourceSchema, sourceTable, operations
    });
    return response.status(201).json({ success: true, publicationName, sourceSchema, sourceTable, operations });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => null);
    return next(error);
  } finally {
    client?.release();
  }
});

module.exports = { router, __test: { id, bounded, tcpProbe, rlsFindings } };
