"use strict";

const path = require("path");
const express = require("express");
const storage = require("../services/storage-v2.service");
const policyEngine = require("../services/policy-engine-v2.service");

const router = express.Router();

function sourceIp(request) {
  return request.ip || request.socket?.remoteAddress || null;
}

function publicHeaders(response, object) {
  response.set("Content-Type", object.mime_type || "application/octet-stream");
  response.set(
    "Cache-Control",
    object.cache_control || object.bucketCacheControl || "public, max-age=3600"
  );
  response.set("ETag", `"${object.checksum_sha256 || object.provider_etag || object.id}"`);
  response.set("X-Content-Type-Options", "nosniff");
  if (object.content_disposition) response.set("Content-Disposition", object.content_disposition);
  if (object.content_encoding) response.set("Content-Encoding", object.content_encoding);
}

async function logPublic(request, object, operation, statusCode, metadata = {}) {
  await storage.logAccess({
    requestId: request.get("X-Request-ID") || storage.identifier("publicreq"),
    organizationId: object.organization_id || "org_goodos",
    projectId: object.project_id || null,
    environmentId: object.environment_id || null,
    actorType: "public",
    actorId: null,
    operation,
    bucketId: object.bucket_id,
    bucketName: object.bucketName,
    fileId: object.id,
    objectKey: object.objectKey,
    provider: object.provider,
    statusCode,
    bytesTransferred: statusCode === 200 ? Number(object.size_bytes || 0) : 0,
    sourceIp: sourceIp(request),
    userAgent: request.get("User-Agent") || null,
    metadata,
  }).catch((error) => {
    console.error("Public storage access ledger failed:", error.message);
  });
}

router.get("/health", (request, response) => {
  return response.json({
    success: true,
    service: "GoodOS Storage CDN V2",
    status: "ready",
    timestamp: new Date().toISOString(),
  });
});

router.get("/public/:bucketName/*", async (request, response) => {
  try {
    const bucket = await storage.loadBucketByName(request.params.bucketName);
    const publicRead = bucket.public_read_enabled === true || bucket.visibility === "public";
    if (!publicRead) {
      return response.status(404).json({
        success: false,
        message: "Public object not found.",
      });
    }

    const objectKey = storage.safeObjectKey(request.params[0]);
    const object = await storage.getLatestObjectByKey(bucket.id, objectKey);

    const decision = await policyEngine.evaluatePolicy({
      organizationId: object.organization_id || "org_goodos",
      projectId: object.project_id || null,
      environmentId: object.environment_id || null,
      targetType: "storage",
      targetId: "public",
      operation: "GET",
      actorType: "public",
      actorId: sourceIp(request),
      requestId: request.get("X-Request-ID") || storage.identifier("publicreq"),
      request: {
        method: "GET",
        path: request.originalUrl,
        sourceIp: sourceIp(request),
        headers: request.headers,
      },
      attributes: {
        publicRead: true,
        bucketId: bucket.id,
        bucketName: bucket.name,
        objectKey,
      },
      simulated: false,
      logEvaluation: true,
    });

    if (!decision.allowed) {
      await logPublic(request, object, "public.read", 403, {
        policyId: decision.policyId,
        reason: decision.reason,
      });
      return response.status(403).json({
        success: false,
        code: "POLICY_DENIED",
        message: decision.reason || "Public storage read denied.",
      });
    }

    const descriptor = await storage.resolveDownload(object, 300);
    await storage.touchFileAccess(object.id);
    await logPublic(request, object, "public.read", descriptor.type === "redirect" ? 302 : 200, {
      policyId: decision.policyId,
      engineVersion: decision.engineVersion,
    });

    response.set("X-GoodOS-Policy-Decision", decision.decision);
    response.set("X-GoodOS-Policy-Engine", decision.engineVersion);
    if (decision.policyId) response.set("X-GoodOS-Policy-ID", decision.policyId);

    if (descriptor.type === "redirect") {
      response.set("Cache-Control", "public, max-age=60");
      return response.redirect(302, descriptor.url);
    }

    publicHeaders(response, object);
    return response.sendFile(path.resolve(descriptor.path));
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error("Storage CDN public read failed:", error);
    return response.status(status).json({
      success: false,
      code: error.code || "STORAGE_PUBLIC_READ_FAILED",
      message: status === 404 ? "Public object not found." : error.message,
    });
  }
});

router.get("/signed/:token", async (request, response) => {
  let consumption = null;
  try {
    consumption = await storage.consumeSignedUrl({
      token: request.params.token,
      sourceIp: sourceIp(request),
      userAgent: request.get("User-Agent") || null,
    });

    const object = await storage.getFileById(consumption.fileId);
    const descriptor = await storage.resolveDownload(object, 300);
    await storage.touchFileAccess(object.id);
    await storage.logAccess({
      requestId: request.get("X-Request-ID") || storage.identifier("signedreq"),
      organizationId: object.organization_id || "org_goodos",
      projectId: object.project_id || null,
      environmentId: object.environment_id || null,
      actorType: "signed_url",
      actorId: consumption.id,
      operation: "signed_url.download",
      bucketId: object.bucket_id,
      bucketName: object.bucketName,
      fileId: object.id,
      objectKey: object.objectKey,
      provider: object.provider,
      statusCode: descriptor.type === "redirect" ? 302 : 200,
      bytesTransferred: descriptor.type === "local" ? Number(object.size_bytes || 0) : 0,
      sourceIp: sourceIp(request),
      userAgent: request.get("User-Agent") || null,
      metadata: { signedUrlId: consumption.id },
    }).catch(() => {});

    response.set("Cache-Control", "private, no-store");
    response.set("X-Content-Type-Options", "nosniff");

    if (descriptor.type === "redirect") {
      return response.redirect(302, descriptor.url);
    }

    const downloadName = String(object.original_filename || object.filename || "download")
      .replace(/[\r\n"]/g, "");
    response.set("Content-Type", object.mime_type || "application/octet-stream");
    response.set("Content-Disposition", `attachment; filename="${downloadName}"`);
    response.set("ETag", `"${object.checksum_sha256 || object.provider_etag || object.id}"`);
    return response.sendFile(path.resolve(descriptor.path));
  } catch (error) {
    if (consumption?.id) await storage.releaseSignedConsumption(consumption.id);
    const status = error.statusCode || 500;
    if (status >= 500) console.error("Storage signed download failed:", error);
    return response.status(status).json({
      success: false,
      code: error.code || "STORAGE_SIGNED_DOWNLOAD_FAILED",
      message: error.message || "Signed storage download failed.",
    });
  }
});

module.exports = router;
