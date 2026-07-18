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
  let consumedSignedUrlId = null;

  async function releaseConsumption() {
    if (!consumedSignedUrlId) return;

    await dbQuery(
      `
        UPDATE backend_storage_signed_urls
        SET
          download_count =
            GREATEST(
              download_count - 1,
              0
            )
        WHERE id = $1
      `,
      [consumedSignedUrlId]
    ).catch(() => {});
  }

  try {
    const token =
      String(
        req.params.token || ""
      ).trim();

    if (!token) {
      return res
        .status(400)
        .send(
          "Missing signed URL token."
        );
    }

    const tokenHash =
      hashToken(token);

    const consumption =
      await dbQuery(
        `
          UPDATE
            backend_storage_signed_urls
            AS signed_url

          SET
            download_count =
              signed_url.download_count + 1,

            last_used_at =
              NOW()

          WHERE signed_url.token_hash =
                $1

            AND signed_url.status =
                'active'

            AND signed_url.revoked_at
                IS NULL

            AND signed_url.expires_at >
                NOW()

            AND (
              signed_url.max_downloads
                IS NULL

              OR signed_url.download_count <
                 signed_url.max_downloads
            )

          RETURNING
            signed_url.id
              AS "signedUrlId",

            signed_url.file_id
              AS "fileId"
        `,
        [tokenHash]
      );

    const consumed =
      consumption.rows[0];

    if (!consumed) {
      return res
        .status(403)
        .send(
          "Signed URL is invalid, expired, disabled, or exhausted."
        );
    }

    consumedSignedUrlId =
      consumed.signedUrlId;

    const fileResult =
      await dbQuery(
        `
          SELECT
            file_record.id,
            file_record.filename,

            file_record.original_filename
              AS "originalFilename",

            file_record.mime_type
              AS "mimeType",

            file_record.storage_path
              AS "storagePath",

            file_record.status,

            file_record.file_deleted
              AS "fileDeleted"

          FROM backend_storage_files
               AS file_record

          WHERE file_record.id =
                $1

            AND file_record.status =
                'active'

            AND COALESCE(
                  file_record.file_deleted,
                  false
                ) = false

          LIMIT 1
        `,
        [consumed.fileId]
      );

    const file =
      fileResult.rows[0];

    if (!file) {
      await releaseConsumption();

      return res
        .status(404)
        .send(
          "File is not available."
        );
    }

    const storageRoot =
      path.resolve(
        process.cwd(),
        "storage"
      );

    const fullPath =
      path.resolve(
        file.storagePath || ""
      );

    const insideStorage =
      fullPath === storageRoot ||
      fullPath.startsWith(
        storageRoot + path.sep
      );

    if (!insideStorage) {
      await releaseConsumption();

      return res
        .status(403)
        .send(
          "Invalid storage path."
        );
    }

    if (!fs.existsSync(fullPath)) {
      await releaseConsumption();

      return res
        .status(404)
        .send(
          "File missing on server."
        );
    }

    const downloadName =
      String(
        file.originalFilename ||
        file.filename ||
        "download"
      )
      .replace(/[\r\n"]/g, "");

    res.setHeader(
      "Content-Type",
      file.mimeType ||
      "application/octet-stream"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`
    );

    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    return res.sendFile(fullPath);
  } catch (error) {
    await releaseConsumption();

    console.error(
      "Signed storage download failed:",
      error
    );

    return res
      .status(500)
      .send(
        "Signed URL failed."
      );
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
