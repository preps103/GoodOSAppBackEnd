const express = require("express");

const router = express.Router();

/* GOODOS AUTH CONSOLE V99 ROUTER URL NORMALIZER */
const goodosAuthConsoleSectionMapV99Router = {
  users: 'users',
  user: 'users',
  apps: 'oauth-apps',
  oauthapps: 'oauth-apps',
  'oauth-apps': 'oauth-apps',
  oauthApps: 'oauth-apps',
  templates: 'email-templates',
  emailtemplates: 'email-templates',
  'email-templates': 'email-templates',
  emailTemplates: 'email-templates',
  policies: 'policies',
  providers: 'providers',
  passkeys: 'passkeys',
  sessions: 'sessions',
  session: 'sessions',
  mfa: 'mfa',
  ratelimits: 'rate-limits',
  'rate-limits': 'rate-limits',
  rateLimits: 'rate-limits',
  hooks: 'hooks',
  auditlogs: 'audit-logs',
  'audit-logs': 'audit-logs',
  auditLogs: 'audit-logs',
  logs: 'audit-logs',
  performance: 'performance',
  summary: 'summary'
};

const goodosAuthConsoleKnownSectionsV99Router = new Set([
  'users',
  'oauth-apps',
  'email-templates',
  'policies',
  'providers',
  'passkeys',
  'sessions',
  'mfa',
  'rate-limits',
  'hooks',
  'audit-logs',
  'performance'
]);

function goodosCleanAuthConsoleKeyV99Router(value) {
  let key = String(value || '')
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[+"'\`]/g, '')
    .replace(/[.)\];,]+$/g, '')
    .replace(/^\/+|\/+$/g, '');

  return (
    goodosAuthConsoleSectionMapV99Router[key] ||
    goodosAuthConsoleSectionMapV99Router[key.toLowerCase()] ||
    key.toLowerCase()
  );
}

router.use(function goodosAuthConsoleRouterNormalizerV99(req, res, next) {
  try {
    const originalUrl = String(req.url || '/');
    const queryIndex = originalUrl.indexOf('?');
    let pathname = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';

    try {
      pathname = decodeURI(pathname);
    } catch (_) {}

    pathname = pathname
      .replace(/<[^>]*>/g, '')
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/[+"'\`]/g, '')
      .replace(/[.)\];,]+$/g, '')
      .replace(/\/sections\//i, '/section/');

    const parts = pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      req.url = '/summary' + query;
      return next();
    }

    const first = goodosCleanAuthConsoleKeyV99Router(parts[0]);
    const second = goodosCleanAuthConsoleKeyV99Router(parts[1] || '');

    if (first === 'summary') {
      req.url = '/summary' + query;
      return next();
    }

    if (first === 'section' || first === 'sections') {
      if (goodosAuthConsoleKnownSectionsV99Router.has(second)) {
        req.url = '/section/' + second + query;
        return next();
      }
    }

    if (goodosAuthConsoleKnownSectionsV99Router.has(first)) {
      req.url = '/section/' + first + query;
      return next();
    }

    return next();
  } catch (err) {
    return next();
  }
});
/* END GOODOS AUTH CONSOLE V99 ROUTER URL NORMALIZER */



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
    error: err.message || "Authentication console request failed."
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
      service: "GoodOS Authentication Console",
      database: result.rows[0]
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/summary", async (req, res) => {
  try {
    const db = resolveDb();

    const usersExists = await tableExists(db, "public.users");
    const sessionsExists = await tableExists(db, "public.sessions");
    const apiKeysExists = await tableExists(db, "public.api_keys");
    const rolesExists = await tableExists(db, "public.backend_roles");
    const permissionsExists = await tableExists(db, "public.backend_permissions");
    const userRolesExists = await tableExists(db, "public.backend_user_roles");
    const mfaExists = await tableExists(db, "public.backend_mfa_factors");
    const resetExists = await tableExists(db, "public.backend_password_reset_tokens");
    const authAuditExists = await tableExists(db, "public.backend_auth_audit_events");

    const result = await db.query(`
      select
        ${usersExists ? "(select count(*)::int from users)" : "0"} as users,
        ${sessionsExists ? "(select count(*)::int from sessions where coalesce(expires_at, now() + interval '1 day') > now())" : "0"} as active_sessions,
        ${apiKeysExists ? "(select count(*)::int from api_keys where coalesce(status, 'active') = 'active')" : "0"} as api_keys,
        ${rolesExists ? "(select count(*)::int from backend_roles)" : "0"} as roles,
        ${permissionsExists ? "(select count(*)::int from backend_permissions)" : "0"} as permissions,
        ${userRolesExists ? "(select count(*)::int from backend_user_roles)" : "0"} as user_roles,
        ${mfaExists ? "(select count(*)::int from backend_mfa_factors)" : "0"} as mfa_factors,
        ${resetExists ? "(select count(*)::int from backend_password_reset_tokens)" : "0"} as password_resets,
        ${authAuditExists ? "(select count(*)::int from backend_auth_audit_events)" : "0"} as audit_events
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

    if (slug === "users") {
      const exists = await tableExists(db, "public.users");
      const q = exists
        ? await safeQuery(db, `
          select
            id,
            email,
            name,
            platform_role,
            status,
            email_verified,
            created_at,
            updated_at
          from users
          order by created_at desc nulls last
          limit 200
        `)
        : { ok: true, rows: [{ status: "not_connected", message: "users table was not found." }] };

      return res.json(sectionResponse(slug, "Users", "Live user table and account management records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "oauth-apps") {
      let q;
      if (await tableExists(db, "public.backend_oauth_apps")) {
        q = await safeQuery(db, `select * from backend_oauth_apps order by created_at desc nulls last limit 200`);
      } else if (await tableExists(db, "public.oauth_apps")) {
        q = await safeQuery(db, `select * from oauth_apps order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [{ status: "not_connected", message: "OAuth apps table is not connected yet." }] };
      }

      return res.json(sectionResponse(slug, "OAuth Apps", "OAuth application registry and client configuration records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "emails") {
      let q;
      if (await tableExists(db, "public.backend_email_templates")) {
        q = await safeQuery(db, `select id, name, subject, status, created_at, updated_at from backend_email_templates order by created_at desc nulls last limit 200`);
      } else if (await tableExists(db, "public.backend_notification_templates")) {
        q = await safeQuery(db, `select id, template_key, channel, subject, status, created_at, updated_at from backend_notification_templates order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [{ status: "not_connected", message: "Email templates table is not connected yet." }] };
      }

      return res.json(sectionResponse(slug, "Emails", "Auth email templates and delivery shell records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "policies") {
      let q;
      if (await tableExists(db, "public.backend_policy_rules")) {
        q = await safeQuery(db, `
          select id, name, resource, action, effect, status, priority, created_at, updated_at
          from backend_policy_rules
          where lower(coalesce(resource,'')) like '%auth%'
             or lower(coalesce(action,'')) like '%auth%'
             or lower(coalesce(name,'')) like '%auth%'
          order by priority asc nulls last, created_at desc nulls last
          limit 200
        `);
      } else {
        q = { ok: true, rows: [{ status: "not_connected", message: "Policy rules table is not connected yet." }] };
      }

      return res.json(sectionResponse(slug, "Policies", "Authentication policy rules and access-control records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "sign-in-providers") {
      let q;
      if (await tableExists(db, "public.backend_auth_providers")) {
        q = await safeQuery(db, `select * from backend_auth_providers order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { provider: "email", status: "planned", type: "passwordless / password", notes: "Provider configuration shell." },
          { provider: "google", status: "planned", type: "oauth", notes: "Provider configuration shell." },
          { provider: "github", status: "planned", type: "oauth", notes: "Provider configuration shell." }
        ] };
      }

      return res.json(sectionResponse(slug, "Sign In / Providers", "Identity provider configuration and sign-in method registry.", q.rows[0] ? Object.keys(q.rows[0]) : ["provider", "status", "type", "notes"], q));
    }

    if (slug === "passkeys") {
      let q;
      if (await tableExists(db, "public.backend_passkeys")) {
        q = await safeQuery(db, `select * from backend_passkeys order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [{ status: "planned", message: "Passkey/WebAuthn credential storage is ready for schema connection." }] };
      }

      return res.json(sectionResponse(slug, "Passkeys", "WebAuthn passkey records and credential shell.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "oauth-server") {
      let q;
      if (await tableExists(db, "public.backend_oauth_server_settings")) {
        q = await safeQuery(db, `select * from backend_oauth_server_settings order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { setting: "issuer", value: "https://backend.goodos.app", status: "planned" },
          { setting: "authorization_endpoint", value: "/oauth/authorize", status: "planned" },
          { setting: "token_endpoint", value: "/oauth/token", status: "planned" }
        ] };
      }

      return res.json(sectionResponse(slug, "OAuth Server", "OAuth server settings and endpoint readiness.", q.rows[0] ? Object.keys(q.rows[0]) : ["setting", "value", "status"], q));
    }

    if (slug === "sessions") {
      const exists = await tableExists(db, "public.sessions");
      const q = exists
        ? await safeQuery(db, `
          select
            id,
            user_id,
            created_at,
            expires_at,
            revoked_at,
            case
              when revoked_at is not null then 'revoked'
              when expires_at is not null and expires_at < now() then 'expired'
              else 'active'
            end as status
          from sessions
          order by created_at desc nulls last
          limit 200
        `)
        : { ok: true, rows: [{ status: "not_connected", message: "sessions table was not found." }] };

      return res.json(sectionResponse(slug, "Sessions", "Session state, expiration, and revocation records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "rate-limits") {
      let q;
      if (await tableExists(db, "public.backend_rate_limits")) {
        q = await safeQuery(db, `select * from backend_rate_limits order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { scope: "auth.login", limit: "planned", window: "15 minutes", status: "planned" },
          { scope: "auth.password_reset", limit: "planned", window: "1 hour", status: "planned" }
        ] };
      }

      return res.json(sectionResponse(slug, "Rate Limits", "Auth throttles and abuse protection limits.", q.rows[0] ? Object.keys(q.rows[0]) : ["scope", "limit", "window", "status"], q));
    }

    if (slug === "multi-factor") {
      let q;
      if (await tableExists(db, "public.backend_mfa_factors")) {
        q = await safeQuery(db, `
          select id, user_id, factor_type, status, created_at, updated_at
          from backend_mfa_factors
          order by created_at desc nulls last
          limit 200
        `);
      } else {
        q = { ok: true, rows: [{ status: "not_connected", message: "MFA factor table is not connected yet." }] };
      }

      return res.json(sectionResponse(slug, "Multi-Factor", "MFA factors and enforcement records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "url-configuration") {
      let q;
      if (await tableExists(db, "public.backend_url_configurations")) {
        q = await safeQuery(db, `select * from backend_url_configurations order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { type: "site_url", value: "https://backend.goodos.app", status: "active" },
          { type: "redirect_url", value: "planned", status: "planned" }
        ] };
      }

      return res.json(sectionResponse(slug, "URL Configuration", "Redirect URLs, site URLs, and allowed callback shell.", q.rows[0] ? Object.keys(q.rows[0]) : ["type", "value", "status"], q));
    }

    if (slug === "attack-protection") {
      let q;
      if (await tableExists(db, "public.backend_security_events")) {
        q = await safeQuery(db, `select * from backend_security_events order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { protection: "bot_detection", status: "planned", notes: "Bot and abuse protection shell." },
          { protection: "suspicious_login", status: "planned", notes: "Suspicious login detection shell." }
        ] };
      }

      return res.json(sectionResponse(slug, "Attack Protection", "Bot, abuse, and suspicious authentication protection.", q.rows[0] ? Object.keys(q.rows[0]) : ["protection", "status", "notes"], q));
    }

    if (slug === "auth-hooks") {
      let q;
      if (await tableExists(db, "public.backend_auth_hooks")) {
        q = await safeQuery(db, `select * from backend_auth_hooks order by created_at desc nulls last limit 200`);
      } else {
        q = { ok: true, rows: [
          { hook: "before_user_created", status: "planned", notes: "Auth hook shell." },
          { hook: "after_user_login", status: "planned", notes: "Auth hook shell." }
        ] };
      }

      return res.json(sectionResponse(slug, "Auth Hooks", "Auth webhook and hook registry.", q.rows[0] ? Object.keys(q.rows[0]) : ["hook", "status", "notes"], q));
    }

    if (slug === "audit-logs") {
      let q;
      if (await tableExists(db, "public.backend_auth_audit_events")) {
        q = await safeQuery(db, `select * from backend_auth_audit_events order by created_at desc nulls last limit 200`);
      } else if (await tableExists(db, "public.backend_audit_logs")) {
        q = await safeQuery(db, `
          select *
          from backend_audit_logs
          where lower(coalesce(resource,'')) like '%auth%'
             or lower(coalesce(action,'')) like '%auth%'
          order by created_at desc nulls last
          limit 200
        `);
      } else {
        q = { ok: true, rows: [{ status: "not_connected", message: "Auth audit logs table is not connected yet." }] };
      }

      return res.json(sectionResponse(slug, "Audit Logs", "Authentication audit events and security log records.", q.rows[0] ? Object.keys(q.rows[0]) : ["status", "message"], q));
    }

    if (slug === "performance") {
      const q = await safeQuery(db, `
        select
          'auth_console' as area,
          'reachable' as status,
          now() as checked_at,
          'Authentication console API is responding.' as note
      `);

      return res.json(sectionResponse(slug, "Performance", "Auth performance and readiness checks.", ["area", "status", "checked_at", "note"], q));
    }

    const err = new Error("Unknown authentication console section: " + slug);
    err.statusCode = 404;
    throw err;
  } catch (err) {
    sendError(res, err);
  }
});


/* GOODOS AUTH CONSOLE V98 DIRECT SECTION ALIASES - FIX 404 ROUTE MISMATCH */
const __goodosAuthConsoleV98SectionMap = {
  "users": "users",
  "user": "users",
  "oauth-apps": "oauth-apps",
  "oauthapps": "oauth-apps",
  "oauthApps": "oauth-apps",
  "apps": "oauth-apps",
  "email-templates": "email-templates",
  "emailtemplates": "email-templates",
  "emailTemplates": "email-templates",
  "templates": "email-templates",
  "policies": "policies",
  "policy": "policies",
  "providers": "providers",
  "provider": "providers",
  "passkeys": "passkeys",
  "passkey": "passkeys",
  "sessions": "sessions",
  "session": "sessions",
  "mfa": "mfa",
  "rate-limits": "rate-limits",
  "ratelimits": "rate-limits",
  "rateLimits": "rate-limits",
  "hooks": "hooks",
  "hook": "hooks",
  "audit-logs": "audit-logs",
  "auditlogs": "audit-logs",
  "auditLogs": "audit-logs",
  "logs": "audit-logs",
  "performance": "performance"
};

function __goodosAuthConsoleV98RedirectToSection(req, res, next) {
  try {
    const raw = String(req.params.sectionKey || "")
      .trim()
      .replace(/^\/+/, "")
      .replace(/\.+$/, "");

    const mapped =
      __goodosAuthConsoleV98SectionMap[raw] ||
      __goodosAuthConsoleV98SectionMap[raw.toLowerCase()];

    if (!mapped) return next();

    const query = req.originalUrl.includes("?")
      ? "?" + req.originalUrl.split("?").slice(1).join("?")
      : "";

    return res.redirect(
      307,
      "/api/admin/authentication-console/section/" + encodeURIComponent(mapped) + query
    );
  } catch (err) {
    return next(err);
  }
}

router.get("/sections/:sectionKey", __goodosAuthConsoleV98RedirectToSection);
router.get("/:sectionKey", __goodosAuthConsoleV98RedirectToSection);
/* END GOODOS AUTH CONSOLE V98 DIRECT SECTION ALIASES */

module.exports = router;
