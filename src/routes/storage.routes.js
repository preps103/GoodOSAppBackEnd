const express = require("express");
const fs = require("fs");
const path = require("path");
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

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

router.get("/signed/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).send("Missing signed URL token.");
    }

    const tokenHash = hashToken(token);

    const result = await dbQuery(
      `
        SELECT
          s.id AS "signedUrlId",
          s.status AS "signedUrlStatus",
          s.expires_at AS "expiresAt",
          s.max_downloads AS "maxDownloads",
          s.download_count AS "downloadCount",
          f.id AS "fileId",
          f.filename,
          f.original_filename AS "originalFilename",
          f.mime_type AS "mimeType",
          f.storage_path AS "storagePath",
          f.status AS "fileStatus"
        FROM backend_storage_signed_urls s
        JOIN backend_storage_files f ON f.id = s.file_id
        WHERE s.token_hash = $1
        LIMIT 1
      `,
      [tokenHash]
    );

    const record = result.rows[0];

    if (!record) return res.status(404).send("Signed URL not found.");
    if (record.signedUrlStatus !== "active") return res.status(403).send("Signed URL is disabled.");
    if (record.fileStatus !== "active") return res.status(403).send("File is not active.");
    if (new Date(record.expiresAt).getTime() < Date.now()) return res.status(403).send("Signed URL expired.");

    if (record.maxDownloads && Number(record.downloadCount || 0) >= Number(record.maxDownloads)) {
      return res.status(403).send("Signed URL download limit reached.");
    }

    const storageRoot = path.resolve(process.cwd(), "storage");
    const fullPath = path.resolve(record.storagePath || "");

    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).send("Invalid storage path.");
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send("File missing on server.");
    }

    await dbQuery(
      `
        UPDATE backend_storage_signed_urls
        SET download_count = download_count + 1,
            last_used_at = NOW()
        WHERE id = $1
      `,
      [record.signedUrlId]
    );

    const downloadName = String(record.originalFilename || record.filename || "download").replace(/"/g, "");

    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

    return res.sendFile(fullPath);
  } catch (error) {
    console.error("Signed storage download failed:", error);
    return res.status(500).send("Signed URL failed.");
  }
});



router.get("/public/:bucketName/*", async (req, res) => {
  try {
    const bucketName = String(req.params.bucketName || "").trim();
    const objectKey = decodeURIComponent(String(req.params[0] || "")).replace(/^\/+/, "");

    if (!bucketName || !objectKey) {
      return res.status(400).json({
        success: false,
        message: "Bucket name and object key are required.",
      });
    }

    if (objectKey.includes("..")) {
      return res.status(400).json({
        success: false,
        message: "Invalid object key.",
      });
    }

    const result = await dbQuery(
      `
        SELECT
          f.id,
          f.filename,
          f.original_filename AS "originalFilename",
          f.mime_type AS "mimeType",
          f.size_bytes AS "sizeBytes",
          f.storage_path AS "storagePath",
          f.object_key AS "objectKey",
          f.checksum_sha256 AS "checksumSha256",
          f.cache_control AS "cacheControl",
          f.content_disposition AS "contentDisposition",
          b.name AS "bucketName",
          b.visibility,
          b.public_read_enabled AS "publicReadEnabled",
          b.cache_control AS "bucketCacheControl"
        FROM backend_storage_files f
        JOIN backend_storage_buckets b ON b.id = f.bucket_id
        WHERE b.name = $1
          AND f.status = 'active'
          AND COALESCE(f.file_deleted, false) = false
          AND (
            f.object_key = $2
            OR f.filename = $2
            OR f.storage_path LIKE $3
          )
          AND (b.public_read_enabled = true OR b.visibility = 'public')
        LIMIT 1
      `,
      [bucketName, objectKey, `%/${objectKey}`]
    );

    const record = result.rows[0];

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Public object not found.",
      });
    }

    const storageRoot = path.resolve(process.cwd(), "storage");
    const fullPath = path.resolve(record.storagePath || "");

    if (!fullPath.startsWith(storageRoot)) {
      return res.status(403).json({
        success: false,
        message: "Invalid storage path.",
      });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({
        success: false,
        message: "Object file is missing from disk.",
      });
    }

    res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", record.cacheControl || record.bucketCacheControl || "public, max-age=3600");
    res.setHeader("ETag", `"${record.checksumSha256 || record.id}"`);

    if (record.contentDisposition) {
      res.setHeader("Content-Disposition", record.contentDisposition);
    }

    return res.sendFile(fullPath);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Public storage object failed.",
      detail: error.message,
    });
  }
});

module.exports = router;
