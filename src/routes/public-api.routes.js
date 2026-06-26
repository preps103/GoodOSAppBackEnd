const express = require("express");
const crypto = require("crypto");
const database = require("../config/database");

const router = express.Router();

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

function extractApiKey(req) {
  const headerKey = req.get("X-GoodOS-API-Key");
  if (headerKey) return headerKey.trim();

  const auth = req.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return "";
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return fallback;
}

function hasScope(apiKey, requiredScope) {
  const scopes = normalizeList(apiKey.scopes, []);
  const type = String(apiKey.type || "").toLowerCase();

  if (type === "full_access" || type === "admin" || type === "owner") return true;
  if (scopes.includes("*")) return true;
  if (scopes.includes(requiredScope)) return true;

  const [family] = requiredScope.split(":");
  if (scopes.includes(`${family}:*`)) return true;

  if (requiredScope.startsWith("read:") && scopes.includes("read:*")) return true;
  if (requiredScope.startsWith("write:") && scopes.includes("write:*")) return true;

  return false;
}

function allowedApps(apiKey) {
  return normalizeList(apiKey.allowedAppIds || apiKey.allowed_app_ids, ["*"]);
}

async function apiKeyRequired(req, res, next) {
  try {
    const key = extractApiKey(req);

    if (!key) {
      return res.status(401).json({
        success: false,
        message: "API key required. Use X-GoodOS-API-Key or Authorization: Bearer.",
      });
    }

    const keyHash = hashKey(key);

    const result = await dbQuery(
      `
        SELECT
          id,
          name,
          type,
          key_prefix AS "keyPrefix",
          key_hash AS "keyHash",
          scopes,
          allowed_app_ids AS "allowedAppIds",
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          last_used_at AS "lastUsedAt",
          revoked_at AS "revokedAt"
        FROM backend_api_keys
        WHERE key_hash = $1
        LIMIT 1
      `,
      [keyHash]
    );

    const apiKey = result.rows[0];

    if (!apiKey || apiKey.status !== "active" || apiKey.revokedAt) {
      return res.status(401).json({
        success: false,
        message: "Invalid or revoked API key.",
      });
    }

    await dbQuery(
      `
        UPDATE backend_api_keys
        SET last_used_at = NOW()
        WHERE id = $1
      `,
      [apiKey.id]
    );

    req.goodosApiKey = apiKey;
    return next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "API key validation failed.",
      detail: error.message,
    });
  }
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!hasScope(req.goodosApiKey, scope)) {
      return res.status(403).json({
        success: false,
        message: `API key missing required scope: ${scope}`,
        requiredScope: scope,
        keyScopes: req.goodosApiKey.scopes || [],
      });
    }

    return next();
  };
}

router.get("/health", apiKeyRequired, requireScope("read:health"), async (req, res) => {
  return res.json({
    success: true,
    service: "GoodAppBackEnd Public API",
    status: "ok",
    apiKey: {
      id: req.goodosApiKey.id,
      name: req.goodosApiKey.name,
      type: req.goodosApiKey.type,
      scopes: req.goodosApiKey.scopes || [],
      allowedAppIds: req.goodosApiKey.allowedAppIds || [],
    },
    time: new Date().toISOString(),
  });
});

router.get("/apps", apiKeyRequired, requireScope("read:apps"), async (req, res) => {
  try {
    const appIds = allowedApps(req.goodosApiKey);
    const unrestricted = appIds.includes("*");

    const result = await dbQuery(
      `
        SELECT
          a.id,
          a.name,
          a.domain,
          a.status,
          COUNT(m.user_id)::int AS "memberCount"
        FROM apps a
        LEFT JOIN app_memberships m ON m.app_id = a.id AND m.status = 'active'
        WHERE ($1::boolean = true OR a.id = ANY($2::text[]))
        GROUP BY a.id, a.name, a.domain, a.status
        ORDER BY a.name ASC
      `,
      [unrestricted, appIds]
    );

    return res.json({
      success: true,
      data: {
        apps: result.rows,
        access: {
          unrestricted,
          allowedAppIds: appIds,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load apps.",
      detail: error.message,
    });
  }
});

router.get("/storage/buckets", apiKeyRequired, requireScope("read:storage"), async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        b.id,
        b.name,
        b.visibility,
        b.status,
        b.created_at AS "createdAt",
        COUNT(f.id)::int AS "fileCount",
        COALESCE(SUM(f.size_bytes), 0)::bigint AS "totalBytes"
      FROM backend_storage_buckets b
      LEFT JOIN backend_storage_files f ON f.bucket_id = b.id AND f.status = 'active'
      GROUP BY b.id, b.name, b.visibility, b.status, b.created_at
      ORDER BY b.created_at DESC
    `);

    return res.json({
      success: true,
      data: {
        buckets: result.rows,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load storage buckets.",
      detail: error.message,
    });
  }
});

router.get("/storage/files", apiKeyRequired, requireScope("read:storage"), async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        f.id,
        f.bucket_id AS "bucketId",
        b.name AS "bucketName",
        f.filename,
        f.original_filename AS "originalFilename",
        f.mime_type AS "mimeType",
        f.size_bytes AS "sizeBytes",
        f.status,
        f.created_at AS "createdAt"
      FROM backend_storage_files f
      JOIN backend_storage_buckets b ON b.id = f.bucket_id
      ORDER BY f.created_at DESC
      LIMIT 500
    `);

    return res.json({
      success: true,
      data: {
        files: result.rows,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load storage files.",
      detail: error.message,
    });
  }
});

module.exports = router;
