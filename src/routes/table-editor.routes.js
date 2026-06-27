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

  throw new Error("Database pool could not be resolved for table editor routes.");
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

function safeSchema(value) {
  const schema = String(value || "public").trim();
  return safeIdentifier(schema);
}

function safeTable(value) {
  return safeIdentifier(value);
}

function parseJsonBody(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || "Table editor request failed."
  });
}

router.get("/health", async (req, res) => {
  try {
    const db = resolveDb();
    const result = await db.query("select now() as now");
    res.json({
      success: true,
      service: "GoodOS Table Editor",
      status: "ok",
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
        coalesce(obj_description((quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))::regclass), '') as description,
        (
          select count(*)
          from information_schema.columns c
          where c.table_schema = t.table_schema
            and c.table_name = t.table_name
        )::int as column_count
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

router.get("/tables/:schema/:table/columns", async (req, res) => {
  try {
    const db = resolveDb();
    const schema = String(req.params.schema || "public").trim();
    const table = String(req.params.table || "").trim();

    const result = await db.query(`
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

    res.json({
      success: true,
      schema,
      table,
      columns: result.rows
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
      select column_name, data_type
      from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position
    `, [schema, table]);

    const columns = columnsResult.rows;
    const schemaSql = safeSchema(schema);
    const tableSql = safeTable(table);

    let whereSql = "";
    const params = [];
    let paramIndex = 1;

    if (q && columns.length) {
      const textCols = columns
        .filter((col) => [
          "text",
          "character varying",
          "character",
          "uuid",
          "json",
          "jsonb",
          "timestamp without time zone",
          "timestamp with time zone"
        ].includes(col.data_type))
        .slice(0, 8);

      if (textCols.length) {
        params.push(`%${q}%`);
        whereSql = " where " + textCols
          .map((col) => `${safeIdentifier(col.column_name)}::text ilike $${paramIndex}`)
          .join(" or ");
        paramIndex += 1;
      }
    }

    params.push(limit);
    const limitIndex = paramIndex;
    paramIndex += 1;

    params.push(offset);
    const offsetIndex = paramIndex;

    const rowsResult = await db.query(
      `select * from ${schemaSql}.${tableSql}${whereSql} limit $${limitIndex} offset $${offsetIndex}`,
      params
    );

    const countResult = await db.query(
      `select count(*)::int as count from ${schemaSql}.${tableSql}${whereSql}`,
      params.slice(0, params.length - 2)
    );

    res.json({
      success: true,
      schema,
      table,
      limit,
      offset,
      total: countResult.rows[0].count,
      columns,
      rows: rowsResult.rows
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
    const columns = parseJsonBody(req.body.columns, []);

    if (!table) {
      const err = new Error("Table name is required.");
      err.statusCode = 400;
      throw err;
    }

    const cleanColumns = Array.isArray(columns) && columns.length
      ? columns
      : [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "title", type: "text" },
          { name: "status", type: "text", defaultValue: "'active'" },
          { name: "metadata_json", type: "jsonb", defaultValue: "'{}'::jsonb" },
          { name: "created_at", type: "timestamptz", defaultValue: "now()" },
          { name: "updated_at", type: "timestamptz", defaultValue: "now()" }
        ];

    const allowedTypes = new Set([
      "text",
      "varchar",
      "integer",
      "bigint",
      "numeric",
      "boolean",
      "uuid",
      "jsonb",
      "json",
      "date",
      "timestamp",
      "timestamptz"
    ]);

    const columnSql = cleanColumns.map((col) => {
      const name = safeIdentifier(col.name);
      const type = String(col.type || "text").toLowerCase().trim();

      if (!allowedTypes.has(type)) {
        const err = new Error(`Unsupported column type: ${type}`);
        err.statusCode = 400;
        throw err;
      }

      let line = `${name} ${type}`;

      if (col.primaryKey) line += " primary key";
      if (col.notNull) line += " not null";
      if (col.defaultValue) line += ` default ${String(col.defaultValue)}`;

      return line;
    }).join(",\n");

    await db.query(`create schema if not exists ${safeSchema(schema)}`);
    await db.query(`create table if not exists ${safeSchema(schema)}.${safeTable(table)} (\n${columnSql}\n)`);

    res.json({
      success: true,
      schema,
      table,
      message: "Table created or already exists."
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
    const body = parseJsonBody(req.body.row || req.body, {});

    const keys = Object.keys(body).filter((key) => body[key] !== undefined);

    if (!keys.length) {
      const err = new Error("No row data provided.");
      err.statusCode = 400;
      throw err;
    }

    const params = keys.map((key) => body[key]);
    const sql = `
      insert into ${safeSchema(schema)}.${safeTable(table)}
      (${keys.map(safeIdentifier).join(", ")})
      values (${keys.map((_, i) => `$${i + 1}`).join(", ")})
      returning *
    `;

    const result = await db.query(sql, params);

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
    const row = parseJsonBody(req.body.row, {});

    const keys = Object.keys(row).filter((key) => key !== idColumn && row[key] !== undefined);

    if (!keys.length) {
      const err = new Error("No update fields provided.");
      err.statusCode = 400;
      throw err;
    }

    const params = keys.map((key) => row[key]);
    params.push(idValue);

    const result = await db.query(`
      update ${safeSchema(schema)}.${safeTable(table)}
      set ${keys.map((key, i) => `${safeIdentifier(key)} = $${i + 1}`).join(", ")}
      where ${safeIdentifier(idColumn)} = $${params.length}
      returning *
    `, params);

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

    if (idValue == null || idValue === "") {
      const err = new Error("idValue is required.");
      err.statusCode = 400;
      throw err;
    }

    const result = await db.query(`
      delete from ${safeSchema(schema)}.${safeTable(table)}
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
