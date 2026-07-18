"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const multer = require("multer");
const gateway = require("../services/api-gateway-v2.service");
const storage = require("../services/storage-v2.service");

fs.mkdirSync(storage.STORAGE_TMP, { recursive: true, mode: 0o750 });

const upload = multer({
  dest: storage.STORAGE_TMP,
  limits: {
    files: 1,
    fileSize: 104857600,
  },
});

const router = express.Router();

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw storage.statusError(400, "metadata must be a valid JSON object.", "STORAGE_METADATA_INVALID");
  }
}

function requestContext(request) {
  const apiKey = request.goodosApiKey || {};
  return {
    requestId: request.gatewayContext?.requestId || null,
    organizationId: apiKey.organizationId || "org_goodos",
    projectId: apiKey.projectId || null,
    environmentId: apiKey.environmentId || null,
    apiKeyId: apiKey.id || null,
    actorType: "api_key",
    actorId: apiKey.id || null,
    sourceIp: request.ip || request.socket?.remoteAddress || null,
    userAgent: request.get("User-Agent") || null,
  };
}

async function logResult(request, values) {
  await storage.logAccess({
    ...requestContext(request),
    ...values,
  }).catch((error) => {
    console.error("Storage access ledger failed:", error.message);
  });
}

function errorResponse(request, response, error) {
  const status = error.statusCode || 500;
  return response.status(status).json({
    success: false,
    code: error.code || "STORAGE_V2_REQUEST_FAILED",
    message: error.message || "Storage V2 request failed.",
    requestId: request.gatewayContext?.requestId || null,
  });
}

router.get(
  "/health",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const buckets = await storage.listBuckets(requestContext(request));
      return response.json({
        success: true,
        service: "GoodOS Storage Control Plane V2",
        status: "ready",
        providers: {
          local: "ready",
          s3Compatible: "adapter_ready",
        },
        bucketCount: buckets.length,
        requestId: request.gatewayContext.requestId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.get(
  "/buckets",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const context = requestContext(request);
      const buckets = await storage.listBuckets(context);
      await logResult(request, {
        operation: "bucket.list",
        statusCode: 200,
        metadata: { count: buckets.length },
      });
      return response.json({
        success: true,
        requestId: context.requestId,
        buckets,
        total: buckets.length,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.get(
  "/buckets/:bucketId/objects",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const result = await storage.listObjects({
        bucketId: request.params.bucketId,
        limit: request.query.limit,
        offset: request.query.offset,
        prefix: request.query.prefix || "",
        includeDeleted: request.query.includeDeleted === "true",
      });
      await logResult(request, {
        operation: "object.list",
        bucketId: request.params.bucketId,
        statusCode: 200,
        metadata: {
          total: result.total,
          prefix: request.query.prefix || "",
        },
      });
      return response.json({
        success: true,
        requestId: request.gatewayContext.requestId,
        ...result,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.post(
  "/buckets/:bucketId/objects",
  gateway.requireScope("write:storage"),
  upload.single("file"),
  async (request, response) => {
    let tempPath = request.file?.path || null;
    try {
      if (!request.file) {
        throw storage.statusError(400, "A multipart file field named file is required.", "STORAGE_FILE_REQUIRED");
      }

      const context = requestContext(request);
      const object = await storage.putObject({
        bucketId: request.params.bucketId,
        objectKey: request.body?.objectKey || request.body?.object_key || request.file.originalname,
        originalFilename: request.file.originalname,
        mimeType: request.file.mimetype,
        tempPath,
        expectedChecksum: request.get("X-Content-SHA256") || null,
        cacheControl: request.body?.cacheControl || request.body?.cache_control || null,
        contentDisposition: request.body?.contentDisposition || request.body?.content_disposition || null,
        contentEncoding: request.body?.contentEncoding || request.body?.content_encoding || null,
        storageClass: request.body?.storageClass || request.body?.storage_class || null,
        displayName: request.body?.displayName || request.body?.display_name || request.file.originalname,
        metadata: parseMetadata(request.body?.metadata),
        createdBy: null,
        ...context,
      });

      await logResult(request, {
        operation: "object.upload",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: 201,
        bytesTransferred: object.size_bytes,
        metadata: {
          versionId: object.version_id,
          versionNumber: object.version_number,
          checksumSha256: object.checksum_sha256,
        },
      });

      return response.status(201).json({
        success: true,
        requestId: context.requestId,
        object,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    } finally {
      if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
);

router.get(
  "/objects/:fileId",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const object = await storage.getFileById(request.params.fileId);
      await logResult(request, {
        operation: "object.metadata.read",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: 200,
      });
      return response.json({
        success: true,
        requestId: request.gatewayContext.requestId,
        object,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.get(
  "/objects/:fileId/download",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const object = await storage.getFileById(request.params.fileId);
      const descriptor = await storage.resolveDownload(object, 300);
      await storage.touchFileAccess(object.id);
      await logResult(request, {
        operation: "object.download",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: descriptor.type === "redirect" ? 302 : 200,
        bytesTransferred: descriptor.type === "local" ? object.size_bytes : 0,
      });

      if (descriptor.type === "redirect") {
        response.set("Cache-Control", "private, no-store");
        return response.redirect(302, descriptor.url);
      }

      const downloadName = String(object.original_filename || object.filename || "download")
        .replace(/[\r\n"]/g, "");
      response.set("Content-Type", object.mime_type || "application/octet-stream");
      response.set("Content-Disposition", `attachment; filename="${downloadName}"`);
      response.set("Cache-Control", "private, no-store");
      response.set("ETag", `"${object.checksum_sha256 || object.provider_etag || object.id}"`);
      response.set("X-Content-Type-Options", "nosniff");
      return response.sendFile(path.resolve(descriptor.path));
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.post(
  "/objects/:fileId/signed-url",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const context = requestContext(request);
      const signedUrl = await storage.createSignedUrl({
        fileId: request.params.fileId,
        expiresSeconds: request.body?.expiresSeconds || request.body?.expires_seconds,
        maxDownloads: request.body?.maxDownloads ?? request.body?.max_downloads ?? 1,
        allowedIp: request.body?.allowedIp || request.body?.allowed_ip || null,
        userAgentLimit: request.body?.userAgentLimit || request.body?.user_agent_limit || null,
        createdBy: null,
        ...context,
      });
      const object = await storage.getFileById(request.params.fileId);
      await logResult(request, {
        operation: "signed_url.create",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: 201,
        metadata: {
          signedUrlId: signedUrl.id,
          expiresInSeconds: signedUrl.expiresInSeconds,
          maxDownloads: signedUrl.maxDownloads,
        },
      });
      return response.status(201).json({
        success: true,
        requestId: context.requestId,
        signedUrl,
        warning: "The raw signed token is returned once in this response.",
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.get(
  "/objects/:fileId/versions",
  gateway.requireScope("read:storage"),
  async (request, response) => {
    try {
      const versions = await storage.listVersions(request.params.fileId);
      return response.json({
        success: true,
        requestId: request.gatewayContext.requestId,
        versions,
        total: versions.length,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.post(
  "/objects/:fileId/versions/:versionRecordId/restore",
  gateway.requireScope("write:storage"),
  async (request, response) => {
    try {
      const context = requestContext(request);
      const object = await storage.restoreVersion({
        fileId: request.params.fileId,
        versionRecordId: request.params.versionRecordId,
        createdBy: null,
        actorType: "api_key",
      });
      await logResult(request, {
        operation: "object.version.restore",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: 201,
        metadata: {
          restoredFromVersionRecordId: request.params.versionRecordId,
          newVersionId: object.version_id,
        },
      });
      return response.status(201).json({
        success: true,
        requestId: context.requestId,
        object,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

router.delete(
  "/objects/:fileId",
  gateway.requireScope("write:storage"),
  async (request, response) => {
    try {
      const object = await storage.getFileById(request.params.fileId);
      const result = await storage.softDeleteObject({
        fileId: request.params.fileId,
        actorId: request.goodosApiKey?.id || null,
        reason: request.body?.reason || "Deleted through Storage V2 API",
      });
      await logResult(request, {
        operation: "object.delete",
        bucketId: object.bucket_id,
        bucketName: object.bucketName,
        fileId: object.id,
        objectKey: object.objectKey,
        provider: object.provider,
        statusCode: 200,
      });
      return response.json({
        success: true,
        requestId: request.gatewayContext.requestId,
        result,
      });
    } catch (error) {
      return errorResponse(request, response, error);
    }
  }
);

module.exports = router;
