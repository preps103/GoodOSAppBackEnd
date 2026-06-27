const express = require("express");

const router = express.Router();

function resolveDb() {
  const candidates = [
    "../db",
    "../db/index",
    "../db/pool",
    "../config/db",
    "../config/database",
    "../database",
    "../database/pool",
    "../lib/db",
    "../lib/pool"
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod && typeof mod.query === "function") return mod;
      if (mod && mod.pool && typeof mod.pool.query === "function") return mod.pool;
      if (mod && mod.default && typeof mod.default.query === "function") return mod.default;
    } catch (err) {}
  }

  if (global.pool && typeof global.pool.query === "function") return global.pool;
  if (global.db && typeof global.db.query === "function") return global.db;

  throw new Error("Database pool could not be resolved.");
}

function sendError(res, err) {
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || "SQL editor request failed."
  });
}

function normalizeSql(sql) {
  return String(sql || "").trim();
}

function isDangerousSql(sql) {
  const clean = normalizeSql(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .toLowerCase();

  return /\b(drop|truncate|alter\s+system|grant|revoke|copy\s+.*\s+to\s+program|copy\s+.*\s+from\s+program)\b/.test(clean);
}

async function ensureTables(db) {
  await db.query(`
    create table if not exists backend_sql_editor_saved_queries (
      id text primary key,
      name text not null,
      folder text not null default 'private',
      sql_text text not null,
      tags text[] not null default '{}',
      is_favorite boolean not null default false,
      run_count integer not null default 0,
      last_run_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await db.query(`
    create table if not exists backend_sql_editor_query_runs (
      id text primary key,
      saved_query_id text,
      sql_text text not null,
      status text not null,
      row_count integer not null default 0,
      duration_ms integer not null default 0,
      error_message text,
      role_name text,
      created_at timestamptz not null default now()
    )
  `);
}

router.get("/health", async (req, res) => {
  try {
    const db = resolveDb();
    await ensureTables(db);

    const result = await db.query("select now() as now");

    res.json({
      success: true,
      status: "ok",
      service: "GoodOS SQL Editor",
      now: result.rows[0].now
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/page-data", async (req, res) => {
  try {
    const db = resolveDb();
    await ensureTables(db);

    const saved = await db.query(`
      select id, name, folder, sql_text, tags, is_favorite, run_count, last_run_at, created_at, updated_at
      from backend_sql_editor_saved_queries
      order by is_favorite desc, updated_at desc
      limit 100
    `);

    const runs = await db.query(`
      select id, saved_query_id, sql_text, status, row_count, duration_ms, error_message, role_name, created_at
      from backend_sql_editor_query_runs
      order by created_at desc
      limit 50
    `);

    const stats = await db.query(`
      select
        (select count(*)::int from backend_sql_editor_saved_queries) as saved_queries,
        (select count(*)::int from backend_sql_editor_saved_queries where folder = 'shared') as shared_queries,
        (select count(*)::int from backend_sql_editor_saved_queries where is_favorite = true) as favorites,
        (select count(*)::int from backend_sql_editor_saved_queries where folder = 'private') as private_queries,
        (select count(*)::int from backend_sql_editor_query_runs) as total_runs,
        (select count(*)::int from backend_sql_editor_query_runs where status = 'success') as successful_runs,
        (select count(*)::int from backend_sql_editor_query_runs where status = 'failed') as failed_runs
    `);

    res.json({
      success: true,
      stats: stats.rows[0],
      savedQueries: saved.rows,
      recentRuns: runs.rows,
      templates: [
        {
          name: "List public tables",
          sql: "select table_name, table_type from information_schema.tables where table_schema = 'public' order by table_name;"
        },
        {
          name: "Inspect columns",
          sql: "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position;"
        },
        {
          name: "Recent API keys",
          sql: "select * from backend_api_keys order by created_at desc limit 20;"
        },
        {
          name: "Recent audit logs",
          sql: "select * from backend_audit_logs order by created_at desc limit 20;"
        },
        {
          name: "Storage buckets",
          sql: "select * from backend_storage_buckets order by created_at desc limit 20;"
        }
      ]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/run", async (req, res) => {
  const started = Date.now();

  try {
    const db = resolveDb();
    await ensureTables(db);

    const sql = normalizeSql(req.body.sql);
    const roleName = String(req.body.roleName || "admin").trim();
    const savedQueryId = req.body.savedQueryId || null;
    const allowDangerous = req.body.allowDangerous === true;

    if (!sql) {
      const err = new Error("SQL is required.");
      err.statusCode = 400;
      throw err;
    }

    if (isDangerousSql(sql) && !allowDangerous) {
      const err = new Error("Blocked risky SQL. This editor blocks DROP, TRUNCATE, GRANT, REVOKE, and ALTER SYSTEM unless explicitly allowed.");
      err.statusCode = 400;
      throw err;
    }

    await db.query("set statement_timeout = '15000ms'");
    const result = await db.query(sql);
    const durationMs = Date.now() - started;
    const runId = "sqlrun_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2, 10);

    await db.query(`
      insert into backend_sql_editor_query_runs
      (id, saved_query_id, sql_text, status, row_count, duration_ms, role_name)
      values ($1, $2, $3, 'success', $4, $5, $6)
    `, [
      runId,
      savedQueryId,
      sql,
      Array.isArray(result.rows) ? result.rows.length : (result.rowCount || 0),
      durationMs,
      roleName
    ]);

    if (savedQueryId) {
      await db.query(`
        update backend_sql_editor_saved_queries
        set run_count = run_count + 1,
            last_run_at = now(),
            updated_at = now()
        where id = $1
      `, [savedQueryId]);
    }

    res.json({
      success: true,
      runId,
      durationMs,
      command: result.command || null,
      rowCount: result.rowCount || 0,
      fields: Array.isArray(result.fields) ? result.fields.map((field) => field.name) : [],
      rows: Array.isArray(result.rows) ? result.rows : []
    });
  } catch (err) {
    try {
      const db = resolveDb();
      await ensureTables(db);
      const durationMs = Date.now() - started;
      const runId = "sqlrun_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2, 10);

      await db.query(`
        insert into backend_sql_editor_query_runs
        (id, saved_query_id, sql_text, status, row_count, duration_ms, error_message, role_name)
        values ($1, $2, $3, 'failed', 0, $4, $5, $6)
      `, [
        runId,
        req.body.savedQueryId || null,
        normalizeSql(req.body.sql),
        durationMs,
        err.message || "SQL failed.",
        String(req.body.roleName || "admin").trim()
      ]);
    } catch (logErr) {}

    sendError(res, err);
  }
});

router.post("/saved-queries", async (req, res) => {
  try {
    const db = resolveDb();
    await ensureTables(db);

    const id = req.body.id || ("sqlq_" + Date.now().toString(36) + "_" + Math.random().toString(16).slice(2, 10));
    const name = String(req.body.name || "Untitled query").trim();
    const folder = String(req.body.folder || "private").trim();
    const sqlText = normalizeSql(req.body.sqlText || req.body.sql);
    const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    const isFavorite = req.body.isFavorite === true;

    if (!sqlText) {
      const err = new Error("SQL text is required.");
      err.statusCode = 400;
      throw err;
    }

    const result = await db.query(`
      insert into backend_sql_editor_saved_queries
      (id, name, folder, sql_text, tags, is_favorite, updated_at)
      values ($1, $2, $3, $4, $5, $6, now())
      on conflict (id) do update
      set name = excluded.name,
          folder = excluded.folder,
          sql_text = excluded.sql_text,
          tags = excluded.tags,
          is_favorite = excluded.is_favorite,
          updated_at = now()
      returning *
    `, [id, name, folder, sqlText, tags, isFavorite]);

    res.json({
      success: true,
      query: result.rows[0]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/saved-queries/:id", async (req, res) => {
  try {
    const db = resolveDb();
    await ensureTables(db);

    const result = await db.query(
      "delete from backend_sql_editor_saved_queries where id = $1 returning *",
      [req.params.id]
    );

    res.json({
      success: true,
      deleted: result.rowCount,
      query: result.rows[0] || null
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
