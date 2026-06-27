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
    error: err.message || "Table editor request failed."
  });
}

function safeIdentifier(value) {
  const raw = String(value || "").trim();

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
    const err = new Error("Invalid SQL identifier.");
    err.statusCode = 400;
    throw err;
  }

  return `"${raw.replace(/"/g, '""')}"`;
}

function parseBodyJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

router.get("/health", async (req, res) => {
  try {
    const db = resolveDb();
    const result = await db.query("select now() as now");
    res.json({
      success: true,
      status: "ok",
      service: "GoodOS Table Editor",
      now: result.rows[0].now
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/schemas", async (req, res) => {
  try {
    const db = resolveDb();

    const result = await db.query(`
      select schema_name
      from information_schema.schemata
      where schema_name not in ('pg_catalog', 'information_schema')
        and schema_name not like 'pg_toast%'
      order by case when schema_name = 'public' then 0 else 1 end, schema_name
    `);

    res.json({
      success: true,
      schemas: result.rows.map((row) => row.schema_name)
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/tables", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.query.schema || "public").trim();

    const result = await db.query(`
      select
        t.table_schema,
        t.table_name,
        t.table_type,
        (
          select count(*)
          from information_schema.columns c
          where c.table_schema = t.table_schema
            and c.table_name = t.table_name
        )::int as column_count,
        coalesce(
          (
            select s.n_live_tup::bigint
            from pg_stat_user_tables s
            where s.schemaname = t.table_schema
              and s.relname = t.table_name
            limit 1
          ),
          0
        )::bigint as estimated_rows
      from information_schema.tables t
      where t.table_schema = $1
        and t.table_type in ('BASE TABLE', 'VIEW')
      order by t.table_name
    `, [schema]);

    res.json({
      success: true,
      schema,
      tables: result.rows
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/tables/:schema/:table/rows", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.params.schema || "public").trim();
    const table = String(req.params.table || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
    const q = String(req.query.q || "").trim();

    const columnsResult = await db.query(`
      select
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        c.ordinal_position,
        exists (
          select 1
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
           and tc.table_schema = kcu.table_schema
           and tc.table_name = kcu.table_name
          where tc.constraint_type = 'PRIMARY KEY'
            and tc.table_schema = c.table_schema
            and tc.table_name = c.table_name
            and kcu.column_name = c.column_name
        ) as is_primary_key
      from information_schema.columns c
      where c.table_schema = $1
        and c.table_name = $2
      order by c.ordinal_position
    `, [schema, table]);

    const columns = columnsResult.rows;
    const params = [];
    let whereSql = "";

    if (q && columns.length) {
      const searchable = columns
        .filter((column) => !["bytea"].includes(column.data_type))
        .slice(0, 10);

      if (searchable.length) {
        params.push(`%${q}%`);
        whereSql = " where " + searchable
          .map((column) => `${safeIdentifier(column.column_name)}::text ilike $1`)
          .join(" or ");
      }
    }

    const countResult = await db.query(
      `select count(*)::int as count from ${safeIdentifier(schema)}.${safeIdentifier(table)}${whereSql}`,
      params
    );

    params.push(limit);
    params.push(offset);

    const rowsResult = await db.query(
      `select * from ${safeIdentifier(schema)}.${safeIdentifier(table)}${whereSql} limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json({
      success: true,
      schema,
      table,
      columns,
      rows: rowsResult.rows,
      total: countResult.rows[0].count,
      limit,
      offset
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/tables/create", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.body.schema || "public").trim();
    const table = String(req.body.table || "").trim();

    if (!table) {
      const err = new Error("Table name is required.");
      err.statusCode = 400;
      throw err;
    }

    await db.query(`create schema if not exists ${safeIdentifier(schema)}`);
    await db.query(`
      create table if not exists ${safeIdentifier(schema)}.${safeIdentifier(table)} (
        id uuid primary key default gen_random_uuid(),
        name text,
        email text,
        role text default 'viewer',
        status text default 'active',
        metadata_json jsonb default '{}'::jsonb,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      )
    `);

    res.json({
      success: true,
      schema,
      table,
      message: "Table created."
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/tables/:schema/:table/rows", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.params.schema || "public").trim();
    const table = String(req.params.table || "").trim();
    const row = parseBodyJson(req.body.row || req.body, {});
    const keys = Object.keys(row).filter((key) => row[key] !== undefined);

    if (!keys.length) {
      const err = new Error("No row data provided.");
      err.statusCode = 400;
      throw err;
    }

    const values = keys.map((key) => row[key]);

    const result = await db.query(`
      insert into ${safeIdentifier(schema)}.${safeIdentifier(table)}
      (${keys.map(safeIdentifier).join(", ")})
      values (${keys.map((_, index) => `$${index + 1}`).join(", ")})
      returning *
    `, values);

    res.json({
      success: true,
      row: result.rows[0]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch("/tables/:schema/:table/rows", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.params.schema || "public").trim();
    const table = String(req.params.table || "").trim();
    const idColumn = String(req.body.idColumn || "id").trim();
    const idValue = req.body.idValue;
    const row = parseBodyJson(req.body.row, {});
    const keys = Object.keys(row).filter((key) => key !== idColumn && row[key] !== undefined);

    if (!keys.length) {
      const err = new Error("No update fields provided.");
      err.statusCode = 400;
      throw err;
    }

    const values = keys.map((key) => row[key]);
    values.push(idValue);

    const result = await db.query(`
      update ${safeIdentifier(schema)}.${safeIdentifier(table)}
      set ${keys.map((key, index) => `${safeIdentifier(key)} = $${index + 1}`).join(", ")}
      where ${safeIdentifier(idColumn)} = $${values.length}
      returning *
    `, values);

    res.json({
      success: true,
      row: result.rows[0] || null
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/tables/:schema/:table/rows", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.params.schema || "public").trim();
    const table = String(req.params.table || "").trim();
    const idColumn = String(req.query.idColumn || "id").trim();
    const idValue = req.query.idValue;

    if (!idValue) {
      const err = new Error("idValue is required.");
      err.statusCode = 400;
      throw err;
    }

    const result = await db.query(`
      delete from ${safeIdentifier(schema)}.${safeIdentifier(table)}
      where ${safeIdentifier(idColumn)} = $1
      returning *
    `, [idValue]);

    res.json({
      success: true,
      deleted: result.rowCount,
      row: result.rows[0] || null
    });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
