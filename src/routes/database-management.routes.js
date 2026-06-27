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
    error: err.message || "Database management request failed."
  });
}

async function safeQuery(db, sql, params = []) {
  try {
    const result = await db.query(sql, params);
    return {
      ok: true,
      rows: result.rows || [],
      count: result.rowCount || (result.rows ? result.rows.length : 0)
    };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      count: 0,
      error: err.message
    };
  }
}

async function tableExists(db, tableName) {
  const result = await db.query("select to_regclass($1) as regclass", [tableName]);
  return !!(result.rows[0] && result.rows[0].regclass);
}

function sectionResponse(slug, title, description, columns, queryResult, extra = {}) {
  return {
    success: true,
    slug,
    title,
    description,
    columns,
    rows: queryResult.rows || [],
    count: queryResult.rows ? queryResult.rows.length : 0,
    queryOk: queryResult.ok !== false,
    error: queryResult.error || null,
    ...extra
  };
}

router.get("/health", async (req, res) => {
  try {
    const db = resolveDb();
    const result = await db.query("select current_database() as database_name, current_user as user_name, now() as now");

    res.json({
      success: true,
      status: "ok",
      service: "GoodOS Database Management",
      database: result.rows[0]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/summary", async (req, res) => {
  try {
    const db = resolveDb();

    const result = await db.query(`
      select
        (select count(*)::int from information_schema.schemata where schema_name not in ('pg_catalog','information_schema') and schema_name not like 'pg_toast%') as schemas,
        (select count(*)::int from information_schema.tables where table_schema not in ('pg_catalog','information_schema')) as tables,
        (select count(*)::int from information_schema.routines where routine_schema not in ('pg_catalog','information_schema')) as functions,
        (select count(*)::int from information_schema.triggers where trigger_schema not in ('pg_catalog','information_schema')) as triggers,
        (select count(*)::int from pg_extension) as extensions,
        (select count(*)::int from pg_indexes where schemaname not in ('pg_catalog','information_schema')) as indexes,
        (select count(*)::int from pg_roles) as roles,
        (select count(*)::int from pg_policies) as policies
    `);

    res.json({
      success: true,
      summary: result.rows[0]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/section/:slug", async (req, res) => {
  try {
    const db = resolveDb();
    const slug = String(req.params.slug || "").trim().toLowerCase();

    if (slug === "schema-visualizer") {
      const q = await safeQuery(db, `
        select
          c.table_schema,
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.ordinal_position
        from information_schema.columns c
        where c.table_schema not in ('pg_catalog','information_schema')
        order by c.table_schema, c.table_name, c.ordinal_position
        limit 500
      `);

      return res.json(sectionResponse(
        slug,
        "Schema Visualizer",
        "Live schema, table, and column inventory used to build the visual database diagram.",
        ["table_schema", "table_name", "column_name", "data_type", "is_nullable"],
        q
      ));
    }

    if (slug === "tables") {
      const q = await safeQuery(db, `
        select
          t.table_schema,
          t.table_name,
          t.table_type,
          coalesce(s.n_live_tup, 0)::bigint as estimated_rows,
          coalesce(s.n_dead_tup, 0)::bigint as dead_rows,
          pg_size_pretty(pg_total_relation_size(format('%I.%I', t.table_schema, t.table_name)::regclass)) as total_size
        from information_schema.tables t
        left join pg_stat_user_tables s
          on s.schemaname = t.table_schema
         and s.relname = t.table_name
        where t.table_schema not in ('pg_catalog','information_schema')
        order by pg_total_relation_size(format('%I.%I', t.table_schema, t.table_name)::regclass) desc nulls last, t.table_schema, t.table_name
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Tables",
        "Live table catalog with estimated row counts, dead rows, and storage size.",
        ["table_schema", "table_name", "table_type", "estimated_rows", "dead_rows", "total_size"],
        q
      ));
    }

    if (slug === "functions") {
      const q = await safeQuery(db, `
        select
          routine_schema,
          routine_name,
          routine_type,
          data_type,
          security_type,
          is_deterministic
        from information_schema.routines
        where routine_schema not in ('pg_catalog','information_schema')
        order by routine_schema, routine_name
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Functions",
        "Postgres function and routine registry.",
        ["routine_schema", "routine_name", "routine_type", "data_type", "security_type"],
        q
      ));
    }

    if (slug === "triggers") {
      const q = await safeQuery(db, `
        select distinct
          trigger_schema,
          trigger_name,
          event_object_schema,
          event_object_table,
          event_manipulation,
          action_timing
        from information_schema.triggers
        where trigger_schema not in ('pg_catalog','information_schema')
        order by trigger_schema, event_object_table, trigger_name
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Triggers",
        "Trigger registry and event hook inventory.",
        ["trigger_schema", "trigger_name", "event_object_table", "event_manipulation", "action_timing"],
        q
      ));
    }

    if (slug === "enumerated-types") {
      const q = await safeQuery(db, `
        select
          n.nspname as schema_name,
          t.typname as enum_name,
          string_agg(e.enumlabel, ', ' order by e.enumsortorder) as values
        from pg_type t
        join pg_enum e on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname not in ('pg_catalog','information_schema')
        group by n.nspname, t.typname
        order by n.nspname, t.typname
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Enumerated Types",
        "Postgres enum catalog.",
        ["schema_name", "enum_name", "values"],
        q
      ));
    }

    if (slug === "extensions") {
      const q = await safeQuery(db, `
        select
          e.extname as extension_name,
          e.extversion as version,
          n.nspname as schema_name,
          d.description
        from pg_extension e
        left join pg_namespace n on n.oid = e.extnamespace
        left join pg_description d on d.objoid = e.oid
        order by e.extname
      `);

      return res.json(sectionResponse(
        slug,
        "Extensions",
        "Installed Postgres extensions.",
        ["extension_name", "version", "schema_name", "description"],
        q
      ));
    }

    if (slug === "indexes") {
      const q = await safeQuery(db, `
        select
          schemaname,
          tablename,
          indexname,
          indexdef
        from pg_indexes
        where schemaname not in ('pg_catalog','information_schema')
        order by schemaname, tablename, indexname
        limit 300
      `);

      return res.json(sectionResponse(
        slug,
        "Indexes",
        "Index inventory and definitions.",
        ["schemaname", "tablename", "indexname", "indexdef"],
        q
      ));
    }

    if (slug === "publications") {
      const q = await safeQuery(db, `
        select
          pubname,
          pubowner::regrole::text as owner,
          puballtables,
          pubinsert,
          pubupdate,
          pubdelete,
          pubtruncate
        from pg_publication
        order by pubname
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Publications",
        "Logical replication publication registry.",
        ["pubname", "owner", "puballtables", "pubinsert", "pubupdate", "pubdelete", "pubtruncate"],
        q
      ));
    }

    if (slug === "roles") {
      const q = await safeQuery(db, `
        select
          rolname,
          rolsuper,
          rolinherit,
          rolcreaterole,
          rolcreatedb,
          rolcanlogin,
          rolreplication,
          rolconnlimit
        from pg_roles
        order by rolname
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Roles",
        "Database roles and login capabilities.",
        ["rolname", "rolsuper", "rolinherit", "rolcreaterole", "rolcreatedb", "rolcanlogin", "rolreplication", "rolconnlimit"],
        q
      ));
    }

    if (slug === "policies") {
      const q = await safeQuery(db, `
        select
          schemaname,
          tablename,
          policyname,
          permissive,
          roles,
          cmd,
          qual,
          with_check
        from pg_policies
        order by schemaname, tablename, policyname
        limit 300
      `);

      return res.json(sectionResponse(
        slug,
        "Policies",
        "Row level security policy registry.",
        ["schemaname", "tablename", "policyname", "permissive", "roles", "cmd", "qual"],
        q
      ));
    }

    if (slug === "settings") {
      const q = await safeQuery(db, `
        select
          name,
          setting,
          unit,
          category,
          short_desc
        from pg_settings
        where name in (
          'max_connections',
          'shared_buffers',
          'work_mem',
          'maintenance_work_mem',
          'statement_timeout',
          'idle_in_transaction_session_timeout',
          'log_min_duration_statement',
          'timezone',
          'server_version',
          'wal_level'
        )
        order by name
      `);

      return res.json(sectionResponse(
        slug,
        "Settings",
        "Important database runtime settings.",
        ["name", "setting", "unit", "category", "short_desc"],
        q
      ));
    }

    if (slug === "replication") {
      const q = await safeQuery(db, `
        select
          pid,
          usename,
          application_name,
          client_addr::text as client_addr,
          state,
          sync_state,
          write_lag::text as write_lag,
          flush_lag::text as flush_lag,
          replay_lag::text as replay_lag
        from pg_stat_replication
        order by application_name
        limit 100
      `);

      return res.json(sectionResponse(
        slug,
        "Replication",
        "Current replication client status.",
        ["pid", "usename", "application_name", "client_addr", "state", "sync_state", "write_lag", "flush_lag", "replay_lag"],
        q
      ));
    }

    if (slug === "backups") {
      let q;

      if (await tableExists(db, "public.backend_backup_records")) {
        q = await safeQuery(db, `
          select *
          from backend_backup_records
          order by created_at desc
          limit 100
        `);
      } else if (await tableExists(db, "public.backend_backups")) {
        q = await safeQuery(db, `
          select *
          from backend_backups
          order by created_at desc
          limit 100
        `);
      } else {
        q = {
          ok: true,
          rows: [
            {
              status: "not_connected",
              message: "No backend backup table was found yet. The Backups tab can be wired to the existing backup scripts next."
            }
          ]
        };
      }

      return res.json(sectionResponse(
        slug,
        "Backups",
        "Backup records and restore points when backup tables are available.",
        q.rows && q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"],
        q
      ));
    }

    if (slug === "migrations") {
      let q;

      if (await tableExists(db, "public.schema_migrations")) {
        q = await safeQuery(db, `
          select *
          from schema_migrations
          order by 1 desc
          limit 200
        `);
      } else if (await tableExists(db, "public.knex_migrations")) {
        q = await safeQuery(db, `
          select *
          from knex_migrations
          order by id desc
          limit 200
        `);
      } else {
        q = await safeQuery(db, `
          select
            'migration_files' as source,
            'Use repository migrations directory for current migration timeline.' as message
        `);
      }

      return res.json(sectionResponse(
        slug,
        "Migrations",
        "Migration records when a migration tracking table is available.",
        q.rows && q.rows[0] ? Object.keys(q.rows[0]) : ["source", "message"],
        q
      ));
    }

    if (slug === "wrappers") {
      const q = await safeQuery(db, `
        select
          foreign_data_wrapper_catalog,
          foreign_data_wrapper_name,
          authorization_identifier,
          library_name
        from information_schema.foreign_data_wrappers
        order by foreign_data_wrapper_name
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Wrappers",
        "Foreign data wrapper inventory.",
        ["foreign_data_wrapper_catalog", "foreign_data_wrapper_name", "authorization_identifier", "library_name"],
        q
      ));
    }

    if (slug === "database-webhooks") {
      let q;

      if (await tableExists(db, "public.backend_webhooks")) {
        q = await safeQuery(db, `
          select id, name, url, status, created_at, updated_at
          from backend_webhooks
          order by created_at desc
          limit 100
        `);
      } else if (await tableExists(db, "public.backend_webhook_deliveries")) {
        q = await safeQuery(db, `
          select *
          from backend_webhook_deliveries
          order by created_at desc
          limit 100
        `);
      } else {
        q = {
          ok: true,
          rows: [
            {
              status: "not_connected",
              message: "No database webhook table was found yet."
            }
          ]
        };
      }

      return res.json(sectionResponse(
        slug,
        "Database Webhooks",
        "Database event webhook records and delivery status.",
        q.rows && q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"],
        q
      ));
    }

    if (slug === "security-advisor") {
      const q = await safeQuery(db, `
        with table_security as (
          select
            n.nspname as schema_name,
            c.relname as table_name,
            c.relrowsecurity as rls_enabled,
            c.relforcerowsecurity as rls_forced
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'r'
            and n.nspname not in ('pg_catalog','information_schema')
        )
        select
          schema_name,
          table_name,
          case
            when rls_enabled then 'ok'
            else 'review'
          end as status,
          rls_enabled,
          rls_forced,
          case
            when rls_enabled then 'Row level security is enabled.'
            else 'Consider enabling RLS before exposing this table publicly.'
          end as recommendation
        from table_security
        order by status desc, schema_name, table_name
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Security Advisor",
        "Database security recommendations based on table RLS status.",
        ["schema_name", "table_name", "status", "rls_enabled", "rls_forced", "recommendation"],
        q
      ));
    }

    if (slug === "performance-advisor") {
      const q = await safeQuery(db, `
        select
          schemaname,
          relname as table_name,
          seq_scan,
          idx_scan,
          n_live_tup,
          n_dead_tup,
          case
            when n_dead_tup > n_live_tup and n_dead_tup > 1000 then 'vacuum_review'
            when seq_scan > idx_scan and seq_scan > 100 then 'index_review'
            else 'ok'
          end as recommendation
        from pg_stat_user_tables
        order by n_dead_tup desc, seq_scan desc
        limit 250
      `);

      return res.json(sectionResponse(
        slug,
        "Performance Advisor",
        "Table scan, index scan, and dead row recommendations.",
        ["schemaname", "table_name", "seq_scan", "idx_scan", "n_live_tup", "n_dead_tup", "recommendation"],
        q
      ));
    }

    if (slug === "query-performance") {
      const q = await safeQuery(db, `
        select
          'pg_stat_statements' as source,
          case
            when exists (select 1 from pg_extension where extname = 'pg_stat_statements')
              then 'enabled'
            else 'not_enabled'
          end as status,
          'Enable pg_stat_statements to capture slow query and index insight data.' as recommendation
      `);

      return res.json(sectionResponse(
        slug,
        "Query Performance",
        "Slow query visibility and extension readiness.",
        ["source", "status", "recommendation"],
        q
      ));
    }

    const err = new Error("Unknown database management section: " + slug);
    err.statusCode = 404;
    throw err;
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
