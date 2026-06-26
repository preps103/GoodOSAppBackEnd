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


router.get("/webhooks-live", async (req, res) => {
  try {
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
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        created_at DESC
    `);

    return ok(res, { webhooks: result.rows });
  } catch (error) {
    return fail(res, "Failed to load live webhooks", 500, error.message);
  }
});

router.get("/webhook-deliveries-live", async (req, res) => {
  try {
    const result = await dbQuery(`
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

    return ok(res, { deliveries: result.rows });
  } catch (error) {
    return fail(res, "Failed to load live webhook deliveries", 500, error.message);
  }
});


router.get("/webhooks-page-data", async (req, res) => {
  try {
    const webhooks = await dbQuery(`
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

    const deliveries = await dbQuery(`
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
        d.delivered_at AS "deliveredAt",
        d.created_at AS "createdAt"
      FROM backend_webhook_deliveries d
      LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
      ORDER BY d.created_at DESC
      LIMIT 250
    `);

    return ok(res, {
      webhooks: webhooks.rows,
      deliveries: deliveries.rows,
      counts: {
        webhooks: webhooks.rows.length,
        active: webhooks.rows.filter((row) => row.status === "active").length,
        deliveries: deliveries.rows.length,
        failed: deliveries.rows.filter((row) => row.status === "failed").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load webhooks page data", 500, error.message);
  }
});


router.get("/api-keys-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        key_prefix AS "keyPrefix",
        scopes,
        allowed_app_ids AS "allowedAppIds",
        description,
        status,
        last_used_at AS "lastUsedAt",
        revoked_at AS "revokedAt",
        created_at AS "createdAt"
      FROM backend_api_keys
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const rows = result.rows;

    return ok(res, {
      apiKeys: rows,
      counts: {
        total: rows.length,
        active: rows.filter((row) => row.status === "active").length,
        revoked: rows.filter((row) => row.status !== "active").length,
        scoped: rows.filter((row) => row.type === "scoped").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load API keys page data", 500, error.message);
  }
});


router.post("/api-keys/create-scoped", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "scoped").trim();
    const description = String(req.body?.description || "").trim();

    const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
      ? req.body.scopes.map((item) => String(item).trim()).filter(Boolean)
      : ["read:health"];

    const allowedAppIds = Array.isArray(req.body?.allowedAppIds) && req.body.allowedAppIds.length
      ? req.body.allowedAppIds.map((item) => String(item).trim()).filter(Boolean)
      : ["*"];

    if (!name) return fail(res, "API key name is required", 400);

    const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const secret = `gak_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(secret).digest("hex");
    const keyPrefix = secret.slice(0, 18);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    const result = await dbQuery(
      `
        INSERT INTO backend_api_keys (
          id,
          name,
          type,
          key_prefix,
          key_hash,
          scopes,
          allowed_app_ids,
          description,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, 'active', $9)
        RETURNING
          id,
          name,
          type,
          key_prefix AS "keyPrefix",
          scopes,
          allowed_app_ids AS "allowedAppIds",
          description,
          status,
          created_at AS "createdAt"
      `,
      [
        id,
        name,
        type,
        keyPrefix,
        keyHash,
        scopes,
        allowedAppIds,
        description || null,
        createdBy,
      ]
    );

    return ok(res, {
      apiKey: result.rows[0],
      secret,
      warning: "Copy this key now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create scoped API key", 500, error.message);
  }
});


router.get("/storage-page-data", async (req, res) => {
  try {
    const bucketsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_buckets
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const filesResult = await dbQuery(`
      SELECT *
      FROM backend_storage_files
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const signedUrlsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_signed_urls
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const buckets = bucketsResult.rows;
    const files = filesResult.rows;
    const signedUrls = signedUrlsResult.rows;

    return ok(res, {
      buckets,
      files,
      signedUrls,
      counts: {
        buckets: buckets.length,
        files: files.length,
        signedUrls: signedUrls.length,
        privateBuckets: buckets.filter((row) => row.visibility === "private").length,
        publicBuckets: buckets.filter((row) => row.visibility === "public").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load storage page data", 500, error.message);
  }
});

router.post("/storage/buckets/create-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const visibility = String(req.body?.visibility || "private").trim().toLowerCase();

    if (!name) return fail(res, "Bucket name is required", 400);
    if (!["private", "public"].includes(visibility)) {
      return fail(res, "Visibility must be private or public", 400);
    }

    const id = `bucket_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_storage_buckets (
          id,
          name,
          visibility,
          status
        )
        VALUES ($1, $2, $3, 'active')
        RETURNING *
      `,
      [id, name, visibility]
    );

    return ok(res, {
      bucket: result.rows[0],
      message: "Storage bucket created.",
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate")) {
      return fail(res, "A bucket with that name already exists", 409, error.message);
    }

    return fail(res, "Failed to create storage bucket", 500, error.message);
  }
});


async function safeTableCount(tableName) {
  try {
    const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
    if (!exists.rows[0]?.table_name) return 0;

    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
    return Number(result.rows[0]?.count || 0);
  } catch (error) {
    return 0;
  }
}

async function safeDashboardApps() {
  const candidates = [
    "backend_apps",
    "backend_app_registry",
    "backend_registered_apps"
  ];

  for (const tableName of candidates) {
    try {
      const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
      if (!exists.rows[0]?.table_name) continue;

      const result = await dbQuery(`
        SELECT *
        FROM ${tableName}
        ORDER BY created_at DESC NULLS LAST
        LIMIT 50
      `);

      return result.rows.map((row) => ({
        id: row.id || row.app_id || row.slug || "-",
        name: row.name || row.app_name || row.title || row.id || "-",
        domain: row.domain || row.base_url || row.url || "-",
        status: row.status || "active",
        memberCount: row.member_count || row.members || 0,
        createdAt: row.created_at || row.createdAt || null,
      }));
    } catch (error) {
      continue;
    }
  }

  return [];
}

router.get("/dashboard-page-data", async (req, res) => {
  try {
    const apps = await safeDashboardApps();

    const counts = {
      users: await safeTableCount("backend_users"),
      apps: apps.length || await safeTableCount("backend_apps"),
      memberships: await safeTableCount("backend_app_memberships"),
      sessions: await safeTableCount("backend_sessions"),
      apiKeys: await safeTableCount("backend_api_keys"),
      webhooks: await safeTableCount("backend_webhooks"),
      storageBuckets: await safeTableCount("backend_storage_buckets"),
      storageFiles: await safeTableCount("backend_storage_files"),
    };

    const memory = process.memoryUsage();

    return ok(res, {
      counts,
      apps,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
    });
  } catch (error) {
    return fail(res, "Failed to load dashboard page data", 500, error.message);
  }
});


router.get("/dashboard-real-page-data", async (req, res) => {
  try {
    const countsResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users,
        (SELECT COUNT(*)::int FROM apps WHERE status = 'active') AS "activeApps",
        (SELECT COUNT(*)::int FROM app_memberships WHERE status = 'active') AS "activeMemberships",
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS sessions,
        (SELECT COUNT(*)::int FROM backend_api_keys) AS "apiKeys",
        (SELECT COUNT(*)::int FROM backend_webhooks) AS webhooks,
        (SELECT COUNT(*)::int FROM backend_storage_buckets) AS "storageBuckets",
        (SELECT COUNT(*)::int FROM backend_storage_files) AS "storageFiles"
    `);

    const appsResult = await dbQuery(`
      SELECT
        a.id,
        a.name,
        a.domain,
        a.status,
        a.description,
        COUNT(am.id)::int AS "memberCount",
        a.created_at AS "createdAt",
        a.updated_at AS "updatedAt"
      FROM apps a
      LEFT JOIN app_memberships am
        ON am.app_id = a.id
       AND am.status = 'active'
      GROUP BY a.id, a.name, a.domain, a.status, a.description, a.created_at, a.updated_at
      ORDER BY a.name ASC
      LIMIT 250
    `);

    const usersResult = await dbQuery(`
      SELECT
        id,
        email,
        first_name AS "firstName",
        last_name AS "lastName",
        display_name AS "displayName",
        platform_role AS "platformRole",
        status,
        email_verified AS "emailVerified",
        last_login_at AS "lastLoginAt",
        created_at AS "createdAt"
      FROM users
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const membershipsResult = await dbQuery(`
      SELECT
        am.id,
        u.email,
        u.display_name AS "displayName",
        a.id AS "appId",
        a.name AS "appName",
        a.domain,
        am.role,
        am.status,
        am.created_at AS "createdAt"
      FROM app_memberships am
      JOIN users u ON u.id = am.user_id
      JOIN apps a ON a.id = am.app_id
      ORDER BY a.name ASC, u.email ASC
      LIMIT 500
    `);

    const sessionsResult = await dbQuery(`
      SELECT
        s.id,
        u.email,
        s.ip_address::text AS "ipAddress",
        s.user_agent AS "userAgent",
        s.expires_at AS "expiresAt",
        s.revoked_at AS "revokedAt",
        s.created_at AS "createdAt",
        CASE
          WHEN s.revoked_at IS NOT NULL THEN 'revoked'
          WHEN s.expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 100
    `);

    const memory = process.memoryUsage();
    const counts = countsResult.rows[0] || {};

    return ok(res, {
      counts,
      apps: appsResult.rows,
      users: usersResult.rows,
      memberships: membershipsResult.rows,
      sessions: sessionsResult.rows,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
    });
  } catch (error) {
    return fail(res, "Failed to load real dashboard data", 500, error.message);
  }
});


function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

router.get("/database-page-data", async (req, res) => {
  try {
    const tablesResult = await dbQuery(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `);

    const columnsResult = await dbQuery(`
      SELECT
        table_name AS "tableName",
        ordinal_position AS "position",
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `);

    const tables = [];

    for (const table of tablesResult.rows) {
      const tableName = table.tableName;

      let rowCount = 0;
      try {
        const countResult = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(tableName)}`);
        rowCount = Number(countResult.rows[0]?.count || 0);
      } catch (error) {
        rowCount = 0;
      }

      tables.push({
        tableName,
        rowCount,
        status: "live",
        columns: columnsResult.rows.filter((column) => column.tableName === tableName),
      });
    }

    return ok(res, {
      tables,
      counts: {
        tables: tables.length,
        rows: tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load database page data", 500, error.message);
  }
});


router.get("/realtime-page-data", async (req, res) => {
  try {
    const eventsResult = await dbQuery(`
      SELECT
        id,
        event_type AS "eventType",
        source,
        channel,
        message,
        payload,
        status,
        created_at AS "createdAt"
      FROM backend_realtime_events
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const channelsResult = await dbQuery(`
      SELECT channel, COUNT(*)::int AS count
      FROM backend_realtime_events
      GROUP BY channel
      ORDER BY channel ASC
    `);

    const events = eventsResult.rows;
    const channels = channelsResult.rows;

    return ok(res, {
      events,
      channels,
      counts: {
        events: events.length,
        channels: channels.length,
        broadcasts: events.filter((event) => event.status === "recorded").length,
        consumers: 0,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load realtime page data", 500, error.message);
  }
});

router.post("/realtime-events/create-test-safe", async (req, res) => {
  try {
    const id = `evt_${crypto.randomUUID().replace(/-/g, "")}`;

    const eventType = String(req.body?.eventType || "system.test").trim();
    const source = String(req.body?.source || "backend-console").trim();
    const channel = String(req.body?.channel || "system").trim();
    const message = String(req.body?.message || "Realtime test event from GoodAppBackEnd console").trim();

    const payload = req.body?.payload && typeof req.body.payload === "object"
      ? req.body.payload
      : {
          test: true,
          createdFrom: "GoodAppBackEnd Console",
          time: new Date().toISOString(),
        };

    const result = await dbQuery(
      `
        INSERT INTO backend_realtime_events (
          id,
          event_type,
          source,
          channel,
          message,
          payload,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'recorded')
        RETURNING
          id,
          event_type AS "eventType",
          source,
          channel,
          message,
          payload,
          status,
          created_at AS "createdAt"
      `,
      [id, eventType, source, channel, message, JSON.stringify(payload)]
    );

    return ok(res, {
      event: result.rows[0],
      message: "Realtime test event created.",
    });
  } catch (error) {
    return fail(res, "Failed to create realtime test event", 500, error.message);
  }
});


router.get("/edge-functions-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        runtime,
        trigger_type AS "triggerType",
        route_path AS "routePath",
        schedule,
        description,
        status,
        last_run_at AS "lastRunAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_edge_functions
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const functions = result.rows;

    return ok(res, {
      functions,
      counts: {
        functions: functions.length,
        http: functions.filter((item) => item.type === "http").length,
        event: functions.filter((item) => item.type === "event").length,
        scheduled: functions.filter((item) => item.type === "scheduled").length,
        active: functions.filter((item) => item.status === "active").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load edge functions page data", 500, error.message);
  }
});

router.post("/edge-functions/create-test-safe", async (req, res) => {
  try {
    const id = `fn_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = String(req.body?.name || "Console Test Function").trim();
    const type = String(req.body?.type || "http").trim();
    const runtime = String(req.body?.runtime || "node").trim();
    const triggerType = String(req.body?.triggerType || "manual").trim();
    const routePath = String(req.body?.routePath || `/api/functions/${id}`).trim();
    const description = String(req.body?.description || "Test function created from GoodAppBackEnd console.").trim();

    const result = await dbQuery(
      `
        INSERT INTO backend_edge_functions (
          id,
          name,
          type,
          runtime,
          trigger_type,
          route_path,
          description,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        RETURNING
          id,
          name,
          type,
          runtime,
          trigger_type AS "triggerType",
          route_path AS "routePath",
          schedule,
          description,
          status,
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, name, type, runtime, triggerType, routePath, description]
    );

    return ok(res, {
      function: result.rows[0],
      message: "Edge function registry record created.",
    });
  } catch (error) {
    return fail(res, "Failed to create edge function", 500, error.message);
  }
});

router.post("/edge-functions/:id/run-test-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          last_run_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          type,
          runtime,
          trigger_type AS "triggerType",
          route_path AS "routePath",
          schedule,
          description,
          status,
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id]
    );

    if (!result.rows[0]) return fail(res, "Edge function not found", 404);

    return ok(res, {
      function: result.rows[0],
      message: "Function test run recorded.",
    });
  } catch (error) {
    return fail(res, "Failed to run edge function test", 500, error.message);
  }
});


function readTailLines(filePath, lineCount = 80) {
  try {
    const fs = require("fs");
    const childProcess = require("child_process");

    if (!fs.existsSync(filePath)) return [];

    const output = childProcess.execFileSync("tail", ["-n", String(lineCount), filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

router.get("/logs-page-data", async (req, res) => {
  try {
    const dbLogsResult = await dbQuery(`
      SELECT
        id,
        source,
        level,
        message,
        context,
        created_at AS "createdAt"
      FROM backend_system_logs
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const pm2OutPath = "/root/.pm2/logs/goodapp-backend-out.log";
    const pm2ErrorPath = "/root/.pm2/logs/goodapp-backend-error.log";

    const outputLines = readTailLines(pm2OutPath, 120).map((line, index) => ({
      id: `pm2_out_${index}`,
      source: "pm2:goodapp-backend",
      level: "output",
      message: line,
      filePath: pm2OutPath,
      createdAt: null,
    }));

    const errorLines = readTailLines(pm2ErrorPath, 120).map((line, index) => ({
      id: `pm2_error_${index}`,
      source: "pm2:goodapp-backend",
      level: "error",
      message: line,
      filePath: pm2ErrorPath,
      createdAt: null,
    }));

    const databaseLogs = dbLogsResult.rows;

    const logs = [
      ...databaseLogs,
      ...errorLines.reverse(),
      ...outputLines.reverse(),
    ].slice(0, 250);

    return ok(res, {
      logs,
      counts: {
        logFiles: [pm2OutPath, pm2ErrorPath].length,
        databaseLogs: databaseLogs.length,
        errors: logs.filter((log) => log.level === "error").length,
        output: logs.filter((log) => log.level === "output").length,
        total: logs.length,
      },
      files: {
        output: pm2OutPath,
        error: pm2ErrorPath,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load logs page data", 500, error.message);
  }
});

router.post("/logs/create-test-safe", async (req, res) => {
  try {
    const id = `log_${crypto.randomUUID().replace(/-/g, "")}`;
    const level = String(req.body?.level || "info").trim();
    const source = String(req.body?.source || "backend-console").trim();
    const message = String(req.body?.message || "Test log from GoodAppBackEnd console.").trim();

    const context = req.body?.context && typeof req.body.context === "object"
      ? req.body.context
      : {
          test: true,
          createdFrom: "GoodAppBackEnd Console",
          time: new Date().toISOString(),
        };

    const result = await dbQuery(
      `
        INSERT INTO backend_system_logs (
          id,
          source,
          level,
          message,
          context
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING
          id,
          source,
          level,
          message,
          context,
          created_at AS "createdAt"
      `,
      [id, source, level, message, JSON.stringify(context)]
    );

    return ok(res, {
      log: result.rows[0],
      message: "Test log created.",
    });
  } catch (error) {
    return fail(res, "Failed to create test log", 500, error.message);
  }
});


router.get("/backups-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        status,
        size_bytes AS "sizeBytes",
        file_path AS "filePath",
        backup_format AS "backupFormat",
        checksum_sha256 AS "checksumSha256",
        database_name AS "databaseName",
        notes,
        error_message AS "errorMessage",
        created_by AS "createdBy",
        completed_at AS "completedAt",
        deleted_at AS "deletedAt",
        deleted_by AS "deletedBy",
        deleted_reason AS "deletedReason",
        file_deleted AS "fileDeleted",
        created_at AS "createdAt"
      FROM backend_backups
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const backups = result.rows;

    let restoreTests = [];

    try {
      const restoreTestsResult = await dbQuery(`
        SELECT
          id,
          backup_id AS "backupId",
          test_database AS "testDatabase",
          status,
          table_count AS "tableCount",
          row_count AS "rowCount",
          error_message AS "errorMessage",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_at AS "createdAt"
        FROM backend_backup_restore_tests
        ORDER BY created_at DESC
        LIMIT 100
      `);
      restoreTests = restoreTestsResult.rows;
    } catch (restoreTestError) {
      restoreTests = [];
    }

    return ok(res, {
      backups,
      restoreTests,
      counts: {
        backups: backups.length,
        completed: backups.filter((item) => item.status === "completed").length,
        failed: backups.filter((item) => item.status === "failed").length,
        pending: backups.filter((item) => item.status === "pending").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load backups page data", 500, error.message);
  }
});

router.post("/backups/create-safe", async (req, res) => {
  try {
    const id = `backup_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const name = String(req.body?.name || `Manual Backup ${now.toISOString()}`).trim();
    const type = String(req.body?.type || "database").trim();
    const notes = String(req.body?.notes || "Manual backup record created from GoodAppBackEnd console.").trim();

    const result = await dbQuery(
      `
        INSERT INTO backend_backups (
          id,
          name,
          type,
          status,
          size_bytes,
          file_path,
          notes,
          created_by,
          completed_at
        )
        VALUES ($1, $2, $3, 'completed', 0, '/var/www/GoodAppBackEnd/backups', $4, 'console', NOW())
        RETURNING
          id,
          name,
          type,
          status,
          size_bytes AS "sizeBytes",
          file_path AS "filePath",
          notes,
          created_by AS "createdBy",
          completed_at AS "completedAt",
          created_at AS "createdAt"
      `,
      [id, name, type, notes]
    );

    return ok(res, {
      backup: result.rows[0],
      message: "Backup record created.",
    });
  } catch (error) {
    return fail(res, "Failed to create backup record", 500, error.message);
  }
});


router.get("/settings-page-data", async (req, res) => {
  try {
    const settingsResult = await dbQuery(`
      SELECT
        id,
        category,
        setting_key AS "settingKey",
        label,
        CASE
          WHEN is_secret = true THEN '{"value":"********"}'::jsonb
          ELSE value_json
        END AS "valueJson",
        value_type AS "valueType",
        is_secret AS "isSecret",
        is_editable AS "isEditable",
        description,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_platform_settings
      ORDER BY category ASC, label ASC
      LIMIT 500
    `);

    const categoriesResult = await dbQuery(`
      SELECT
        category,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'planned')::int AS planned
      FROM backend_platform_settings
      GROUP BY category
      ORDER BY category ASC
    `);

    const memory = process.memoryUsage();

    return ok(res, {
      settings: settingsResult.rows,
      categories: categoriesResult.rows,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        service: "GoodAppBackEnd",
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
      counts: {
        settings: settingsResult.rows.length,
        categories: categoriesResult.rows.length,
        active: settingsResult.rows.filter((item) => item.status === "active").length,
        planned: settingsResult.rows.filter((item) => item.status === "planned").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load settings page data", 500, error.message);
  }
});

router.post("/settings/update-safe", async (req, res) => {
  try {
    const settingKey = String(req.body?.settingKey || "").trim();
    const value = req.body?.value;

    if (!settingKey) return fail(res, "Setting key is required", 400);

    const existingResult = await dbQuery(
      `
        SELECT setting_key, is_editable, is_secret
        FROM backend_platform_settings
        WHERE setting_key = $1
      `,
      [settingKey]
    );

    const existing = existingResult.rows[0];

    if (!existing) return fail(res, "Setting not found", 404);
    if (!existing.is_editable) return fail(res, "This setting is read only", 403);
    if (existing.is_secret) return fail(res, "Secret settings cannot be edited from this console yet", 403);

    const result = await dbQuery(
      `
        UPDATE backend_platform_settings
        SET
          value_json = $2::jsonb,
          updated_at = NOW()
        WHERE setting_key = $1
        RETURNING
          id,
          category,
          setting_key AS "settingKey",
          label,
          value_json AS "valueJson",
          value_type AS "valueType",
          is_secret AS "isSecret",
          is_editable AS "isEditable",
          description,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [settingKey, JSON.stringify({ value })]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'settings.update', 'platform_setting', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        settingKey,
        JSON.stringify({ value }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      setting: result.rows[0],
      message: "Setting updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update setting", 500, error.message);
  }
});


router.get("/settings-readiness-page-data", async (req, res) => {
  try {
    const countsResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users,
        (SELECT COUNT(*)::int FROM apps WHERE status = 'active') AS apps,
        (SELECT COUNT(*)::int FROM app_memberships WHERE status = 'active') AS memberships,
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS sessions,
        (SELECT COUNT(*)::int FROM backend_api_keys WHERE status = 'active') AS "activeApiKeys",
        (SELECT COUNT(*)::int FROM backend_storage_buckets WHERE status = 'active') AS buckets,
        (SELECT COUNT(*)::int FROM backend_storage_files) AS files,
        (SELECT COUNT(*)::int FROM backend_webhooks WHERE status = 'active') AS "activeWebhooks",
        (SELECT COUNT(*)::int FROM backend_webhook_deliveries) AS "webhookDeliveries",
        (SELECT COUNT(*)::int FROM backend_realtime_events) AS "realtimeEvents",
        (SELECT COUNT(*)::int FROM backend_edge_functions) AS "edgeFunctions",
        (SELECT COUNT(*)::int FROM backend_system_logs) AS "systemLogs",
        (SELECT COUNT(*)::int FROM backend_backups) AS backups,
        (SELECT COUNT(*)::int FROM backend_platform_settings) AS settings
    `);

    const counts = countsResult.rows[0] || {};

    const checks = [
      { category: "Auth", label: "Owner account exists", status: counts.users > 0 ? "ready" : "missing", value: counts.users },
      { category: "Apps", label: "App registry populated", status: counts.apps >= 10 ? "ready" : "partial", value: counts.apps },
      { category: "Apps", label: "Owner app memberships", status: counts.memberships >= counts.apps ? "ready" : "partial", value: counts.memberships },
      { category: "Sessions", label: "Active session tracking", status: counts.sessions > 0 ? "ready" : "missing", value: counts.sessions },
      { category: "API Keys", label: "Active scoped API keys", status: counts.activeApiKeys > 0 ? "ready" : "missing", value: counts.activeApiKeys },
      { category: "Storage", label: "Storage buckets configured", status: counts.buckets > 0 ? "ready" : "missing", value: counts.buckets },
      { category: "Storage", label: "File tracking active", status: counts.files > 0 ? "ready" : "missing", value: counts.files },
      { category: "Webhooks", label: "Webhook endpoints active", status: counts.activeWebhooks > 0 ? "ready" : "missing", value: counts.activeWebhooks },
      { category: "Webhooks", label: "Delivery logs active", status: counts.webhookDeliveries > 0 ? "ready" : "missing", value: counts.webhookDeliveries },
      { category: "Realtime", label: "Realtime event table active", status: counts.realtimeEvents > 0 ? "ready" : "missing", value: counts.realtimeEvents },
      { category: "Functions", label: "Edge function registry active", status: counts.edgeFunctions > 0 ? "ready" : "missing", value: counts.edgeFunctions },
      { category: "Logs", label: "System logging active", status: counts.systemLogs > 0 ? "ready" : "missing", value: counts.systemLogs },
      { category: "Backups", label: "Backup registry active", status: counts.backups > 0 ? "ready" : "missing", value: counts.backups },
      { category: "Settings", label: "Platform settings registry active", status: counts.settings >= 40 ? "ready" : "partial", value: counts.settings },
    ];

    const ready = checks.filter((check) => check.status === "ready").length;
    const partial = checks.filter((check) => check.status === "partial").length;
    const missing = checks.filter((check) => check.status === "missing").length;

    return ok(res, {
      checks,
      counts,
      score: {
        ready,
        partial,
        missing,
        total: checks.length,
        percent: Math.round((ready / checks.length) * 100),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load settings readiness data", 500, error.message);
  }
});

router.get("/settings-audit-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        before_json AS "beforeJson",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      ORDER BY created_at DESC
      LIMIT 250
    `);

    return ok(res, {
      auditLogs: result.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load settings audit data", 500, error.message);
  }
});


router.get("/usage-page-data", async (req, res) => {
  try {
    const usageResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::bigint FROM backend_api_key_usage_logs WHERE created_at >= date_trunc('month', NOW())) AS "api.calls.monthly",
        (SELECT COUNT(*)::bigint FROM backend_api_keys WHERE status = 'active') AS "api.keys.active",
        (SELECT COUNT(*)::bigint FROM backend_storage_buckets WHERE status = 'active') AS "storage.buckets",
        (SELECT COUNT(*)::bigint FROM backend_storage_files) AS "storage.files",
        COALESCE((SELECT SUM(size_bytes)::bigint FROM backend_storage_files), 0) AS "storage.bytes",
        (SELECT COUNT(*)::bigint FROM backend_webhooks WHERE status = 'active') AS "webhooks.active",
        (SELECT COUNT(*)::bigint FROM backend_webhook_deliveries WHERE created_at >= date_trunc('month', NOW())) AS "webhooks.deliveries.monthly",
        (SELECT COUNT(*)::bigint FROM backend_realtime_events WHERE created_at >= date_trunc('month', NOW())) AS "realtime.events.monthly",
        (SELECT COUNT(*)::bigint FROM backend_edge_functions) AS "functions.registered",
        (SELECT COUNT(*)::bigint FROM backend_backups) AS "backups.records",
        (SELECT COUNT(*)::bigint FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS "sessions.active",
        (SELECT COUNT(*)::bigint FROM apps WHERE status = 'active') AS "apps.active"
    `);

    const quotaResult = await dbQuery(`
      SELECT
        id,
        metric_key AS "metricKey",
        label,
        category,
        quota_limit AS "quotaLimit",
        quota_unit AS "quotaUnit",
        warning_percent AS "warningPercent",
        is_enforced AS "isEnforced",
        description,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_usage_quotas
      WHERE status = 'active'
      ORDER BY category ASC, label ASC
    `);

    const rawUsage = usageResult.rows[0] || {};
    const quotas = quotaResult.rows;

    const usage = quotas.map((quota) => {
      const current = Number(rawUsage[quota.metricKey] || 0);
      const limit = Number(quota.quotaLimit || 0);
      const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;

      let state = "ok";
      if (limit > 0 && current >= limit) state = "over_limit";
      else if (limit > 0 && percent >= Number(quota.warningPercent || 80)) state = "warning";

      return {
        ...quota,
        current,
        percent,
        state,
      };
    });

    return ok(res, {
      usage,
      rawUsage,
      counts: {
        metrics: usage.length,
        ok: usage.filter((item) => item.state === "ok").length,
        warning: usage.filter((item) => item.state === "warning").length,
        overLimit: usage.filter((item) => item.state === "over_limit").length,
        enforced: usage.filter((item) => item.isEnforced).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load usage page data", 500, error.message);
  }
});

router.post("/usage-quotas/update-safe", async (req, res) => {
  try {
    const metricKey = String(req.body?.metricKey || "").trim();
    const quotaLimit = Number(req.body?.quotaLimit);

    if (!metricKey) return fail(res, "Metric key is required", 400);
    if (!Number.isFinite(quotaLimit) || quotaLimit < 0) {
      return fail(res, "Quota limit must be a valid positive number", 400);
    }

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_usage_quotas
        WHERE metric_key = $1
      `,
      [metricKey]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Quota not found", 404);

    const result = await dbQuery(
      `
        UPDATE backend_usage_quotas
        SET
          quota_limit = $2,
          updated_at = NOW()
        WHERE metric_key = $1
        RETURNING
          id,
          metric_key AS "metricKey",
          label,
          category,
          quota_limit AS "quotaLimit",
          quota_unit AS "quotaUnit",
          warning_percent AS "warningPercent",
          is_enforced AS "isEnforced",
          description,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [metricKey, quotaLimit]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'usage.quota.update', 'usage_quota', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        metricKey,
        JSON.stringify(before),
        JSON.stringify({ quotaLimit }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      quota: result.rows[0],
      message: "Usage quota updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update usage quota", 500, error.message);
  }
});


router.post("/backups/create-real-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");
    const scriptPath = "/var/www/GoodAppBackEnd/scripts/create-db-backup.sh";

    const output = childProcess.execFileSync(scriptPath, {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const backupIdLine = output.split("\n").find((line) => line.startsWith("BACKUP_ID="));
    const backupId = backupIdLine ? backupIdLine.replace("BACKUP_ID=", "").trim() : null;

    let backup = null;

    if (backupId) {
      const backupResult = await dbQuery(
        `
          SELECT
            id,
            name,
            type,
            status,
            size_bytes AS "sizeBytes",
            file_path AS "filePath",
            backup_format AS "backupFormat",
            checksum_sha256 AS "checksumSha256",
            database_name AS "databaseName",
            notes,
            error_message AS "errorMessage",
            created_by AS "createdBy",
            completed_at AS "completedAt",
            created_at AS "createdAt"
          FROM backend_backups
          WHERE id = $1
        `,
        [backupId]
      );

      backup = backupResult.rows[0] || null;
    }

    return ok(res, {
      backup,
      output,
      message: "Real database backup created.",
    });
  } catch (error) {
    return fail(res, "Failed to create real database backup", 500, error.message);
  }
});

router.get("/backups/:id/download", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT id, file_path, status
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const backup = result.rows[0];

    if (!backup) return fail(res, "Backup not found", 404);
    if (backup.status !== "completed") return fail(res, "Backup is not completed", 400);
    if (backup.deleted_at || backup.file_deleted) return fail(res, "Backup file was deleted", 410);
    if (!backup.file_path || !fs.existsSync(backup.file_path)) {
      return fail(res, "Backup file does not exist on disk", 404);
    }

    const safeName = path.basename(backup.file_path);

    return res.download(backup.file_path, safeName);
  } catch (error) {
    return fail(res, "Failed to download backup", 500, error.message);
  }
});

router.post("/backups/:id/verify-safe", async (req, res) => {
  try {
    const fs = require("fs");
    const childProcess = require("child_process");

    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT
          id,
          file_path AS "filePath",
          checksum_sha256 AS "checksumSha256",
          status
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const backup = result.rows[0];

    if (!backup) return fail(res, "Backup not found", 404);
    if (!backup.filePath || !fs.existsSync(backup.filePath)) {
      return fail(res, "Backup file does not exist on disk", 404);
    }

    const output = childProcess.execFileSync("sha256sum", [backup.filePath], {
      encoding: "utf8",
      timeout: 30000,
    });

    const currentChecksum = output.split(/\s+/)[0];
    const matches = currentChecksum === backup.checksumSha256;

    return ok(res, {
      backupId: id,
      filePath: backup.filePath,
      expectedChecksum: backup.checksumSha256,
      currentChecksum,
      matches,
      message: matches ? "Backup checksum verified." : "Backup checksum mismatch.",
    });
  } catch (error) {
    return fail(res, "Failed to verify backup", 500, error.message);
  }
});


router.post("/backups/:id/restore-verify-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");
    const id = String(req.params.id || "").trim();
    const scriptPath = "/var/www/GoodAppBackEnd/scripts/verify-db-restore.sh";

    if (!id) return fail(res, "Backup id is required", 400);

    const output = childProcess.execFileSync(scriptPath, [id], {
      encoding: "utf8",
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const testIdLine = output.split("\n").find((line) => line.startsWith("TEST_ID="));
    const testId = testIdLine ? testIdLine.replace("TEST_ID=", "").trim() : null;

    let restoreTest = null;

    if (testId) {
      const testResult = await dbQuery(
        `
          SELECT
            id,
            backup_id AS "backupId",
            test_database AS "testDatabase",
            status,
            table_count AS "tableCount",
            row_count AS "rowCount",
            error_message AS "errorMessage",
            started_at AS "startedAt",
            completed_at AS "completedAt",
            created_at AS "createdAt"
          FROM backend_backup_restore_tests
          WHERE id = $1
        `,
        [testId]
      );

      restoreTest = testResult.rows[0] || null;
    }

    return ok(res, {
      restoreTest,
      output,
      message: "Backup restore verification completed safely.",
    });
  } catch (error) {
    return fail(res, "Failed to verify backup restore", 500, error.message);
  }
});


async function getBackupRetentionDays() {
  try {
    const result = await dbQuery(`
      SELECT value_json ->> 'value' AS value
      FROM backend_platform_settings
      WHERE setting_key = 'backups.retention_days'
      LIMIT 1
    `);

    const days = Number(result.rows[0]?.value || 30);
    return Number.isFinite(days) && days > 0 ? days : 30;
  } catch (error) {
    return 30;
  }
}

router.post("/backups/:id/delete-safe", async (req, res) => {
  try {
    const fs = require("fs");

    const id = String(req.params.id || "").trim();
    const reason = String(req.body?.reason || "Manual delete from GoodAppBackEnd console.").trim();

    if (!id) return fail(res, "Backup id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const before = beforeResult.rows[0];

    if (!before) return fail(res, "Backup not found", 404);

    let fileDeleted = false;

    if (before.file_path && fs.existsSync(before.file_path)) {
      fs.unlinkSync(before.file_path);
      fileDeleted = true;
    }

    const result = await dbQuery(
      `
        UPDATE backend_backups
        SET
          status = CASE WHEN status = 'completed' THEN 'deleted' ELSE status END,
          deleted_at = NOW(),
          deleted_by = $2,
          deleted_reason = $3,
          file_deleted = true
        WHERE id = $1
        RETURNING
          id,
          name,
          type,
          status,
          size_bytes AS "sizeBytes",
          file_path AS "filePath",
          backup_format AS "backupFormat",
          checksum_sha256 AS "checksumSha256",
          database_name AS "databaseName",
          notes,
          error_message AS "errorMessage",
          created_by AS "createdBy",
          completed_at AS "completedAt",
          deleted_at AS "deletedAt",
          deleted_by AS "deletedBy",
          deleted_reason AS "deletedReason",
          file_deleted AS "fileDeleted",
          created_at AS "createdAt"
      `,
      [
        id,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        reason,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'backup.delete', 'backup', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify({ fileDeleted, reason }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      backup: result.rows[0],
      fileDeleted,
      message: fileDeleted ? "Backup file deleted and record marked." : "Backup record marked; no file was found on disk.",
    });
  } catch (error) {
    return fail(res, "Failed to delete backup safely", 500, error.message);
  }
});

router.post("/backups/retention-cleanup-safe", async (req, res) => {
  try {
    const fs = require("fs");

    const retentionDays = await getBackupRetentionDays();

    const result = await dbQuery(
      `
        SELECT *
        FROM backend_backups
        WHERE deleted_at IS NULL
          AND created_at < NOW() - ($1::text || ' days')::interval
        ORDER BY created_at ASC
        LIMIT 250
      `,
      [String(retentionDays)]
    );

    const candidates = result.rows;
    const deleted = [];

    for (const backup of candidates) {
      let fileDeleted = false;

      try {
        if (backup.file_path && fs.existsSync(backup.file_path)) {
          fs.unlinkSync(backup.file_path);
          fileDeleted = true;
        }

        const updated = await dbQuery(
          `
            UPDATE backend_backups
            SET
              status = CASE WHEN status = 'completed' THEN 'deleted' ELSE status END,
              deleted_at = NOW(),
              deleted_by = $2,
              deleted_reason = $3,
              file_deleted = true
            WHERE id = $1
            RETURNING id, status, deleted_at AS "deletedAt", file_deleted AS "fileDeleted"
          `,
          [
            backup.id,
            req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
            `Retention cleanup after ${retentionDays} days.`,
          ]
        );

        deleted.push({
          id: backup.id,
          fileDeleted,
          record: updated.rows[0],
        });
      } catch (deleteError) {
        deleted.push({
          id: backup.id,
          fileDeleted: false,
          error: deleteError.message,
        });
      }
    }

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'backup.retention_cleanup', 'backup_retention', 'retention', $3::jsonb, $4, $5)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify({ retentionDays, checked: candidates.length, deleted }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      retentionDays,
      checked: candidates.length,
      deleted,
      message: "Retention cleanup completed.",
    });
  } catch (error) {
    return fail(res, "Failed to run backup retention cleanup", 500, error.message);
  }
});


function quoteDbIdentifierSafe(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function assertPublicTableExists(tableName) {
  const result = await dbQuery(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );

  return Boolean(result.rows[0]);
}

router.get("/database/tables/:tableName/rows", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const search = String(req.query.search || "").trim();

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const columns = columnsResult.rows;
    const quotedTable = quoteDbIdentifierSafe(tableName);

    let whereSql = "";
    let countParams = [];
    let rowsParams = [limit, offset];

    if (search) {
      const searchableColumns = columns.map((column) => {
        return `COALESCE(${quoteDbIdentifierSafe(column.columnName)}::text, '')`;
      });

      if (searchableColumns.length) {
        whereSql = `WHERE (${searchableColumns.join(" || ' ' || ")}) ILIKE $1`;
        countParams = [`%${search}%`];
        rowsParams = [`%${search}%`, limit, offset];
      }
    }

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM ${quotedTable}
      ${whereSql}
    `;

    const rowsSql = `
      SELECT ctid::text AS "__ctid", *
      FROM ${quotedTable}
      ${whereSql}
      LIMIT $${search ? 2 : 1}
      OFFSET $${search ? 3 : 2}
    `;

    const countResult = await dbQuery(countSql, countParams);
    const rowsResult = await dbQuery(rowsSql, rowsParams);

    return ok(res, {
      tableName,
      columns,
      rows: rowsResult.rows,
      pagination: {
        limit,
        offset,
        total: Number(countResult.rows[0]?.count || 0),
        nextOffset: offset + rowsResult.rows.length,
        hasMore: offset + rowsResult.rows.length < Number(countResult.rows[0]?.count || 0),
      },
      search,
    });
  } catch (error) {
    return fail(res, "Failed to load table rows", 500, error.message);
  }
});


function csvEscape(value) {
  if (value === null || value === undefined) return "";
  let output = typeof value === "object" ? JSON.stringify(value) : String(value);
  output = output.replace(/"/g, '""');
  return `"${output}"`;
}

router.get("/database/tables/:tableName/export", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const format = String(req.query.format || "csv").toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 5000), 1), 5000);
    const search = String(req.query.search || "").trim();

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const columns = columnsResult.rows;
    const quotedTable = quoteDbIdentifierSafe(tableName);

    let whereSql = "";
    let rowsParams = [limit];

    if (search) {
      const searchableColumns = columns.map((column) => {
        return `COALESCE(${quoteDbIdentifierSafe(column.columnName)}::text, '')`;
      });

      if (searchableColumns.length) {
        whereSql = `WHERE (${searchableColumns.join(" || ' ' || ")}) ILIKE $1`;
        rowsParams = [`%${search}%`, limit];
      }
    }

    const rowsSql = `
      SELECT ctid::text AS "__ctid", *
      FROM ${quotedTable}
      ${whereSql}
      LIMIT $${search ? 2 : 1}
    `;

    const rowsResult = await dbQuery(rowsSql, rowsParams);
    const rows = rowsResult.rows;

    const safeFileTableName = tableName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileTableName}_${timestamp}.json"`);
      return res.send(JSON.stringify({
        tableName,
        exportedAt: new Date().toISOString(),
        search,
        limit,
        rowCount: rows.length,
        columns,
        rows,
      }, null, 2));
    }

    if (format !== "csv") {
      return fail(res, "Unsupported export format. Use csv or json.", 400);
    }

    const header = columns.map((column) => csvEscape(column.columnName)).join(",");
    const body = rows.map((row) => {
      return columns.map((column) => csvEscape(row[column.columnName])).join(",");
    }).join("\n");

    const csv = `${header}\n${body}\n`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileTableName}_${timestamp}.csv"`);
    return res.send(csv);
  } catch (error) {
    return fail(res, "Failed to export table rows", 500, error.message);
  }
});


const DATABASE_BROWSER_READ_ONLY_TABLES = new Set([
  "backend_admin_audit_logs"
]);

async function getPublicTableColumns(tableName) {
  const result = await dbQuery(
    `
      SELECT
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault",
        is_identity AS "isIdentity",
        is_generated AS "isGenerated"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName]
  );

  return result.rows;
}

function ensureTableWritable(tableName) {
  if (DATABASE_BROWSER_READ_ONLY_TABLES.has(tableName)) {
    const error = new Error("This table is read-only from the Database Browser.");
    error.statusCode = 403;
    throw error;
  }
}

function normalizeDbBrowserValue(value, column) {
  if (value === undefined) return null;
  if (value === "") return null;

  if (column && ["json", "jsonb"].includes(column.dataType)) {
    if (typeof value === "string") {
      try {
        JSON.parse(value);
        return value;
      } catch (error) {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  return value;
}

function valueExpressionForColumn(paramIndex, column) {
  if (column && column.dataType === "jsonb") return `$${paramIndex}::jsonb`;
  if (column && column.dataType === "json") return `$${paramIndex}::json`;
  return `$${paramIndex}`;
}

router.post("/database/tables/:tableName/rows/create-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const input = req.body?.row && typeof req.body.row === "object" ? req.body.row : {};
    const columns = await getPublicTableColumns(tableName);
    const writableColumns = columns.filter((column) => {
      return column.isGenerated !== "ALWAYS" && column.isIdentity !== "YES";
    });

    const columnMap = new Map(writableColumns.map((column) => [column.columnName, column]));
    const entries = Object.entries(input).filter(([key]) => columnMap.has(key));

    if (!entries.length) return fail(res, "No valid writable columns provided", 400);

    const quotedTable = quoteDbIdentifierSafe(tableName);
    const quotedColumns = entries.map(([key]) => quoteDbIdentifierSafe(key));
    const params = [];
    const valueExpressions = [];

    entries.forEach(([key, value], index) => {
      const column = columnMap.get(key);
      params.push(normalizeDbBrowserValue(value, column));
      valueExpressions.push(valueExpressionForColumn(index + 1, column));
    });

    const sql = `
      INSERT INTO ${quotedTable} (${quotedColumns.join(", ")})
      VALUES (${valueExpressions.join(", ")})
      RETURNING ctid::text AS "__ctid", *
    `;

    const result = await dbQuery(sql, params);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.create', 'database_row', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        tableName,
        JSON.stringify({ row: result.rows[0] }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: result.rows[0],
      message: "Row created.",
    });
  } catch (error) {
    return fail(res, "Failed to create row", error.statusCode || 500, error.message);
  }
});

router.post("/database/tables/:tableName/rows/update-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    const rowCtid = String(req.body?.ctid || "").trim();
    const columnName = String(req.body?.columnName || "").trim();
    const value = req.body?.value;

    if (!tableName) return fail(res, "Table name is required", 400);
    if (!rowCtid) return fail(res, "Row ctid is required", 400);
    if (!columnName) return fail(res, "Column name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const columns = await getPublicTableColumns(tableName);
    const column = columns.find((item) => item.columnName === columnName);

    if (!column) return fail(res, "Column not found", 404);
    if (column.isGenerated === "ALWAYS" || column.isIdentity === "YES") {
      return fail(res, "This column cannot be edited", 400);
    }

    const quotedTable = quoteDbIdentifierSafe(tableName);
    const quotedColumn = quoteDbIdentifierSafe(columnName);

    const beforeResult = await dbQuery(
      `
        SELECT ctid::text AS "__ctid", *
        FROM ${quotedTable}
        WHERE ctid = $1::tid
        LIMIT 1
      `,
      [rowCtid]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Row not found", 404);

    const normalizedValue = normalizeDbBrowserValue(value, column);
    const expression = valueExpressionForColumn(1, column);

    const result = await dbQuery(
      `
        UPDATE ${quotedTable}
        SET ${quotedColumn} = ${expression}
        WHERE ctid = $2::tid
        RETURNING ctid::text AS "__ctid", *
      `,
      [normalizedValue, rowCtid]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.update', 'database_row', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}:${rowCtid}:${columnName}`,
        JSON.stringify({ row: before }),
        JSON.stringify({ row: result.rows[0], changedColumn: columnName }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: result.rows[0],
      message: "Row updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update row", error.statusCode || 500, error.message);
  }
});

router.post("/database/tables/:tableName/rows/delete-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    const rowCtid = String(req.body?.ctid || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);
    if (!rowCtid) return fail(res, "Row ctid is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const quotedTable = quoteDbIdentifierSafe(tableName);

    const result = await dbQuery(
      `
        DELETE FROM ${quotedTable}
        WHERE ctid = $1::tid
        RETURNING ctid::text AS "__ctid", *
      `,
      [rowCtid]
    );

    const deleted = result.rows[0];
    if (!deleted) return fail(res, "Row not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.delete', 'database_row', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}:${rowCtid}`,
        JSON.stringify({ row: deleted }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: deleted,
      message: "Row deleted.",
    });
  } catch (error) {
    return fail(res, "Failed to delete row", error.statusCode || 500, error.message);
  }
});


function validateReadOnlySqlQuery(sqlText) {
  const raw = String(sqlText || "").trim();

  if (!raw) {
    return { ok: false, message: "SQL query is required." };
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  const withoutTrailingSemicolon = normalized.replace(/;+\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    return { ok: false, message: "Only one SQL statement is allowed." };
  }

  if (!/^(select|with)\s/i.test(withoutTrailingSemicolon)) {
    return { ok: false, message: "Only SELECT or read-only WITH queries are allowed." };
  }

  const blockedPatterns = [
    /\binsert\b/i,
    /\bupdate\b/i,
    /\bdelete\b/i,
    /\bdrop\b/i,
    /\balter\b/i,
    /\btruncate\b/i,
    /\bcreate\b/i,
    /\bgrant\b/i,
    /\brevoke\b/i,
    /\bcopy\b/i,
    /\bcall\b/i,
    /\bdo\s+\$\$/i,
    /\bexecute\b/i,
    /\bvacuum\b/i,
    /\banalyze\b/i,
    /\breindex\b/i,
    /\bcluster\b/i,
    /\brefresh\s+materialized\b/i,
    /\bpg_sleep\b/i,
    /\bpg_read_file\b/i,
    /\bpg_ls_dir\b/i,
    /\bpg_stat_file\b/i,
    /\bdblink\b/i,
    /\blo_import\b/i,
    /\blo_export\b/i
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(withoutTrailingSemicolon)) {
      return { ok: false, message: "This query contains a blocked keyword or function." };
    }
  }

  return {
    ok: true,
    sql: withoutTrailingSemicolon,
  };
}

router.get("/database/saved-queries-page-data", async (req, res) => {
  try {
    const savedResult = await dbQuery(`
      SELECT
        id,
        name,
        sql_text AS "sqlText",
        description,
        status,
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_saved_queries
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT 250
    `);

    const executionsResult = await dbQuery(`
      SELECT
        id,
        saved_query_id AS "savedQueryId",
        sql_text AS "sqlText",
        status,
        row_count AS "rowCount",
        duration_ms AS "durationMs",
        error_message AS "errorMessage",
        executed_by AS "executedBy",
        created_at AS "createdAt"
      FROM backend_query_executions
      ORDER BY created_at DESC
      LIMIT 100
    `);

    return ok(res, {
      savedQueries: savedResult.rows,
      executions: executionsResult.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load saved queries", 500, error.message);
  }
});

router.post("/database/query/run-safe", async (req, res) => {
  const started = Date.now();
  let executionId = `query_exec_${crypto.randomUUID().replace(/-/g, "")}`;
  let sqlText = String(req.body?.sqlText || "").trim();
  let savedQueryId = req.body?.savedQueryId ? String(req.body.savedQueryId).trim() : null;

  try {
    const validation = validateReadOnlySqlQuery(sqlText);

    if (!validation.ok) {
      await dbQuery(
        `
          INSERT INTO backend_query_executions (
            id,
            saved_query_id,
            sql_text,
            status,
            row_count,
            duration_ms,
            error_message,
            executed_by
          )
          VALUES ($1, $2, $3, 'blocked', 0, $4, $5, $6)
        `,
        [
          executionId,
          savedQueryId,
          sqlText,
          Date.now() - started,
          validation.message,
          req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        ]
      );

      return fail(res, validation.message, 400);
    }

    const limit = Math.min(Math.max(Number(req.body?.limit || 250), 1), 500);
    const wrappedSql = `SELECT * FROM (${validation.sql}) AS goodos_query_result LIMIT $1`;

    const result = await dbQuery(wrappedSql, [limit]);
    const durationMs = Date.now() - started;

    const columns = result.fields.map((field) => ({
      name: field.name,
    }));

    await dbQuery(
      `
        INSERT INTO backend_query_executions (
          id,
          saved_query_id,
          sql_text,
          status,
          row_count,
          duration_ms,
          executed_by
        )
        VALUES ($1, $2, $3, 'completed', $4, $5, $6)
      `,
      [
        executionId,
        savedQueryId,
        validation.sql,
        result.rows.length,
        durationMs,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.run', 'database_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        executionId,
        JSON.stringify({ rowCount: result.rows.length, durationMs, savedQueryId }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      executionId,
      columns,
      rows: result.rows,
      rowCount: result.rows.length,
      durationMs,
      limit,
      sqlText: validation.sql,
    });
  } catch (error) {
    const durationMs = Date.now() - started;

    try {
      await dbQuery(
        `
          INSERT INTO backend_query_executions (
            id,
            saved_query_id,
            sql_text,
            status,
            row_count,
            duration_ms,
            error_message,
            executed_by
          )
          VALUES ($1, $2, $3, 'failed', 0, $4, $5, $6)
        `,
        [
          executionId,
          savedQueryId,
          sqlText,
          durationMs,
          error.message,
          req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        ]
      );
    } catch (auditError) {}

    return fail(res, "Failed to run query", 500, error.message);
  }
});

router.post("/database/query/save-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const sqlText = String(req.body?.sqlText || "").trim();
    const description = String(req.body?.description || "").trim();

    if (!name) return fail(res, "Query name is required", 400);

    const validation = validateReadOnlySqlQuery(sqlText);
    if (!validation.ok) return fail(res, validation.message, 400);

    const id = `saved_query_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_saved_queries (
          id,
          name,
          sql_text,
          description,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, 'active', $5)
        RETURNING
          id,
          name,
          sql_text AS "sqlText",
          description,
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        name,
        validation.sql,
        description,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.save', 'saved_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ name, sqlText: validation.sql }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      savedQuery: result.rows[0],
      message: "Query saved.",
    });
  } catch (error) {
    return fail(res, "Failed to save query", 500, error.message);
  }
});

router.post("/database/saved-queries/:id/delete-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Saved query id is required", 400);

    const result = await dbQuery(
      `
        UPDATE backend_saved_queries
        SET
          status = 'deleted',
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          sql_text AS "sqlText",
          status,
          updated_at AS "updatedAt"
      `,
      [id]
    );

    if (!result.rows[0]) return fail(res, "Saved query not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.delete', 'saved_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      savedQuery: result.rows[0],
      message: "Saved query deleted.",
    });
  } catch (error) {
    return fail(res, "Failed to delete saved query", 500, error.message);
  }
});


const DATABASE_BROWSER_ALLOWED_TYPES = new Set([
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "timestamptz",
  "timestamp",
  "date",
  "jsonb",
  "uuid"
]);

function isSafeDbIdentifier(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(String(value || ""));
}

function validateSchemaColumn(column) {
  const name = String(column?.name || "").trim();
  const type = String(column?.type || "text").trim().toLowerCase();
  const nullable = column?.nullable !== false;
  const unique = column?.unique === true;
  const primaryKey = column?.primaryKey === true;
  const defaultValue = column?.defaultValue;

  if (!isSafeDbIdentifier(name)) {
    return { ok: false, message: `Invalid column name: ${name}` };
  }

  if (!DATABASE_BROWSER_ALLOWED_TYPES.has(type)) {
    return { ok: false, message: `Unsupported column type: ${type}` };
  }

  let definition = `${quoteDbIdentifierSafe(name)} ${type}`;

  if (primaryKey) definition += " PRIMARY KEY";
  if (!nullable || primaryKey) definition += " NOT NULL";
  if (unique && !primaryKey) definition += " UNIQUE";

  if (defaultValue !== undefined && defaultValue !== null && String(defaultValue).trim() !== "") {
    const defaultText = String(defaultValue).trim();

    const allowedDefaults = [
      "now()",
      "gen_random_uuid()",
      "true",
      "false",
      "0",
      "1",
      "CURRENT_TIMESTAMP"
    ];

    if (!allowedDefaults.includes(defaultText) && !/^'.*'$/.test(defaultText) && !/^[0-9]+(\.[0-9]+)?$/.test(defaultText)) {
      return { ok: false, message: `Unsafe default value for ${name}. Use quoted text, number, now(), gen_random_uuid(), true, or false.` };
    }

    definition += ` DEFAULT ${defaultText}`;
  }

  return {
    ok: true,
    name,
    type,
    definition,
  };
}

router.post("/database/schema/create-table-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const columnsInput = Array.isArray(req.body?.columns) ? req.body.columns : [];

    if (!isSafeDbIdentifier(tableName)) {
      return fail(res, "Invalid table name. Use letters, numbers, and underscores only. Must start with a letter or underscore.", 400);
    }

    if (!columnsInput.length) {
      return fail(res, "At least one column is required.", 400);
    }

    const exists = await assertPublicTableExists(tableName);
    if (exists) return fail(res, "Table already exists.", 409);

    const validatedColumns = [];

    for (const column of columnsInput) {
      const validated = validateSchemaColumn(column);
      if (!validated.ok) return fail(res, validated.message, 400);
      validatedColumns.push(validated);
    }

    const hasPrimaryKey = validatedColumns.some((column) => / PRIMARY KEY/.test(column.definition));

    const finalDefinitions = hasPrimaryKey
      ? validatedColumns.map((column) => column.definition)
      : [`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`, ...validatedColumns.map((column) => column.definition)];

    const sql = `
      CREATE TABLE ${quoteDbIdentifierSafe(tableName)} (
        ${finalDefinitions.join(",\n        ")}
      )
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.create_table', 'database_table', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        tableName,
        JSON.stringify({ tableName, columns: columnsInput }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      message: "Table created.",
    });
  } catch (error) {
    return fail(res, "Failed to create table", 500, error.message);
  }
});

router.post("/database/schema/add-column-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const column = req.body?.column || {};

    if (!isSafeDbIdentifier(tableName)) {
      return fail(res, "Invalid table name.", 400);
    }

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found.", 404);

    ensureTableWritable(tableName);

    const validated = validateSchemaColumn(column);
    if (!validated.ok) return fail(res, validated.message, 400);

    const columns = await getPublicTableColumns(tableName);
    if (columns.some((item) => item.columnName === validated.name)) {
      return fail(res, "Column already exists.", 409);
    }

    const sql = `
      ALTER TABLE ${quoteDbIdentifierSafe(tableName)}
      ADD COLUMN ${validated.definition}
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.add_column', 'database_column', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}.${validated.name}`,
        JSON.stringify({ tableName, column }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      columnName: validated.name,
      message: "Column added.",
    });
  } catch (error) {
    return fail(res, "Failed to add column", error.statusCode || 500, error.message);
  }
});

router.post("/database/schema/create-index-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const columnName = String(req.body?.columnName || "").trim();
    const unique = req.body?.unique === true;

    if (!isSafeDbIdentifier(tableName)) return fail(res, "Invalid table name.", 400);
    if (!isSafeDbIdentifier(columnName)) return fail(res, "Invalid column name.", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found.", 404);

    ensureTableWritable(tableName);

    const columns = await getPublicTableColumns(tableName);
    if (!columns.some((item) => item.columnName === columnName)) {
      return fail(res, "Column not found.", 404);
    }

    const indexName = `${tableName}_${columnName}_${unique ? "uniq" : "idx"}`.slice(0, 60);

    const sql = `
      CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteDbIdentifierSafe(indexName)}
      ON ${quoteDbIdentifierSafe(tableName)} (${quoteDbIdentifierSafe(columnName)})
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.create_index', 'database_index', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        indexName,
        JSON.stringify({ tableName, columnName, unique, indexName }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      columnName,
      indexName,
      unique,
      message: "Index created.",
    });
  } catch (error) {
    return fail(res, "Failed to create index", error.statusCode || 500, error.message);
  }
});


router.get("/database/tables/:tableName/metadata", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const qualifiedName = `public.${tableName}`;

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          is_nullable AS "isNullable",
          column_default AS "columnDefault",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const indexesResult = await dbQuery(
      `
        SELECT
          indexname AS "indexName",
          indexdef AS "indexDef"
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
        ORDER BY indexname ASC
      `,
      [tableName]
    );

    const constraintsResult = await dbQuery(
      `
        SELECT
          con.conname AS "constraintName",
          con.contype AS "constraintType",
          CASE con.contype
            WHEN 'p' THEN 'primary_key'
            WHEN 'f' THEN 'foreign_key'
            WHEN 'u' THEN 'unique'
            WHEN 'c' THEN 'check'
            ELSE con.contype::text
          END AS "constraintLabel",
          pg_get_constraintdef(con.oid) AS "definition"
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = $1
        ORDER BY con.contype ASC, con.conname ASC
      `,
      [tableName]
    );

    const foreignKeysResult = await dbQuery(
      `
        SELECT
          con.conname AS "constraintName",
          pg_get_constraintdef(con.oid) AS "definition",
          ref.relname AS "referencedTable"
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE nsp.nspname = 'public'
          AND rel.relname = $1
          AND con.contype = 'f'
        ORDER BY con.conname ASC
      `,
      [tableName]
    );

    const statsResult = await dbQuery(
      `
        SELECT
          COALESCE(n_live_tup, 0)::bigint AS "estimatedRows",
          COALESCE(seq_scan, 0)::bigint AS "seqScan",
          COALESCE(idx_scan, 0)::bigint AS "idxScan",
          COALESCE(n_tup_ins, 0)::bigint AS "rowsInserted",
          COALESCE(n_tup_upd, 0)::bigint AS "rowsUpdated",
          COALESCE(n_tup_del, 0)::bigint AS "rowsDeleted",
          last_vacuum AS "lastVacuum",
          last_autovacuum AS "lastAutovacuum",
          last_analyze AS "lastAnalyze",
          last_autoanalyze AS "lastAutoanalyze"
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
          AND relname = $1
        LIMIT 1
      `,
      [tableName]
    );

    const sizeResult = await dbQuery(
      `
        SELECT
          pg_total_relation_size($1::regclass)::bigint AS "totalSizeBytes",
          pg_relation_size($1::regclass)::bigint AS "tableSizeBytes",
          pg_indexes_size($1::regclass)::bigint AS "indexSizeBytes",
          pg_size_pretty(pg_total_relation_size($1::regclass)) AS "totalSizePretty",
          pg_size_pretty(pg_relation_size($1::regclass)) AS "tableSizePretty",
          pg_size_pretty(pg_indexes_size($1::regclass)) AS "indexSizePretty"
      `,
      [qualifiedName]
    );

    return ok(res, {
      tableName,
      columns: columnsResult.rows,
      indexes: indexesResult.rows,
      constraints: constraintsResult.rows,
      foreignKeys: foreignKeysResult.rows,
      stats: statsResult.rows[0] || {},
      size: sizeResult.rows[0] || {},
      counts: {
        columns: columnsResult.rows.length,
        indexes: indexesResult.rows.length,
        constraints: constraintsResult.rows.length,
        foreignKeys: foreignKeysResult.rows.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load table metadata", 500, error.message);
  }
});

module.exports = router;
