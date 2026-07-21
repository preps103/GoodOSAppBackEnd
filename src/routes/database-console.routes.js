const express = require("express");

const router = express.Router();

const SECTION_ALIASES = {
  "published-tables": "published-tables",
  "published tables": "published-tables",
  published: "published-tables",

  "writable-tables": "writable-tables",
  "writable tables": "writable-tables",
  writable: "writable-tables",

  rules: "rules",
  policies: "rules",

  scope: "scope",
  permission: "scope",
  permissions: "scope"
};

function cleanKey(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[+"'`]/g, "")
    .replace(/[.)\];,]+$/g, "")
    .replace(/^\/+|\/+$/g, "");

  return SECTION_ALIASES[key] || key;
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...extra
  });
}

function loadExistingAuthMiddleware() {
  const candidates = [
    "../middleware/auth.middleware",
    "../middleware/auth",
    "../middleware/admin-auth.middleware",
    "../middleware/adminAuth",
    "../middlewares/auth.middleware",
    "../middlewares/auth",
    "../utils/auth.middleware",
    "../utils/auth"
  ];

  const names = [
    "requireAuth",
    "authenticate",
    "authenticateToken",
    "authMiddleware",
    "verifyToken",
    "verifyAuth",
    "requireAdmin",
    "adminAuth",
    "protect",
    "default"
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate);

      if (typeof mod === "function") return mod;

      for (const name of names) {
        if (typeof mod?.[name] === "function") return mod[name];
      }
    } catch (_) {}
  }

  return null;
}

const existingAuthMiddleware = loadExistingAuthMiddleware();

function requireAuth(req, res, next) {
  if (existingAuthMiddleware) {
    return existingAuthMiddleware(req, res, next);
  }

  const authHeader = String(req.headers.authorization || "");
  const cookie = String(req.headers.cookie || "");
  const hasBearer = /^Bearer\s+.+/i.test(authHeader);
  const hasSessionCookie = cookie.includes("token") || cookie.includes("session");

  if (!hasBearer && !hasSessionCookie) {
    return sendError(res, 401, "Authorization token required");
  }

  return next();
}

router.use(requireAuth);

async function runDb(sql, params = []) {
  if (!process.env.DATABASE_URL) {
    return {
      ok: false,
      reason: "DATABASE_URL is not configured",
      rows: []
    };
  }

  let Pool;

  try {
    Pool = require("pg").Pool;
  } catch (_) {
    return {
      ok: false,
      reason: "pg package is not installed",
      rows: []
    };
  }

  const databaseCa = String(process.env.DATABASE_SSL_CA || "").replace(/\\n/g, "\n") || undefined;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: true, ...(databaseCa ? { ca: databaseCa } : {}) },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
    max: 1
  });

  try {
    const result = await pool.query(sql, params);

    return {
      ok: true,
      rows: result.rows || []
    };
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? err.message : "Database query failed",
      rows: []
    };
  } finally {
    try {
      await pool.end();
    } catch (_) {}
  }
}

function payload(section, title, subtitle, metrics, tables, notes = []) {
  return {
    success: true,
    console: "database",
    section,
    title,
    subtitle,
    generatedAt: new Date().toISOString(),
    metrics,
    tables,
    notes
  };
}

async function getPublishedTables() {
  const tables = await runDb(`
    SELECT
      table_schema,
      table_name,
      table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);

  const columns = await runDb(`
    SELECT
      table_schema,
      table_name,
      COUNT(*)::int AS column_count,
      string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
  `);

  const count = tables.rows.length;

  return payload(
    "published-tables",
    "Published Tables",
    "Live database table visibility from information_schema. This shows what tables the backend can currently inspect.",
    [
      { label: "Tables", value: count },
      { label: "Columns", value: columns.rows.reduce((sum, row) => sum + Number(row.column_count || 0), 0) },
      { label: "Database", value: tables.ok ? "Connected" : "Unavailable" },
      { label: "Access", value: "Read" }
    ],
    [
      {
        title: "Database Tables",
        columns: ["table_schema", "table_name", "table_type"],
        rows: tables.rows
      },
      {
        title: "Table Columns",
        columns: ["table_schema", "table_name", "column_count", "columns"],
        rows: columns.rows
      }
    ],
    tables.ok ? ["This panel is live and read-only."] : [tables.reason]
  );
}

async function getWritableTables() {
  const grants = await runDb(`
    SELECT
      table_schema,
      table_name,
      grantee,
      string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
    FROM information_schema.role_table_grants
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
    GROUP BY table_schema, table_name, grantee
    ORDER BY table_schema, table_name, grantee
  `);

  const tables = await runDb(`
    SELECT
      table_schema,
      table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);

  const writableTableNames = new Set(
    grants.rows.map((row) => `${row.table_schema}.${row.table_name}`)
  );

  return payload(
    "writable-tables",
    "Writable Tables",
    "Live write-permission visibility from database table grants.",
    [
      { label: "Writable Tables", value: writableTableNames.size },
      { label: "Write Grants", value: grants.rows.length },
      { label: "Total Tables", value: tables.rows.length },
      { label: "Database", value: grants.ok ? "Connected" : "Unavailable" }
    ],
    [
      {
        title: "Writable Grants",
        columns: ["table_schema", "table_name", "grantee", "privileges"],
        rows: grants.rows
      },
      {
        title: "All Tables",
        columns: ["table_schema", "table_name"],
        rows: tables.rows
      }
    ],
    grants.ok ? ["This panel shows write capability only. It does not modify any table."] : [grants.reason]
  );
}

async function getRules() {
  const policies = await runDb(`
    SELECT
      schemaname,
      tablename,
      policyname,
      permissive,
      roles::text AS roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    ORDER BY schemaname, tablename, policyname
  `);

  const tableRules = await runDb(`
    SELECT
      table_schema,
      table_name,
      is_insertable_into
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `);

  return payload(
    "rules",
    "Rules",
    "Live database policy and table-rule visibility.",
    [
      { label: "Policies", value: policies.rows.length },
      { label: "Tables Checked", value: tableRules.rows.length },
      { label: "Database", value: policies.ok ? "Connected" : "Unavailable" },
      { label: "Mode", value: "Read-only" }
    ],
    [
      {
        title: "Postgres Policies",
        columns: ["schemaname", "tablename", "policyname", "permissive", "roles", "cmd", "qual", "with_check"],
        rows: policies.rows
      },
      {
        title: "Table Insertability",
        columns: ["table_schema", "table_name", "is_insertable_into"],
        rows: tableRules.rows
      }
    ],
    policies.ok ? ["Rules are read from pg_policies and information_schema."] : [policies.reason]
  );
}

async function getScope() {
  const dbInfo = await runDb(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      current_schema() AS current_schema,
      inet_server_addr()::text AS server_address,
      inet_server_port()::text AS server_port
  `);

  const tableCounts = await runDb(`
    SELECT
      table_schema,
      COUNT(*)::int AS table_count
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    GROUP BY table_schema
    ORDER BY table_schema
  `);

  const envRows = [
    { setting: "DATABASE_URL", status: process.env.DATABASE_URL ? "Configured" : "Missing", value: process.env.DATABASE_URL ? "Configured / masked" : "Not configured" },
    { setting: "NODE_ENV", status: process.env.NODE_ENV ? "Configured" : "Missing", value: process.env.NODE_ENV || "Not configured" },
    { setting: "DATABASE_SSL", status: process.env.DATABASE_SSL ? "Configured" : "Default", value: process.env.DATABASE_SSL || "default SSL behavior" }
  ];

  return payload(
    "scope",
    "Scope",
    "Live database scope, current connection identity, schemas, and masked environment readiness.",
    [
      { label: "Scope", value: "read:db" },
      { label: "Database", value: dbInfo.ok ? "Connected" : "Unavailable" },
      { label: "Schemas", value: tableCounts.rows.length },
      { label: "DB URL", value: process.env.DATABASE_URL ? "Configured" : "Missing" }
    ],
    [
      {
        title: "Current Database Connection",
        columns: ["database_name", "database_user", "current_schema", "server_address", "server_port"],
        rows: dbInfo.rows
      },
      {
        title: "Schema Table Counts",
        columns: ["table_schema", "table_count"],
        rows: tableCounts.rows
      },
      {
        title: "Database Environment",
        columns: ["setting", "status", "value"],
        rows: envRows
      }
    ],
    dbInfo.ok ? ["Sensitive connection values are masked."] : [dbInfo.reason]
  );
}

async function buildSection(section) {
  if (section === "published-tables") return getPublishedTables();
  if (section === "writable-tables") return getWritableTables();
  if (section === "rules") return getRules();
  if (section === "scope") return getScope();

  return null;
}

router.get("/summary", async (req, res) => {
  return res.json({
    success: true,
    console: "database",
    title: "Database Console",
    generatedAt: new Date().toISOString(),
    sections: [
      { key: "published-tables", label: "Published Tables", endpoint: "/api/admin/database-console/section/published-tables" },
      { key: "writable-tables", label: "Writable Tables", endpoint: "/api/admin/database-console/section/writable-tables" },
      { key: "rules", label: "Rules", endpoint: "/api/admin/database-console/section/rules" },
      { key: "scope", label: "Scope", endpoint: "/api/admin/database-console/section/scope" }
    ]
  });
});

router.get("/section/:sectionKey", async (req, res) => {
  const section = cleanKey(req.params.sectionKey);
  const data = await buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown database section", {
      section,
      availableSections: ["published-tables", "writable-tables", "rules", "scope"]
    });
  }

  return res.json(data);
});

router.get("/:sectionKey", async (req, res) => {
  const section = cleanKey(req.params.sectionKey);
  const data = await buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown database section", {
      section,
      availableSections: ["published-tables", "writable-tables", "rules", "scope"]
    });
  }

  return res.json(data);
});

module.exports = router;
