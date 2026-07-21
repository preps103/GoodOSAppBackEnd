const crypto = require("crypto");
const express = require("express");
const http = require("http");
const jwt = require("jsonwebtoken");
const database = require("../config/database");
const env = require("../config/env");
const authRequired = require("../middleware/authRequired");
const { publicUser } = require("../services/auth.service");
const { logAudit } = require("../services/audit.service");
const {
  mintDataPlaneToken,
  mintServiceDataPlaneToken,
  DATA_TOKEN_TTL,
  SERVICE_DATA_TOKEN_TTL
} = require("../services/data-plane-token.service");

const controlRouter = express.Router();
const restRouter = express.Router();

const POSTGREST_HOST = process.env.GOODBASE_POSTGREST_HOST ||
  process.env.GOODOS_POSTGREST_HOST ||
  "127.0.0.1";
const POSTGREST_PORT = Number(
  process.env.GOODBASE_POSTGREST_PORT ||
  process.env.GOODOS_POSTGREST_PORT ||
  8300
);
const PUBLIC_BASE_URL = String(
  process.env.GOODBASE_PUBLIC_URL ||
  "https://base.goodos.app"
).replace(/\/+$/, "");
const API_SCHEMA = process.env.GOODBASE_DATA_API_SCHEMA || "goodos_api";
const REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.GOODBASE_REST_TIMEOUT_MS,
  30000,
  1000,
  120000
);
const MAX_QUERY_BYTES = boundedInteger(
  process.env.GOODBASE_REST_MAX_QUERY_BYTES,
  8192,
  1024,
  65536
);
const MAX_BODY_BYTES = boundedInteger(
  process.env.GOODBASE_REST_MAX_BODY_BYTES,
  1048576,
  1024,
  10485760
);
const MAX_RESPONSE_BYTES = boundedInteger(
  process.env.GOODBASE_REST_MAX_RESPONSE_BYTES,
  10485760,
  65536,
  52428800
);
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS"
]);
const ALLOWED_OPERATIONS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE"
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-range",
  "range-unit",
  "preference-applied",
  "location",
  "link",
  "etag",
  "last-modified",
  "cache-control",
  "vary"
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function identifier(value, label = "identifier") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(normalized)) {
    const error = new Error(`Invalid ${label}.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeColumns(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    const error = new Error("Provide between 1 and 100 explicit column names.");
    error.statusCode = 400;
    throw error;
  }

  return [...new Set(value.map((item) => identifier(item, "column name")))];
}

function normalizeOperations(value) {
  const requested = Array.isArray(value) && value.length
    ? value
    : ["SELECT"];
  const operations = [...new Set(
    requested.map((item) => String(item || "").trim().toUpperCase())
  )];

  if (!operations.length || operations.some((item) => !ALLOWED_OPERATIONS.has(item))) {
    const error = new Error("Operations may only include SELECT, INSERT, UPDATE, and DELETE.");
    error.statusCode = 400;
    throw error;
  }

  if (!operations.includes("SELECT")) operations.unshift("SELECT");
  return operations;
}

function noStore(response) {
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
}

function postgrestRequest({
  method = "GET",
  path = "/",
  headers = {},
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES
}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: POSTGREST_HOST,
        port: POSTGREST_PORT,
        method,
        path,
        headers,
        timeout: timeoutMs
      },
      (upstreamResponse) => {
        const chunks = [];
        let responseBytes = 0;
        let settled = false;

        const fail = (error) => {
          if (settled) return;
          settled = true;
          upstreamResponse.destroy();
          reject(error);
        };

        upstreamResponse.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > maxResponseBytes) {
            const error = new Error("Goodbase Data API response exceeded the configured limit.");
            error.statusCode = 502;
            fail(error);
            return;
          }
          chunks.push(chunk);
        });
        upstreamResponse.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: upstreamResponse.statusCode || 502,
            headers: upstreamResponse.headers,
            body: Buffer.concat(chunks),
            responseBytes
          });
        });
        upstreamResponse.on("error", fail);
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Goodbase Data API timed out."));
    });
    request.on("error", reject);
    if (body?.length) request.write(body);
    request.end();
  });
}

async function databaseReadiness() {
  const result = await database.query(`
    SELECT
      to_regnamespace($1) IS NOT NULL AS api_schema,
      EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'goodos_anon'
      ) AS anonymous_role,
      EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'goodos_authenticated'
      ) AS authenticated_role,
      to_regclass('public.backend_data_plane_components') IS NOT NULL AS component_registry,
      to_regclass('public.backend_data_plane_publications') IS NOT NULL AS publication_registry,
      to_regclass('public.backend_data_plane_request_logs') IS NOT NULL AS request_ledger,
      (
        SELECT COUNT(*)::int
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ) AS exposed_objects
  `, [API_SCHEMA]);

  const components = result.rows[0] || {};
  const ready = [
    components.api_schema,
    components.anonymous_role,
    components.authenticated_role,
    components.component_registry,
    components.publication_registry,
    components.request_ledger
  ].every(Boolean);

  return {
    ready,
    schema: API_SCHEMA,
    exposedObjects: Number(components.exposed_objects || 0),
    components: {
      apiSchema: Boolean(components.api_schema),
      anonymousRole: Boolean(components.anonymous_role),
      authenticatedRole: Boolean(components.authenticated_role),
      componentRegistry: Boolean(components.component_registry),
      publicationRegistry: Boolean(components.publication_registry),
      requestLedger: Boolean(components.request_ledger)
    }
  };
}

async function componentHealth() {
  const startedAt = Date.now();

  try {
    const upstream = await postgrestRequest({
      path: "/",
      headers: {
        accept: "application/openapi+json"
      },
      timeoutMs: 3000,
      maxResponseBytes: 2097152
    });
    const healthy = upstream.statusCode >= 200 && upstream.statusCode < 500;
    const latencyMs = Date.now() - startedAt;

    await database.query(
      `
        UPDATE backend_data_plane_components
        SET
          status = CASE WHEN $1 THEN 'active' ELSE 'degraded' END,
          health_status = CASE WHEN $1 THEN 'healthy' ELSE 'unhealthy' END,
          last_health_check_at = NOW(),
          metadata_json = metadata_json || jsonb_build_object(
            'latencyMs', $2::int,
            'publicBaseUrl', $3::text,
            'brand', 'Goodbase'
          ),
          updated_at = NOW()
        WHERE component = 'postgrest'
      `,
      [healthy, latencyMs, PUBLIC_BASE_URL]
    ).catch(() => null);

    return {
      healthy,
      statusCode: upstream.statusCode,
      latencyMs
    };
  } catch {
    const latencyMs = Date.now() - startedAt;

    await database.query(
      `
        UPDATE backend_data_plane_components
        SET
          status = 'degraded',
          health_status = 'unhealthy',
          last_health_check_at = NOW(),
          metadata_json = metadata_json || jsonb_build_object(
            'latencyMs', $1::int,
            'publicBaseUrl', $2::text,
            'brand', 'Goodbase'
          ),
          updated_at = NOW()
        WHERE component = 'postgrest'
      `,
      [latencyMs, PUBLIC_BASE_URL]
    ).catch(() => null);

    return {
      healthy: false,
      statusCode: 0,
      latencyMs,
      message: "Automatic REST data plane is unavailable."
    };
  }
}

async function readinessSnapshot() {
  const [postgrest, databaseStatus] = await Promise.all([
    componentHealth(),
    databaseReadiness().catch((error) => ({
      ready: false,
      schema: API_SCHEMA,
      exposedObjects: 0,
      components: {},
      message: error.message
    }))
  ]);

  return {
    ready: postgrest.healthy && databaseStatus.ready,
    postgrest,
    database: databaseStatus
  };
}

async function dataPlaneAdminRequired(request, response, next) {
  try {
    const result = await database.query(
      `
        SELECT platform_role
        FROM users
        WHERE id = $1::uuid
          AND status = 'active'
        LIMIT 1
      `,
      [request.user.id]
    );
    const role = String(result.rows[0]?.platform_role || "").toLowerCase();

    if (!["owner", "admin"].includes(role)) {
      return response.status(403).json({
        success: false,
        code: "GOODBASE_DATA_ADMIN_REQUIRED",
        message: "Goodbase owner or administrator access is required."
      });
    }

    request.goodbaseDataAdminRole = role;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function managementAudit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user?.id || null,
    appId: "goodbase",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: {
      brand: "Goodbase",
      apiSchema: API_SCHEMA,
      ...metadata
    }
  });
}

async function resolveTenantContext(request) {
  const requestedOrganization = String(
    request.get("x-goodbase-organization-id") ||
    request.body?.organizationId ||
    request.auth?.decoded?.organizationId ||
    ""
  ).trim();
  const requestedProject = String(
    request.get("x-goodbase-project-id") ||
    request.body?.projectId ||
    request.auth?.decoded?.projectId ||
    ""
  ).trim();
  const requestedEnvironment = String(
    request.get("x-goodbase-environment-id") ||
    request.body?.environmentId ||
    request.auth?.decoded?.environmentId ||
    ""
  ).trim();

  const result = await database.query(
    `
      SELECT
        organization.id AS organization_id,
        project.id AS project_id,
        environment.id AS environment_id
      FROM backend_organization_memberships AS organization_membership
      JOIN backend_organizations AS organization
        ON organization.id = organization_membership.organization_id
       AND organization.status = 'active'
      JOIN backend_project_memberships AS project_membership
        ON project_membership.user_id = organization_membership.user_id
       AND project_membership.status = 'active'
      JOIN backend_projects AS project
        ON project.id = project_membership.project_id
       AND project.organization_id = organization.id
       AND project.status = 'active'
      JOIN backend_project_environments AS environment
        ON environment.project_id = project.id
       AND environment.status = 'active'
      WHERE organization_membership.user_id = $1::uuid
        AND organization_membership.status = 'active'
        AND ($2::text = '' OR organization.id = $2)
        AND ($3::text = '' OR project.id = $3)
        AND ($4::text = '' OR environment.id = $4)
      ORDER BY
        CASE environment.type WHEN 'production' THEN 1 WHEN 'staging' THEN 2 ELSE 3 END,
        organization_membership.created_at ASC,
        project_membership.created_at ASC
      LIMIT 1
    `,
    [request.user.id, requestedOrganization, requestedProject, requestedEnvironment]
  );

  if (!result.rowCount) {
    const error = new Error("No active Goodbase tenant scope matches this account and request.");
    error.statusCode = 403;
    throw error;
  }

  request.goodbaseTenantContext = {
    organizationId: result.rows[0].organization_id,
    projectId: result.rows[0].project_id,
    environmentId: result.rows[0].environment_id
  };
  return request.goodbaseTenantContext;
}

async function logDataRequest(request, result) {
  const resourcePath = String(request.path || "/")
    .replace(/^\/+/, "")
    .split("/")
    .slice(0, 2)
    .join("/")
    .slice(0, 255);

  await database.query(
    `
      INSERT INTO backend_data_plane_request_logs (
        id,
        request_id,
        user_id,
        session_id,
        method,
        resource_path,
        response_status,
        duration_ms,
        request_bytes,
        response_bytes,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3::uuid,
        $4::uuid,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        NOW()
      )
    `,
    [
      `dpreq_${crypto.randomUUID().replaceAll("-", "")}`,
      request.id || request.get("x-request-id") || null,
      request.user?.id || null,
      request.auth?.sessionId || null,
      request.method,
      resourcePath || "/",
      result.statusCode,
      result.durationMs,
      result.requestBytes,
      result.responseBytes
    ]
  );
}

async function relationMetadata(sourceSchema, sourceName) {
  const result = await database.query(
    `
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS relation_name,
        relation.relkind,
        relation.relrowsecurity AS rls_enabled,
        relation.relforcerowsecurity AS rls_forced,
        ARRAY(
          SELECT attribute.attname
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          ORDER BY attribute.attnum
        ) AS columns
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = $2
        AND relation.relkind IN ('r', 'p')
      LIMIT 1
    `,
    [sourceSchema, sourceName]
  );

  return result.rows[0] || null;
}

async function publishRelation({
  sourceSchema,
  sourceName,
  apiName,
  columns,
  operations,
  actorId
}) {
  const source = await relationMetadata(sourceSchema, sourceName);
  if (!source) {
    const error = new Error("The requested source table does not exist or is not publishable.");
    error.statusCode = 404;
    throw error;
  }

  if (["r", "p"].includes(source.relkind) && !source.rls_enabled) {
    const error = new Error("Row Level Security must be enabled before publishing a table.");
    error.statusCode = 409;
    throw error;
  }

  const unknownColumns = columns.filter((column) => !source.columns.includes(column));
  if (unknownColumns.length) {
    const error = new Error(`Unknown source columns: ${unknownColumns.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }

  const sourceQualified = `${quoteIdentifier(sourceSchema)}.${quoteIdentifier(sourceName)}`;
  const apiQualified = `${quoteIdentifier(API_SCHEMA)}.${quoteIdentifier(apiName)}`;
  const columnList = columns.map(quoteIdentifier).join(", ");
  const operationList = operations.join(", ");
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE OR REPLACE VIEW ${apiQualified}
       WITH (security_invoker = true, security_barrier = true)
       AS SELECT ${columnList} FROM ${sourceQualified}`
    );
    await client.query(`REVOKE ALL ON ${apiQualified} FROM PUBLIC, goodos_anon`);
    await client.query(`GRANT ${operationList} ON ${apiQualified} TO goodos_authenticated`);

    if (operations.includes("SELECT")) {
      await client.query(
        `GRANT SELECT (${columnList}) ON ${sourceQualified} TO goodos_authenticated`
      );
    }
    if (operations.includes("INSERT")) {
      await client.query(
        `GRANT INSERT (${columnList}) ON ${sourceQualified} TO goodos_authenticated`
      );
    }
    if (operations.includes("UPDATE")) {
      await client.query(
        `GRANT UPDATE (${columnList}) ON ${sourceQualified} TO goodos_authenticated`
      );
    }
    if (operations.includes("DELETE")) {
      await client.query(
        `GRANT DELETE ON ${sourceQualified} TO goodos_authenticated`
      );
    }

    await client.query(
      `
        INSERT INTO backend_data_plane_publications (
          id,
          api_schema,
          api_name,
          source_schema,
          source_name,
          columns_json,
          operations_json,
          status,
          created_by,
          published_at,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
          'active', $8::uuid, NOW(), NOW(), NOW()
        )
        ON CONFLICT (api_schema, api_name)
        DO UPDATE SET
          source_schema = EXCLUDED.source_schema,
          source_name = EXCLUDED.source_name,
          columns_json = EXCLUDED.columns_json,
          operations_json = EXCLUDED.operations_json,
          status = 'active',
          created_by = EXCLUDED.created_by,
          published_at = NOW(),
          unpublished_at = NULL,
          updated_at = NOW()
      `,
      [
        `dppub_${crypto.randomUUID().replaceAll("-", "")}`,
        API_SCHEMA,
        apiName,
        sourceSchema,
        sourceName,
        JSON.stringify(columns),
        JSON.stringify(operations),
        actorId
      ]
    );
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

controlRouter.get("/health", async (request, response) => {
  noStore(response);
  const snapshot = await readinessSnapshot();

  return response.status(snapshot.ready ? 200 : 503).json({
    success: snapshot.ready,
    service: "Goodbase Data Platform",
    status: snapshot.ready ? "operational" : "degraded",
    publicBaseUrl: PUBLIC_BASE_URL,
    endpoints: {
      rest: `${PUBLIC_BASE_URL}/rest/v1`,
      health: `${PUBLIC_BASE_URL}/api/data-platform/health`
    },
    components: {
      automaticRest: snapshot.postgrest,
      database: snapshot.database
    },
    limits: {
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxQueryBytes: MAX_QUERY_BYTES,
      maxBodyBytes: MAX_BODY_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES
    }
  });
});

controlRouter.get(
  "/readiness",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response) => {
    noStore(response);
    const snapshot = await readinessSnapshot();
    const componentResult = await database.query(
      `
        SELECT
          component,
          version,
          status,
          endpoint,
          health_status AS "healthStatus",
          last_health_check_at AS "lastHealthCheckAt",
          metadata_json AS metadata
        FROM backend_data_plane_components
        ORDER BY component
      `
    );

    return response.status(snapshot.ready ? 200 : 503).json({
      success: snapshot.ready,
      service: "Goodbase Data Platform",
      status: snapshot.ready ? "ready" : "not_ready",
      snapshot,
      components: componentResult.rows
    });
  }
);

controlRouter.post("/token", authRequired, async (request, response) => {
  noStore(response);
  try {
    await resolveTenantContext(request);
    return response.json({
      success: true,
      token: mintDataPlaneToken(request),
      tokenType: "Bearer",
      expiresIn: DATA_TOKEN_TTL,
      endpoint: `${PUBLIC_BASE_URL}/rest/v1`,
      schema: API_SCHEMA
    });
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to issue a data-plane token."
    });
  }
});

controlRouter.post(
  "/token/service",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response, next) => {
    try {
      noStore(response);
      await resolveTenantContext(request);
      const token = mintServiceDataPlaneToken(request);
      await managementAudit(
        request,
        "goodbase.data.service_token.issue",
        "data_platform",
        request.goodbaseTenantContext.projectId,
        { expiresIn: SERVICE_DATA_TOKEN_TTL, ...request.goodbaseTenantContext }
      );
      return response.json({
        success: true,
        token,
        tokenType: "Bearer",
        expiresIn: SERVICE_DATA_TOKEN_TTL,
        endpoint: `${PUBLIC_BASE_URL}/rest/v1`,
        scope: request.goodbaseTenantContext
      });
    } catch (error) {
      return next(error);
    }
  }
);

controlRouter.get(
  "/publications",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response, next) => {
    try {
      noStore(response);
      const result = await database.query(
        `
          SELECT
            id,
            api_schema AS "apiSchema",
            api_name AS "apiName",
            source_schema AS "sourceSchema",
            source_name AS "sourceName",
            columns_json AS columns,
            operations_json AS operations,
            status,
            published_at AS "publishedAt",
            unpublished_at AS "unpublishedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM backend_data_plane_publications
          ORDER BY api_name
        `
      );
      return response.json({
        success: true,
        schema: API_SCHEMA,
        count: result.rows.length,
        publications: result.rows
      });
    } catch (error) {
      return next(error);
    }
  }
);

controlRouter.post(
  "/publications",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response, next) => {
    try {
      const sourceSchema = identifier(request.body?.sourceSchema || "public", "source schema");
      const sourceName = identifier(request.body?.sourceName, "source relation");
      const apiName = identifier(request.body?.apiName || sourceName, "API name");
      const columns = normalizeColumns(request.body?.columns);
      const operations = normalizeOperations(request.body?.operations);

      await publishRelation({
        sourceSchema,
        sourceName,
        apiName,
        columns,
        operations,
        actorId: request.user.id
      });
      await managementAudit(
        request,
        "goodbase.data.publication.upsert",
        "data_publication",
        apiName,
        {
          sourceSchema,
          sourceName,
          columns,
          operations
        }
      );

      return response.status(201).json({
        success: true,
        publication: {
          apiSchema: API_SCHEMA,
          apiName,
          sourceSchema,
          sourceName,
          columns,
          operations,
          endpoint: `${PUBLIC_BASE_URL}/rest/v1/${apiName}`
        }
      });
    } catch (error) {
      if (error.statusCode) {
        return response.status(error.statusCode).json({
          success: false,
          message: error.message
        });
      }
      return next(error);
    }
  }
);

controlRouter.delete(
  "/publications/:apiName",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response, next) => {
    let client;

    try {
      const apiName = identifier(request.params.apiName, "API name");
      client = await database.pool.connect();
      await client.query("BEGIN");
      await client.query(
        `DROP VIEW IF EXISTS ${quoteIdentifier(API_SCHEMA)}.${quoteIdentifier(apiName)}`
      );
      const result = await client.query(
        `
          UPDATE backend_data_plane_publications
          SET
            status = 'inactive',
            unpublished_at = NOW(),
            updated_at = NOW()
          WHERE api_schema = $1
            AND api_name = $2
          RETURNING
            source_schema AS "sourceSchema",
            source_name AS "sourceName"
        `,
        [API_SCHEMA, apiName]
      );
      await client.query("NOTIFY pgrst, 'reload schema'");
      await client.query("COMMIT");

      await managementAudit(
        request,
        "goodbase.data.publication.remove",
        "data_publication",
        apiName,
        result.rows[0] || {}
      );

      return response.json({
        success: true,
        apiName,
        status: "inactive"
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => null);
      return next(error);
    } finally {
      if (client) client.release();
    }
  }
);

controlRouter.post(
  "/schema-cache/reload",
  authRequired,
  dataPlaneAdminRequired,
  async (request, response, next) => {
    try {
      await database.query("NOTIFY pgrst, 'reload schema'");
      await managementAudit(
        request,
        "goodbase.data.schema_cache.reload",
        "data_platform",
        "postgrest"
      );
      return response.json({
        success: true,
        message: "Goodbase REST schema reload requested."
      });
    } catch (error) {
      return next(error);
    }
  }
);

async function dataPlaneAuth(request, response, next) {
  const authorization = String(request.get("authorization") || "");
  const rawToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!rawToken) return authRequired(request, response, next);

  try {
    const decoded = jwt.verify(rawToken, env.jwtSecret);
    if (!["data_plane", "data_plane_service"].includes(decoded.tokenUse)) {
      return authRequired(request, response, next);
    }

    const result = await database.query(
      `
        SELECT
          session.id AS session_id,
          session.auth_level AS session_auth_level,
          session.mfa_verified AS session_mfa_verified,
          session.risk_score AS session_risk_score,
          account.*
        FROM sessions AS session
        JOIN users AS account ON account.id = session.user_id
        WHERE session.id = $1::uuid
          AND session.user_id = $2::uuid
          AND session.revoked_at IS NULL
          AND session.expires_at > NOW()
          AND account.status = 'active'
        LIMIT 1
      `,
      [decoded.sid, decoded.sub]
    );
    const sessionUser = result.rows[0];

    if (!sessionUser) {
      return response.status(401).json({
        success: false,
        message: "Data token session expired or revoked."
      });
    }
    if (sessionUser.mfa_required && !sessionUser.session_mfa_verified) {
      return response.status(403).json({
        success: false,
        message: "Complete the account's required MFA step before data access."
      });
    }

    request.user = publicUser(sessionUser);
    request.auth = {
      token: rawToken,
      decoded,
      source: "data_plane",
      sessionId: sessionUser.session_id,
      authLevel: sessionUser.session_auth_level || "password",
      mfaVerified: Boolean(sessionUser.session_mfa_verified),
      riskScore: Number(sessionUser.session_risk_score || 0)
    };
    return next();
  } catch {
    return response.status(401).json({
      success: false,
      message: "Invalid or expired data token."
    });
  }
}

restRouter.use(dataPlaneAuth);

restRouter.use(async (request, response) => {
  const startedAt = Date.now();
  let body = null;
  let requestBytes = 0;

  try {
    if (!ALLOWED_METHODS.has(request.method)) {
      response.set("Allow", [...ALLOWED_METHODS].join(", "));
      return response.status(405).json({
        success: false,
        message: "HTTP method is not supported by the Goodbase REST gateway."
      });
    }

    if (Buffer.byteLength(request.originalUrl || request.url || "", "utf8") > MAX_QUERY_BYTES) {
      return response.status(414).json({
        success: false,
        message: "REST query exceeds the configured URL limit."
      });
    }

    const acceptProfile = request.get("accept-profile");
    const contentProfile = request.get("content-profile");
    if (
      (acceptProfile && acceptProfile !== API_SCHEMA) ||
      (contentProfile && contentProfile !== API_SCHEMA)
    ) {
      return response.status(403).json({
        success: false,
        message: `Only the ${API_SCHEMA} schema is available through Goodbase REST.`
      });
    }

    if (!["GET", "HEAD", "DELETE", "OPTIONS"].includes(request.method) && request.body !== undefined) {
      body = Buffer.from(JSON.stringify(request.body));
      requestBytes = body.length;
      if (requestBytes > MAX_BODY_BYTES) {
        return response.status(413).json({
          success: false,
          message: "REST request body exceeds the configured limit."
        });
      }
    }

    await resolveTenantContext(request);
    const token = mintDataPlaneToken(request);
    const headers = {
      authorization: `Bearer ${token}`,
      accept: request.get("accept") || "application/json",
      "accept-profile": API_SCHEMA,
      "content-profile": API_SCHEMA,
      prefer: request.get("prefer") || "return=representation",
      "user-agent": request.get("user-agent") || "Goodbase-Data-Gateway/1.0",
      "x-request-id": request.id || request.get("x-request-id") || ""
    };

    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    if (request.get("range")) headers.range = request.get("range");
    if (request.get("range-unit")) headers["range-unit"] = request.get("range-unit");
    if (request.get("if-match")) headers["if-match"] = request.get("if-match");
    if (request.get("if-none-match")) headers["if-none-match"] = request.get("if-none-match");

    const upstream = await postgrestRequest({
      method: request.method,
      path: request.url || "/",
      headers,
      body
    });

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (FORWARDED_RESPONSE_HEADERS.has(name) && value !== undefined) {
        response.set(name, value);
      }
    }

    response.set("X-Goodbase-Data-Plane", "postgrest-14.12");
    response.set("X-GoodOS-Data-Plane", "postgrest-14.12");
    response.set("X-Content-Type-Options", "nosniff");

    await logDataRequest(request, {
      statusCode: upstream.statusCode,
      durationMs: Date.now() - startedAt,
      requestBytes,
      responseBytes: upstream.responseBytes
    }).catch(() => null);

    return response.status(upstream.statusCode).send(upstream.body);
  } catch (error) {
    const statusCode = error.statusCode || 502;

    await logDataRequest(request, {
      statusCode,
      durationMs: Date.now() - startedAt,
      requestBytes,
      responseBytes: 0
    }).catch(() => null);

    return response.status(statusCode).json({
      success: false,
      message: statusCode === 502
        ? "Goodbase Data API is temporarily unavailable."
        : error.message
    });
  }
});

module.exports = {
  controlRouter,
  restRouter,
  dataPlaneAuth,
  dataPlaneAdminRequired,
  resolveTenantContext,
  __test: {
    postgrestRequest,
    dataPlaneAuth,
    identifier,
    normalizeColumns,
    normalizeOperations,
    readinessSnapshot
  }
};
