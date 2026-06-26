const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const database = require("../config/database");

const router = express.Router();

function ok(res, data = {}) {
  return res.json({ success: true, data });
}

function fail(res, message, status = 500, detail = null) {
  return res.status(status).json({ success: false, message, detail });
}

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function currentUserId(req) {
  return req.user?.id || req.auth?.user?.id || req.session?.user?.id || null;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function safeCount(tableName, whereClause = "", params = []) {
  try {
    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${tableName} ${whereClause}`, params);
    return result.rows[0]?.count || 0;
  } catch {
    return 0;
  }
}

function formatUptime(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total} sec`;
}

async function getTables() {
  const result = await dbQuery(`
    SELECT table_name AS "tableName"
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name ASC
  `);

  const tables = [];

  for (const row of result.rows) {
    tables.push({
      tableName: row.tableName,
      rowCount: await safeCount(row.tableName),
      status: "available",
    });
  }

  return tables;
}

async function getUsers() {
  const result = await dbQuery(`
    SELECT
      id,
      email,
      display_name AS "displayName",
      platform_role AS "platformRole",
      status,
      email_verified AS "emailVerified",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM users
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getApps() {
  const result = await dbQuery(`
    SELECT
      a.id,
      a.name,
      a.domain,
      a.status,
      COUNT(m.user_id)::int AS "memberCount"
    FROM apps a
    LEFT JOIN app_memberships m ON m.app_id = a.id AND m.status = 'active'
    GROUP BY a.id, a.name, a.domain, a.status
    ORDER BY a.name ASC
  `);

  return result.rows;
}

async function getMemberships() {
  const result = await dbQuery(`
    SELECT
      u.email,
      u.display_name AS "displayName",
      m.user_id AS "userId",
      m.app_id AS "appId",
      a.name AS "appName",
      a.domain,
      m.role,
      m.status
    FROM app_memberships m
    JOIN users u ON u.id = m.user_id
    JOIN apps a ON a.id = m.app_id
    ORDER BY a.name ASC, u.email ASC
    LIMIT 500
  `);

  return result.rows;
}

async function getApiKeys() {
  const result = await dbQuery(`
    SELECT
      id,
      name,
      type,
      key_prefix AS "keyPrefix",
      status,
      created_at AS "createdAt",
      last_used_at AS "lastUsedAt",
      revoked_at AS "revokedAt"
    FROM backend_api_keys
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getWebhooks() {
  const result = await dbQuery(`
    SELECT
      id,
      name,
      url,
      events,
      status,
      created_at AS "createdAt",
      last_triggered_at AS "lastTriggeredAt"
    FROM backend_webhooks
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getBuckets() {
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
    LEFT JOIN backend_storage_files f ON f.bucket_id = b.id
    GROUP BY b.id, b.name, b.visibility, b.status, b.created_at
    ORDER BY b.created_at DESC
  `);

  return result.rows;
}

async function getEvents() {
  const result = await dbQuery(`
    SELECT
      id,
      event_type AS "eventType",
      source,
      message,
      payload,
      created_at AS "createdAt"
    FROM backend_events
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getOverview() {
  const [
    users,
    apps,
    activeApps,
    memberships,
    activeMemberships,
    sessions,
    apiKeys,
    webhooks,
    buckets,
    events,
    tables,
    dbTime,
  ] = await Promise.all([
    safeCount("users"),
    safeCount("apps"),
    safeCount("apps", "WHERE status = $1", ["active"]),
    safeCount("app_memberships"),
    safeCount("app_memberships", "WHERE status = $1", ["active"]),
    safeCount("sessions"),
    safeCount("backend_api_keys", "WHERE status = $1", ["active"]),
    safeCount("backend_webhooks", "WHERE status = $1", ["active"]),
    safeCount("backend_storage_buckets", "WHERE status = $1", ["active"]),
    safeCount("backend_events"),
    getTables(),
    dbQuery("SELECT NOW() AS now"),
  ]);

  const memory = process.memoryUsage();

  return {
    service: "GoodAppBackEnd",
    environment: process.env.NODE_ENV || "production",
    version: process.env.VERSION || "1.0.0",
    status: "operational",
    database: {
      status: "connected",
      time: dbTime.rows[0]?.now,
    },
    stats: {
      users,
      apps,
      activeApps,
      memberships,
      activeMemberships,
      sessions,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
      tables: tables.length,
    },
    runtime: {
      uptimeSeconds: Math.floor(process.uptime()),
      uptimeFormatted: formatUptime(process.uptime()),
      memory,
      memoryMb: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      },
      node: process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function tailFile(filePath, maxLines = 80) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function getPm2Logs() {
  const candidates = new Set();

  const addCandidate = (filePath) => {
    if (!filePath) return;
    candidates.add(filePath);
  };

  addCandidate(process.env.pm_out_log_path);
  addCandidate(process.env.pm_err_log_path);

  const knownFiles = [
    "/root/.pm2/logs/goodapp-backend-out.log",
    "/root/.pm2/logs/goodapp-backend-error.log",
    "/root/.pm2/logs/goodapp-backend-out-19.log",
    "/root/.pm2/logs/goodapp-backend-error-19.log",
    "/home/mgoodlo3/.pm2/logs/goodapp-backend-out.log",
    "/home/mgoodlo3/.pm2/logs/goodapp-backend-error.log",
  ];

  knownFiles.forEach(addCandidate);

  const scanDirs = [
    "/root/.pm2/logs",
    "/home/mgoodlo3/.pm2/logs",
    process.env.HOME ? path.join(process.env.HOME, ".pm2/logs") : null,
  ].filter(Boolean);

  for (const dir of scanDirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      for (const file of fs.readdirSync(dir)) {
        if (
          file.toLowerCase().includes("goodapp") ||
          file.toLowerCase().includes("backend")
        ) {
          addCandidate(path.join(dir, file));
        }
      }
    } catch {
      // Ignore directories we cannot read.
    }
  }

  const logs = Array.from(candidates)
    .filter((filePath) => {
      try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .map((filePath) => {
      const stat = fs.statSync(filePath);

      return {
        file: path.basename(filePath),
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime,
        lines: tailFile(filePath, 160),
      };
    })
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));

  if (logs.length) return logs;

  return [
    {
      file: "pm2-log-access",
      path: "not-found",
      size: 0,
      modifiedAt: new Date(),
      lines: [
        "No PM2 log files were readable from the backend process.",
        "The backend is online, but the console could not access /root/.pm2/logs or /home/mgoodlo3/.pm2/logs.",
        "This does not affect API/auth/database operation."
      ],
    },
  ];
}

function getBackups() {
  const backupDir = path.join(process.cwd(), "backups");

  try {
    return fs.readdirSync(backupDir).map((name) => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);

      return {
        name,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        modifiedAt: stat.mtime,
      };
    }).sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  } catch {
    return [];
  }
}

function getSecuritySummary() {
  return {
    cors: {
      cookieCredentials: true,
      allowedDomain: ".goodos.app",
      sameSite: process.env.AUTH_COOKIE_SAMESITE || "lax",
      secureCookie: process.env.AUTH_COOKIE_SECURE || "true",
    },
    auth: {
      cookieName: process.env.AUTH_COOKIE_NAME || "goodos_session",
      sessionDays: process.env.SESSION_DAYS || "7",
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },
    headers: {
      helmet: true,
      hsts: true,
      csp: true,
    },
  };
}

async function createEvent(eventType, message, payload = {}) {
  try {
    await dbQuery(
      `
        INSERT INTO backend_events (id, event_type, source, message, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        randomId("evt"),
        eventType,
        "goodapp-backend",
        message,
        JSON.stringify(payload),
      ]
    );
  } catch {
    // Do not block main action if event logging fails.
  }
}


function hashStorageToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function getStorageFiles() {
  const result = await dbQuery(`
    SELECT
      f.id,
      f.bucket_id AS "bucketId",
      b.name AS "bucketName",
      f.filename,
      f.original_filename AS "originalFilename",
      f.mime_type AS "mimeType",
      f.size_bytes AS "sizeBytes",
      f.storage_path AS "storagePath",
      f.status,
      f.created_at AS "createdAt",
      f.updated_at AS "updatedAt"
    FROM backend_storage_files f
    JOIN backend_storage_buckets b ON b.id = f.bucket_id
    ORDER BY f.created_at DESC
    LIMIT 500
  `);

  return result.rows;
}

async function getStorageSignedUrls() {
  const result = await dbQuery(`
    SELECT
      s.id,
      s.file_id AS "fileId",
      f.filename,
      f.original_filename AS "originalFilename",
      s.status,
      s.expires_at AS "expiresAt",
      s.max_downloads AS "maxDownloads",
      s.download_count AS "downloadCount",
      s.created_at AS "createdAt",
      s.last_used_at AS "lastUsedAt"
    FROM backend_storage_signed_urls s
    JOIN backend_storage_files f ON f.id = s.file_id
    ORDER BY s.created_at DESC
    LIMIT 500
  `);

  return result.rows;
}


const storageRoot = path.join(process.cwd(), "storage");
const storageBucketRoot = path.join(storageRoot, "buckets");
const storageTmpRoot = path.join(storageRoot, "tmp");

fs.mkdirSync(storageBucketRoot, { recursive: true });
fs.mkdirSync(storageTmpRoot, { recursive: true });

const upload = multer({
  dest: storageTmpRoot,
  limits: {
    fileSize: Number(process.env.STORAGE_MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
  },
});

function safeStorageName(value, fallback = "file") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_");

  return cleaned || fallback;
}

router.use(authRequired);

router.get("/overview", async (req, res) => {
  try {
    return ok(res, await getOverview());
  } catch (error) {
    return fail(res, "Failed to load admin overview", 500, error.message);
  }
});

router.get("/users", async (req, res) => {
  try {
    const webhookConsolePayload = await getWebhookConsolePayloadDirect();
    webhooks = webhookConsolePayload.webhooks;
    webhookDeliveries = webhookConsolePayload.webhookDeliveries;

    return ok(res, { users: await getUsers() });
  } catch (error) {
    return fail(res, "Failed to load users", 500, error.message);
  }
});

router.get("/apps", async (req, res) => {
  try {
    return ok(res, { apps: await getApps() });
  } catch (error) {
    return fail(res, "Failed to load apps", 500, error.message);
  }
});

router.get("/memberships", async (req, res) => {
  try {
    return ok(res, { memberships: await getMemberships() });
  } catch (error) {
    return fail(res, "Failed to load memberships", 500, error.message);
  }
});

router.get("/tables", async (req, res) => {
  try {
    return ok(res, { tables: await getTables() });
  } catch (error) {
    return fail(res, "Failed to load database tables", 500, error.message);
  }
});

router.get("/api-keys", async (req, res) => {
  try {
    return ok(res, { apiKeys: await getApiKeys() });
  } catch (error) {
    return fail(res, "Failed to load API keys", 500, error.message);
  }
});

router.post("/api-keys", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "read_only").trim();

    if (!name) return fail(res, "API key name is required", 400);

    const id = randomId("key");
    const secret = `gak_${type === "full_access" ? "live" : "read"}_${crypto.randomBytes(24).toString("hex")}`;
    const keyPrefix = secret.slice(0, 18);
    const keyHash = hashSecret(secret);

    await dbQuery(
      `
        INSERT INTO backend_api_keys (id, name, type, key_prefix, key_hash, status, created_by)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
      `,
      [id, name, type, keyPrefix, keyHash, currentUserId(req)]
    );

    await createEvent("api_key.created", `API key created: ${name}`, { id, name, type });

    return ok(res, {
      apiKey: {
        id,
        name,
        type,
        keyPrefix,
        status: "active",
      },
      secret,
      warning: "Copy this secret now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create API key", 500, error.message);
  }
});

router.post("/api-keys/:id/revoke", async (req, res) => {
  try {
    await dbQuery(
      `
        UPDATE backend_api_keys
        SET status = 'revoked', revoked_at = NOW()
        WHERE id = $1
      `,
      [req.params.id]
    );

    await createEvent("api_key.revoked", `API key revoked: ${req.params.id}`, { id: req.params.id });

    return ok(res, { revoked: true });
  } catch (error) {
    return fail(res, "Failed to revoke API key", 500, error.message);
  }
});

router.get("/webhooks", async (req, res) => {
  try {
    return ok(res, { webhooks: await getWebhooks() });
  } catch (error) {
    return fail(res, "Failed to load webhooks", 500, error.message);
  }
});

router.post("/webhooks", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    const events = Array.isArray(req.body?.events) && req.body.events.length ? req.body.events : ["*"];

    if (!name) return fail(res, "Webhook name is required", 400);
    if (!/^https?:\/\//i.test(url)) return fail(res, "Valid webhook URL is required", 400);

    const id = randomId("wh");
    const secret = `whsec_${crypto.randomBytes(18).toString("hex")}`;

    await dbQuery(
      `
        INSERT INTO backend_webhooks (id, name, url, events, secret, status, created_by)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
      `,
      [id, name, url, events, secret, currentUserId(req)]
    );

    await createEvent("webhook.created", `Webhook created: ${name}`, { id, name, url });

    return ok(res, {
      webhook: {
        id,
        name,
        url,
        events,
        status: "active",
      },
      secret,
    });
  } catch (error) {
    return fail(res, "Failed to create webhook", 500, error.message);
  }
});

router.post("/webhooks/:id/disable", async (req, res) => {
  try {
    await dbQuery(
      `
        UPDATE backend_webhooks
        SET status = 'disabled'
        WHERE id = $1
      `,
      [req.params.id]
    );

    await createEvent("webhook.disabled", `Webhook disabled: ${req.params.id}`, { id: req.params.id });

    return ok(res, { disabled: true });
  } catch (error) {
    return fail(res, "Failed to disable webhook", 500, error.message);
  }
});

router.get("/storage/buckets", async (req, res) => {
  try {
    return ok(res, { buckets: await getBuckets() });
  } catch (error) {
    return fail(res, "Failed to load storage buckets", 500, error.message);
  }
});

router.post("/storage/buckets", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const visibility = String(req.body?.visibility || "private").trim();

    if (!name) return fail(res, "Bucket name is required", 400);

    const id = randomId("bucket");

    await dbQuery(
      `
        INSERT INTO backend_storage_buckets (id, name, visibility, status, created_by)
        VALUES ($1, $2, $3, 'active', $4)
      `,
      [id, name, visibility, currentUserId(req)]
    );

    await createEvent("storage.bucket_created", `Storage bucket created: ${name}`, { id, name, visibility });

    return ok(res, {
      bucket: {
        id,
        name,
        visibility,
        status: "active",
      },
    });
  } catch (error) {
    return fail(res, "Failed to create storage bucket", 500, error.message);
  }
});



router.post("/storage/buckets/:bucketId/files", upload.single("file"), async (req, res) => {
  try {
    const bucketId = String(req.params.bucketId || "").trim();

    const bucketResult = await dbQuery(
      `
        SELECT id, name, status
        FROM backend_storage_buckets
        WHERE id = $1
        LIMIT 1
      `,
      [bucketId]
    );

    const bucket = bucketResult.rows[0];

    if (!bucket) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return fail(res, "Bucket not found", 404);
    }

    if (bucket.status !== "active") {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return fail(res, "Bucket is not active", 400);
    }

    if (!req.file) {
      return fail(res, "No file uploaded", 400);
    }

    const bucketFolderName = safeStorageName(bucket.name, "bucket");
    const bucketDir = path.join(storageBucketRoot, bucketFolderName);
    fs.mkdirSync(bucketDir, { recursive: true });

    const fileId = `file_${crypto.randomUUID().replace(/-/g, "")}`;
    const originalFilename = safeStorageName(req.file.originalname, "upload.bin");
    const storedFilename = `${fileId}_${originalFilename}`;
    const finalPath = path.join(bucketDir, storedFilename);

    fs.renameSync(req.file.path, finalPath);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    await dbQuery(
      `
        INSERT INTO backend_storage_files (
          id,
          bucket_id,
          filename,
          original_filename,
          mime_type,
          size_bytes,
          storage_path,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
      `,
      [
        fileId,
        bucket.id,
        storedFilename,
        originalFilename,
        req.file.mimetype || "application/octet-stream",
        req.file.size || 0,
        finalPath,
        createdBy,
      ]
    );

    if (typeof createEvent === "function") {
      await createEvent("storage.file_uploaded", `File uploaded: ${originalFilename}`, {
        fileId,
        bucketId: bucket.id,
        bucketName: bucket.name,
        sizeBytes: req.file.size || 0,
      });
    }

    return ok(res, {
      file: {
        id: fileId,
        bucketId: bucket.id,
        bucketName: bucket.name,
        filename: storedFilename,
        originalFilename,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeBytes: req.file.size || 0,
        status: "active",
      },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    return fail(res, "Failed to upload file", 500, error.message);
  }
});

router.get("/storage/files", async (req, res) => {
  try {
    return ok(res, { files: await getStorageFiles() });
  } catch (error) {
    return fail(res, "Failed to load storage files", 500, error.message);
  }
});

router.get("/storage/signed-urls", async (req, res) => {
  try {
    return ok(res, { signedUrls: await getStorageSignedUrls() });
  } catch (error) {
    return fail(res, "Failed to load signed URLs", 500, error.message);
  }
});

router.post("/storage/files/:fileId/signed-url", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    const expiresMinutes = Math.max(1, Math.min(10080, Number(req.body?.expiresMinutes || 60)));
    const maxDownloads = Math.max(1, Math.min(1000, Number(req.body?.maxDownloads || 1)));

    const fileResult = await dbQuery(
      `
        SELECT
          id,
          filename,
          original_filename AS "originalFilename",
          status
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = fileResult.rows[0];

    if (!file) return fail(res, "File not found", 404);
    if (file.status !== "active") return fail(res, "File is not active", 400);

    const id = `surl_${crypto.randomUUID().replace(/-/g, "")}`;
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashStorageToken(token);
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    await dbQuery(
      `
        INSERT INTO backend_storage_signed_urls (
          id,
          file_id,
          token_hash,
          status,
          expires_at,
          max_downloads,
          created_by
        )
        VALUES ($1, $2, $3, 'active', $4, $5, $6)
      `,
      [id, file.id, tokenHash, expiresAt, maxDownloads, createdBy]
    );

    if (typeof createEvent === "function") {
      await createEvent("storage.signed_url_created", `Signed URL created for: ${file.originalFilename || file.filename}`, {
        signedUrlId: id,
        fileId: file.id,
        expiresAt,
        maxDownloads,
      });
    }

    return ok(res, {
      signedUrl: {
        id,
        fileId: file.id,
        url: `https://backend.goodos.app/storage/signed/${token}`,
        expiresAt,
        maxDownloads,
        status: "active",
      },
      warning: "Anyone with this URL can download the file until it expires or reaches its download limit.",
    });
  } catch (error) {
    return fail(res, "Failed to create signed URL", 500, error.message);
  }
});

router.get("/events", async (req, res) => {
  try {
    return ok(res, { events: await getEvents() });
  } catch (error) {
    return fail(res, "Failed to load backend events", 500, error.message);
  }
});

router.get("/logs", async (req, res) => {
  try {
    return ok(res, { logs: getPm2Logs() });
  } catch (error) {
    return fail(res, "Failed to load logs", 500, error.message);
  }
});

router.get("/backups", async (req, res) => {
  try {
    return ok(res, { backups: getBackups() });
  } catch (error) {
    return fail(res, "Failed to load backups", 500, error.message);
  }
});

router.get("/security", async (req, res) => {
  try {
    return ok(res, getSecuritySummary());
  } catch (error) {
    return fail(res, "Failed to load security summary", 500, error.message);
  }
});

router.get("/health", async (req, res) => {
  try {
    const dbTime = await dbQuery("SELECT NOW() AS now");
    return ok(res, {
      api: "ok",
      database: "ok",
      time: dbTime.rows[0]?.now,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (error) {
    return fail(res, "Admin health check failed", 500, error.message);
  }
});

router.get("/console-data", async (req, res) => {
  try {
    const [
      overview,
      apps,
      users,
      tables,
      memberships,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
    ] = await Promise.all([
      getOverview(),
      getApps(),
      getUsers(),
      getTables(),
      getMemberships(),
      getApiKeys(),
      getWebhooks(),
      getWebhookDeliveries(),
      getBuckets(),
      getEvents(),
    ]);

    return ok(res, {
      overview,
      apps,
      users,
      tables,
      memberships,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
      logs: getPm2Logs(),
      backups: getBackups(),
      security: getSecuritySummary(),
    });
  } catch (error) {
    return fail(res, "Failed to load console data", 500, error.message);
  }
});


router.post("/events/test", async (req, res) => {
  try {
    await createEvent("system.test_event", "Manual console test event created.", {
      triggeredFrom: "backend-console",
      at: new Date().toISOString(),
    });

    return ok(res, { created: true });
  } catch (error) {
    return fail(res, "Failed to create test event", 500, error.message);
  }
});

router.post("/backups/create", async (req, res) => {
  try {
    const backupDir = path.join(process.cwd(), "backups", "db-snapshots");
    fs.mkdirSync(backupDir, { recursive: true });

    const tablesResult = await dbQuery(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name ASC
    `);

    const backup = {
      createdAt: new Date().toISOString(),
      database: "goodos_backend",
      type: "json-snapshot",
      note: "GoodAppBackEnd console snapshot. Limited to 10000 rows per table.",
      tables: {},
    };

    for (const row of tablesResult.rows) {
      const tableName = row.tableName;
      const quotedTable = tableName.replace(/"/g, '""');
      const rows = await dbQuery(`SELECT * FROM "${quotedTable}" LIMIT 10000`);
      backup.tables[tableName] = rows.rows;
    }

    const fileName = `goodos_backend_snapshot_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(backupDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));

    await createEvent("backup.created", `Database snapshot created: ${fileName}`, {
      fileName,
      tableCount: Object.keys(backup.tables).length,
    });

    return ok(res, {
      backup: {
        name: fileName,
        path: filePath,
        tableCount: Object.keys(backup.tables).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to create backup snapshot", 500, error.message);
  }
});


function webhookRandomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function webhookSignature(secret, rawBody) {
  if (!secret) return "";
  return "sha256=" + crypto
    .createHmac("sha256", String(secret))
    .update(rawBody)
    .digest("hex");
}

async function getWebhookDeliveries() {
  const result = await dbQuery(`
    SELECT
      d.id,
      d.webhook_id AS "webhookId",
      w.name AS "webhookName",
      d.event_id AS "eventId",
      d.event_type AS "eventType",
      d.url,
      d.response_status AS "responseStatus",
      d.status,
      d.attempt_count AS "attemptCount",
      d.error_message AS "errorMessage",
      d.next_retry_at AS "nextRetryAt",
      d.delivered_at AS "deliveredAt",
      d.created_at AS "createdAt",
      d.updated_at AS "updatedAt"
    FROM backend_webhook_deliveries d
    LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
    ORDER BY d.created_at DESC
    LIMIT 250
  `);

  return result.rows;
}

async function deliverWebhook(webhook, eventPayload) {
  const deliveryId = webhookRandomId("whdel");
  const rawBody = JSON.stringify(eventPayload);
  const secret = webhook.secret || "";
  const signature = webhookSignature(secret, rawBody);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "GoodAppBackEnd-Webhooks/1.0",
    "X-GoodOS-Event": eventPayload.type || eventPayload.eventType || "system.test",
    "X-GoodOS-Webhook-Id": webhook.id,
    "X-GoodOS-Delivery-Id": deliveryId,
  };

  if (signature) {
    headers["X-GoodOS-Signature"] = signature;
  }

  await dbQuery(
    `
      INSERT INTO backend_webhook_deliveries (
        id,
        webhook_id,
        event_id,
        event_type,
        url,
        request_headers,
        request_body,
        status,
        attempt_count
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', 0)
    `,
    [
      deliveryId,
      webhook.id,
      eventPayload.id || null,
      eventPayload.type || eventPayload.eventType || "system.test",
      webhook.url,
      JSON.stringify(headers),
      rawBody,
    ]
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    const responseText = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const isSuccess = response.status >= 200 && response.status < 300;

    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          response_status = $1,
          response_headers = $2::jsonb,
          response_body = $3,
          status = $4,
          attempt_count = attempt_count + 1,
          error_message = $5,
          next_retry_at = $6,
          delivered_at = $7,
          updated_at = NOW()
        WHERE id = $8
      `,
      [
        response.status,
        JSON.stringify(responseHeaders),
        responseText.slice(0, 10000),
        isSuccess ? "delivered" : "failed",
        isSuccess ? null : `HTTP ${response.status}`,
        isSuccess ? null : new Date(Date.now() + 5 * 60 * 1000),
        isSuccess ? new Date() : null,
        deliveryId,
      ]
    );

    await dbQuery(
      `
        UPDATE backend_webhooks
        SET last_triggered_at = NOW()
        WHERE id = $1
      `,
      [webhook.id]
    );

    return {
      id: deliveryId,
      status: isSuccess ? "delivered" : "failed",
      responseStatus: response.status,
    };
  } catch (error) {
    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          status = 'failed',
          attempt_count = attempt_count + 1,
          error_message = $1,
          next_retry_at = $2,
          updated_at = NOW()
        WHERE id = $3
      `,
      [
        error.name === "AbortError" ? "Request timed out after 15 seconds" : error.message,
        new Date(Date.now() + 5 * 60 * 1000),
        deliveryId,
      ]
    );

    return {
      id: deliveryId,
      status: "failed",
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}


async function getWebhookConsolePayloadDirect() {
  const webhooksResult = await dbQuery(`
    SELECT
      id,
      name,
      url,
      events,
      status,
      created_at AS "createdAt",
      last_triggered_at AS "lastTriggeredAt"
    FROM backend_webhooks
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      created_at DESC
  `);

  const deliveriesResult = await dbQuery(`
    SELECT
      d.id,
      d.webhook_id AS "webhookId",
      COALESCE(w.name, d.webhook_id) AS "webhookName",
      d.event_id AS "eventId",
      d.event_type AS "eventType",
      d.url,
      d.response_status AS "responseStatus",
      d.status,
      d.attempt_count AS "attemptCount",
      d.error_message AS "errorMessage",
      d.next_retry_at AS "nextRetryAt",
      d.delivered_at AS "deliveredAt",
      d.created_at AS "createdAt",
      d.updated_at AS "updatedAt"
    FROM backend_webhook_deliveries d
    LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
    ORDER BY d.created_at DESC
    LIMIT 250
  `);

  return {
    webhooks: webhooksResult.rows,
    webhookDeliveries: deliveriesResult.rows,
  };
}

router.get("/webhook-deliveries", async (req, res) => {
  try {
    return ok(res, { deliveries: await getWebhookDeliveries() });
  } catch (error) {
    return fail(res, "Failed to load webhook deliveries", 500, error.message);
  }
});

router.post("/webhooks/:id/test", async (req, res) => {
  try {
    const result = await dbQuery(
      `
        SELECT id, name, url, events, secret, status
        FROM backend_webhooks
        WHERE id = $1
        LIMIT 1
      `,
      [req.params.id]
    );

    const webhook = result.rows[0];

    if (!webhook) return fail(res, "Webhook not found", 404);
    if (webhook.status !== "active") return fail(res, "Webhook is not active", 400);

    const eventId = webhookRandomId("evt");

    const eventPayload = {
      id: eventId,
      type: "webhook.test",
      source: "goodapp-backend",
      createdAt: new Date().toISOString(),
      data: {
        message: "GoodAppBackEnd test webhook delivery.",
        webhookId: webhook.id,
        webhookName: webhook.name,
      },
    };

    await dbQuery(
      `
        INSERT INTO backend_events (id, event_type, source, message, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        eventId,
        "webhook.test",
        "goodapp-backend",
        `Test webhook sent to ${webhook.name}`,
        JSON.stringify(eventPayload),
      ]
    );

    const delivery = await deliverWebhook(webhook, eventPayload);

    return ok(res, { delivery });
  } catch (error) {
    return fail(res, "Failed to send test webhook", 500, error.message);
  }
});

router.post("/webhook-deliveries/:id/retry", async (req, res) => {
  try {
    const result = await dbQuery(
      `
        SELECT
          d.id AS "deliveryId",
          d.request_body AS "requestBody",
          w.id,
          w.name,
          w.url,
          w.secret,
          w.status
        FROM backend_webhook_deliveries d
        JOIN backend_webhooks w ON w.id = d.webhook_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [req.params.id]
    );

    const row = result.rows[0];

    if (!row) return fail(res, "Delivery not found", 404);
    if (row.status !== "active") return fail(res, "Webhook is not active", 400);

    const delivery = await deliverWebhook(
      {
        id: row.id,
        name: row.name,
        url: row.url,
        secret: row.secret,
        status: row.status,
      },
      row.requestBody || {}
    );

    return ok(res, { retriedFrom: row.deliveryId, delivery });
  } catch (error) {
    return fail(res, "Failed to retry webhook delivery", 500, error.message);
  }
});


router.post("/webhooks/create-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    const rawEvents = req.body?.events;

    if (!name) return fail(res, "Webhook name is required", 400);
    if (!url) return fail(res, "Webhook URL is required", 400);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return fail(res, "Webhook URL must be a valid URL", 400);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return fail(res, "Webhook URL must start with http:// or https://", 400);
    }

    const events = Array.isArray(rawEvents) && rawEvents.length
      ? rawEvents.map((event) => String(event).trim()).filter(Boolean)
      : ["*"];

    const id = `wh_${crypto.randomUUID().replace(/-/g, "")}`;
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    const result = await dbQuery(
      `
        INSERT INTO backend_webhooks (
          id,
          name,
          url,
          events,
          secret,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4::text[], $5, 'active', $6)
        RETURNING
          id,
          name,
          url,
          events,
          status,
          created_at AS "createdAt",
          last_triggered_at AS "lastTriggeredAt"
      `,
      [id, name, url, events, secret, createdBy]
    );

    if (typeof createEvent === "function") {
      await createEvent("webhook.created", `Webhook created: ${name}`, {
        webhookId: id,
        name,
        url,
        events,
      });
    }

    return ok(res, {
      webhook: result.rows[0],
      secret,
      warning: "Copy this webhook secret now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create webhook", 500, error.message);
  }
});

module.exports = router;
