"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const database = require("../config/database");
const { logAudit } = require("../services/audit.service");
const storage = require("../services/storage-v2.service");

const router = express.Router();

function query(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  throw new Error("Database query function not found");
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function text(value, max = 500) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function bool(value, fallback = false) {
  if ([true, "true", 1, "1"].includes(value)) return true;
  if ([false, "false", 0, "0"].includes(value)) return false;
  return fallback;
}

function object(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return fallback;
}

function stringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function envReference(value) {
  const ref = text(value, 180);
  if (!ref) return null;
  if (!/^env:\/\/[A-Z0-9_]+$/i.test(ref)) {
    const error = new Error("Credential references must use env://VARIABLE_NAME. Raw credentials are not accepted.");
    error.statusCode = 400;
    throw error;
  }
  return ref;
}

async function adminRequired(request, response, next) {
  try {
    const result = await query(
      `
        SELECT account.platform_role, membership.role AS organization_role
        FROM users account
        JOIN backend_organization_memberships membership ON membership.user_id = account.id
        WHERE account.id = $1::uuid
          AND account.status = 'active'
          AND membership.organization_id = $2
          AND membership.status = 'active'
        LIMIT 1
      `,
      [request.user.id, request.tenantContext.organizationId]
    );

    const identity = result.rows[0];
    const permitted = identity && (
      ["owner", "admin"].includes(identity.platform_role) ||
      ["owner", "admin"].includes(identity.organization_role)
    );

    if (!permitted) {
      return response.status(403).json({
        success: false,
        code: "STORAGE_ADMIN_REQUIRED",
        message: "Owner or administrator access is required.",
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function audit(request, action, entityType, entityId, metadata = {}) {
  return logAudit({
    userId: request.user.id,
    appId: "goodos",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: {
      organizationId: request.tenantContext.organizationId,
      projectId: request.tenantContext.projectId,
      environmentId: request.tenantContext.environmentId,
      ...metadata,
    },
  });
}

router.get("/health", async (request, response) => {
  try {
    const result = await query(
      `
        SELECT
          to_regclass('public.backend_storage_provider_configs') IS NOT NULL AS providers,
          to_regclass('public.backend_storage_object_versions') IS NOT NULL AS versions,
          to_regclass('public.backend_storage_access_logs') IS NOT NULL AS access_ledger,
          to_regclass('public.backend_storage_lifecycle_runs') IS NOT NULL AS lifecycle,
          to_regclass('public.backend_storage_signed_urls') IS NOT NULL AS signed_urls
      `
    );
    const components = result.rows[0] || {};
    const ready = Object.values(components).every(Boolean);
    return response.status(ready ? 200 : 503).json({
      success: ready,
      service: "GoodOS Storage Control Plane V2",
      status: ready ? "ready" : "incomplete",
      components,
      adapters: {
        local: "ready",
        s3Compatible: "ready_not_configured",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return response.status(500).json({
      success: false,
      status: "failed",
      message: error.message,
    });
  }
});

router.use(authRequired, tenantContext, adminRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const organizationId = request.tenantContext.organizationId;
    const result = await query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM backend_storage_provider_configs WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active') AS active_providers,
          (SELECT COUNT(*)::int FROM backend_storage_buckets WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active') AS active_buckets,
          (SELECT COUNT(*)::int FROM backend_storage_files WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active' AND file_deleted = FALSE AND is_latest_version = TRUE) AS active_objects,
          (SELECT COALESCE(SUM(size_bytes),0)::bigint FROM backend_storage_files WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active' AND file_deleted = FALSE AND is_latest_version = TRUE) AS active_bytes,
          (SELECT COUNT(*)::int FROM backend_storage_signed_urls WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active' AND expires_at > NOW()) AS active_signed_urls,
          (SELECT COUNT(*)::int FROM backend_storage_access_logs WHERE COALESCE(organization_id, 'org_goodos') = $1 AND created_at >= NOW() - INTERVAL '24 hours') AS access_events_24h,
          (SELECT COUNT(*)::int FROM backend_storage_lifecycle_runs WHERE COALESCE(organization_id, 'org_goodos') = $1 AND started_at >= NOW() - INTERVAL '24 hours') AS lifecycle_runs_24h
      `,
      [organizationId]
    );

    return response.json({
      success: true,
      organizationId,
      storage: result.rows[0] || {},
      publicApiBase: "https://backend.goodos.app/api/v2/storage",
      cdnBase: "https://backend.goodos.app/storage/v2",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/providers", async (request, response, next) => {
  try {
    const result = await query(
      `
        SELECT
          id, name, provider, status,
          endpoint_url AS "endpointUrl",
          region,
          bucket_name AS "bucketName",
          access_key_prefix AS "accessKeyPrefix",
          access_key_ref AS "accessKeyRef",
          secret_key_ref AS "secretKeyRef",
          session_token_ref AS "sessionTokenRef",
          cdn_base_url AS "cdnBaseUrl",
          path_style AS "pathStyle",
          force_ssl AS "forceSsl",
          health_status AS "healthStatus",
          last_health_check_at AS "lastHealthCheckAt",
          last_health_error AS "lastHealthError",
          default_cache_control AS "defaultCacheControl",
          signed_url_ttl_seconds AS "signedUrlTtlSeconds",
          max_upload_bytes AS "maxUploadBytes",
          read_only AS "readOnly",
          capabilities_json AS "capabilities",
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM backend_storage_provider_configs
        WHERE COALESCE(organization_id, 'org_goodos') = $1
        ORDER BY created_at
      `,
      [request.tenantContext.organizationId]
    );
    return response.json({ success: true, providers: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/providers", async (request, response, next) => {
  try {
    const provider = text(request.body?.provider || "local", 30).toLowerCase();
    if (!["local", "s3", "r2", "minio", "spaces", "wasabi"].includes(provider)) {
      return response.status(400).json({ success: false, message: "Unsupported storage provider type." });
    }

    const name = text(request.body?.name || `${provider.toUpperCase()} Provider`, 180);
    const id = identifier(`storageprovider_${provider}`);
    const accessKeyRef = provider === "local" ? null : envReference(request.body?.accessKeyRef || request.body?.access_key_ref);
    const secretKeyRef = provider === "local" ? null : envReference(request.body?.secretKeyRef || request.body?.secret_key_ref);
    const sessionTokenRef = provider === "local" ? null : envReference(request.body?.sessionTokenRef || request.body?.session_token_ref);

    if (provider !== "local" && (!accessKeyRef || !secretKeyRef)) {
      return response.status(400).json({
        success: false,
        message: "S3-compatible providers require accessKeyRef and secretKeyRef using env:// references.",
      });
    }

    const result = await query(
      `
        INSERT INTO backend_storage_provider_configs (
          id, name, provider, status, endpoint_url, region, bucket_name,
          access_key_prefix, access_key_ref, secret_key_ref, session_token_ref,
          secret_ref, cdn_base_url, path_style, force_ssl, health_status,
          default_cache_control, signed_url_ttl_seconds, max_upload_bytes,
          read_only, capabilities_json, metadata_json, organization_id,
          project_id, environment_id, created_by
        )
        VALUES (
          $1,$2,$3,'active',NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7,$8,$9,$10,
          $9,NULLIF($11,''),$12,$13,'unknown',$14,$15,$16,$17,$18::jsonb,$19::jsonb,
          $20,$21,$22,$23::uuid
        )
        RETURNING id, name, provider, status, endpoint_url AS "endpointUrl",
          region, bucket_name AS "bucketName", access_key_ref AS "accessKeyRef",
          secret_key_ref AS "secretKeyRef", session_token_ref AS "sessionTokenRef",
          health_status AS "healthStatus", created_at AS "createdAt"
      `,
      [
        id,
        name,
        provider,
        text(request.body?.endpointUrl || request.body?.endpoint_url, 500),
        text(request.body?.region || (provider === "local" ? "local" : "us-east-1"), 100),
        text(request.body?.bucketName || request.body?.bucket_name, 180),
        accessKeyRef ? accessKeyRef.replace(/^env:\/\//, "").slice(0, 8) : null,
        accessKeyRef,
        secretKeyRef,
        sessionTokenRef,
        text(request.body?.cdnBaseUrl || request.body?.cdn_base_url, 500),
        bool(request.body?.pathStyle ?? request.body?.path_style, true),
        bool(request.body?.forceSsl ?? request.body?.force_ssl, true),
        text(request.body?.defaultCacheControl || request.body?.default_cache_control || "private, max-age=0", 200),
        integer(request.body?.signedUrlTtlSeconds || request.body?.signed_url_ttl_seconds, 900, 30, 604800),
        integer(request.body?.maxUploadBytes || request.body?.max_upload_bytes, 104857600, 1024, 10737418240),
        bool(request.body?.readOnly ?? request.body?.read_only, false),
        JSON.stringify({
          read: true,
          write: !bool(request.body?.readOnly ?? request.body?.read_only, false),
          delete: !bool(request.body?.readOnly ?? request.body?.read_only, false),
          versions: true,
          signedUrls: true,
          s3Compatible: provider !== "local",
        }),
        JSON.stringify(object(request.body?.metadata, { phase: 18 })),
        request.tenantContext.organizationId,
        request.tenantContext.projectId,
        request.tenantContext.environmentId,
        request.user.id,
      ]
    );

    await audit(request, "storage.provider.created", "storage_provider", id, { provider, name });
    return response.status(201).json({
      success: true,
      provider: result.rows[0],
      note: "Only environment-variable references are stored. Raw credentials are never accepted or returned.",
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/providers/:providerId", async (request, response, next) => {
  try {
    const currentResult = await query(
      `SELECT * FROM backend_storage_provider_configs WHERE id = $1 AND COALESCE(organization_id, 'org_goodos') = $2 LIMIT 1`,
      [request.params.providerId, request.tenantContext.organizationId]
    );
    const current = currentResult.rows[0];
    if (!current) return response.status(404).json({ success: false, message: "Storage provider was not found." });

    const accessKeyRef = request.body?.accessKeyRef === undefined && request.body?.access_key_ref === undefined
      ? current.access_key_ref
      : envReference(request.body?.accessKeyRef || request.body?.access_key_ref);
    const secretKeyRef = request.body?.secretKeyRef === undefined && request.body?.secret_key_ref === undefined
      ? current.secret_key_ref
      : envReference(request.body?.secretKeyRef || request.body?.secret_key_ref);
    const sessionTokenRef = request.body?.sessionTokenRef === undefined && request.body?.session_token_ref === undefined
      ? current.session_token_ref
      : envReference(request.body?.sessionTokenRef || request.body?.session_token_ref);

    const result = await query(
      `
        UPDATE backend_storage_provider_configs
        SET
          name = $3,
          status = $4,
          endpoint_url = NULLIF($5,''),
          region = NULLIF($6,''),
          bucket_name = NULLIF($7,''),
          access_key_ref = $8,
          secret_key_ref = $9,
          session_token_ref = $10,
          secret_ref = $9,
          cdn_base_url = NULLIF($11,''),
          path_style = $12,
          force_ssl = $13,
          default_cache_control = $14,
          signed_url_ttl_seconds = $15,
          max_upload_bytes = $16,
          read_only = $17,
          metadata_json = $18::jsonb,
          health_status = 'unknown',
          last_health_error = NULL,
          updated_at = NOW()
        WHERE id = $1 AND COALESCE(organization_id, 'org_goodos') = $2
        RETURNING id, name, provider, status, endpoint_url AS "endpointUrl", region,
          bucket_name AS "bucketName", access_key_ref AS "accessKeyRef",
          secret_key_ref AS "secretKeyRef", session_token_ref AS "sessionTokenRef",
          health_status AS "healthStatus", updated_at AS "updatedAt"
      `,
      [
        request.params.providerId,
        request.tenantContext.organizationId,
        text(request.body?.name ?? current.name, 180),
        ["active", "disabled"].includes(text(request.body?.status ?? current.status, 20).toLowerCase())
          ? text(request.body?.status ?? current.status, 20).toLowerCase()
          : current.status,
        text(request.body?.endpointUrl ?? request.body?.endpoint_url ?? current.endpoint_url, 500),
        text(request.body?.region ?? current.region, 100),
        text(request.body?.bucketName ?? request.body?.bucket_name ?? current.bucket_name, 180),
        accessKeyRef,
        secretKeyRef,
        sessionTokenRef,
        text(request.body?.cdnBaseUrl ?? request.body?.cdn_base_url ?? current.cdn_base_url, 500),
        bool(request.body?.pathStyle ?? request.body?.path_style, current.path_style !== false),
        bool(request.body?.forceSsl ?? request.body?.force_ssl, current.force_ssl !== false),
        text(request.body?.defaultCacheControl ?? request.body?.default_cache_control ?? current.default_cache_control, 200),
        integer(request.body?.signedUrlTtlSeconds ?? request.body?.signed_url_ttl_seconds, current.signed_url_ttl_seconds, 30, 604800),
        integer(request.body?.maxUploadBytes ?? request.body?.max_upload_bytes, current.max_upload_bytes, 1024, 10737418240),
        bool(request.body?.readOnly ?? request.body?.read_only, current.read_only === true),
        JSON.stringify(object(request.body?.metadata, current.metadata_json || {})),
      ]
    );

    await audit(request, "storage.provider.updated", "storage_provider", request.params.providerId);
    return response.json({ success: true, provider: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/providers/:providerId/test", async (request, response, next) => {
  try {
    const result = await storage.testProvider(request.params.providerId);
    await audit(request, "storage.provider.tested", "storage_provider", request.params.providerId, {
      healthy: result.healthy,
    });
    return response.status(result.healthy ? 200 : 503).json({ success: result.healthy, result });
  } catch (error) {
    return next(error);
  }
});

router.get("/buckets", async (request, response, next) => {
  try {
    const buckets = await storage.listBuckets({
      organizationId: request.tenantContext.organizationId,
      projectId: request.tenantContext.projectId,
      environmentId: request.tenantContext.environmentId,
    });
    return response.json({ success: true, buckets });
  } catch (error) {
    return next(error);
  }
});

router.patch("/buckets/:bucketId", async (request, response, next) => {
  try {
    const currentResult = await query(
      `SELECT * FROM backend_storage_buckets WHERE id = $1 AND COALESCE(organization_id, 'org_goodos') = $2 LIMIT 1`,
      [request.params.bucketId, request.tenantContext.organizationId]
    );
    const current = currentResult.rows[0];
    if (!current) return response.status(404).json({ success: false, message: "Storage bucket was not found." });

    const providerConfigId = text(request.body?.providerConfigId ?? request.body?.provider_config_id ?? current.provider_config_id, 180) || null;
    if (providerConfigId) {
      const providerResult = await query(
        `SELECT id, provider FROM backend_storage_provider_configs WHERE id = $1 AND COALESCE(organization_id, 'org_goodos') = $2 AND status = 'active' LIMIT 1`,
        [providerConfigId, request.tenantContext.organizationId]
      );
      if (!providerResult.rows[0]) {
        return response.status(400).json({ success: false, message: "Active storage provider was not found." });
      }
      current.provider = providerResult.rows[0].provider;
    }

    const visibility = ["private", "public"].includes(text(request.body?.visibility ?? current.visibility, 20).toLowerCase())
      ? text(request.body?.visibility ?? current.visibility, 20).toLowerCase()
      : current.visibility;
    const publicRead = bool(request.body?.publicReadEnabled ?? request.body?.public_read_enabled, current.public_read_enabled === true);

    const result = await query(
      `
        UPDATE backend_storage_buckets
        SET
          visibility = $3,
          public_read_enabled = $4,
          provider = $5,
          provider_config_id = $6,
          provider_bucket_name = NULLIF($7,''),
          provider_region = NULLIF($8,''),
          provider_endpoint = NULLIF($9,''),
          provider_prefix = $10,
          cdn_enabled = $11,
          cdn_base_url = NULLIF($12,''),
          cache_control = $13,
          signed_url_ttl_seconds = $14,
          file_versioning_enabled = $15,
          object_lock_enabled = $16,
          lifecycle_json = $17::jsonb,
          cors_json = $18::jsonb,
          storage_class = $19,
          version_retention_count = $20,
          soft_delete_retention_days = $21,
          require_checksum = $22,
          public_listing_enabled = $23,
          allowed_mime_types = $24::text[],
          allowed_extensions = $25::text[],
          max_file_size_bytes = $26,
          metadata_json = $27::jsonb,
          updated_at = NOW()
        WHERE id = $1 AND COALESCE(organization_id, 'org_goodos') = $2
        RETURNING *
      `,
      [
        request.params.bucketId,
        request.tenantContext.organizationId,
        visibility,
        publicRead,
        text(current.provider || "local", 30).toLowerCase(),
        providerConfigId,
        text(request.body?.providerBucketName ?? request.body?.provider_bucket_name ?? current.provider_bucket_name ?? current.name, 180),
        text(request.body?.providerRegion ?? request.body?.provider_region ?? current.provider_region, 100),
        text(request.body?.providerEndpoint ?? request.body?.provider_endpoint ?? current.provider_endpoint, 500),
        text(request.body?.providerPrefix ?? request.body?.provider_prefix ?? current.provider_prefix, 500),
        bool(request.body?.cdnEnabled ?? request.body?.cdn_enabled, current.cdn_enabled === true),
        text(request.body?.cdnBaseUrl ?? request.body?.cdn_base_url ?? current.cdn_base_url, 500),
        text(request.body?.cacheControl ?? request.body?.cache_control ?? current.cache_control ?? (publicRead ? "public, max-age=3600" : "private, max-age=0"), 200),
        integer(request.body?.signedUrlTtlSeconds ?? request.body?.signed_url_ttl_seconds, current.signed_url_ttl_seconds, 30, 604800),
        bool(request.body?.fileVersioningEnabled ?? request.body?.file_versioning_enabled, current.file_versioning_enabled === true),
        bool(request.body?.objectLockEnabled ?? request.body?.object_lock_enabled, current.object_lock_enabled === true),
        JSON.stringify(object(request.body?.lifecycle, current.lifecycle_json || {})),
        JSON.stringify(object(request.body?.cors, current.cors_json || {})),
        text(request.body?.storageClass ?? request.body?.storage_class ?? current.storage_class ?? "standard", 80),
        integer(request.body?.versionRetentionCount ?? request.body?.version_retention_count, current.version_retention_count, 1, 10000),
        integer(request.body?.softDeleteRetentionDays ?? request.body?.soft_delete_retention_days, current.soft_delete_retention_days, 1, 3650),
        bool(request.body?.requireChecksum ?? request.body?.require_checksum, current.require_checksum !== false),
        bool(request.body?.publicListingEnabled ?? request.body?.public_listing_enabled, current.public_listing_enabled === true),
        stringArray(request.body?.allowedMimeTypes ?? request.body?.allowed_mime_types, current.allowed_mime_types || []),
        stringArray(request.body?.allowedExtensions ?? request.body?.allowed_extensions, current.allowed_extensions || []),
        integer(request.body?.maxFileSizeBytes ?? request.body?.max_file_size_bytes, current.max_file_size_bytes, 1024, 10737418240),
        JSON.stringify(object(request.body?.metadata, current.metadata_json || {})),
      ]
    );

    await audit(request, "storage.bucket.updated", "storage_bucket", request.params.bucketId, {
      providerConfigId,
      visibility,
      publicRead,
    });
    return response.json({ success: true, bucket: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get("/access-logs", async (request, response, next) => {
  try {
    const limit = integer(request.query.limit, 100, 1, 500);
    const result = await query(
      `
        SELECT
          id, request_id AS "requestId", api_key_id AS "apiKeyId",
          actor_type AS "actorType", actor_id AS "actorId", operation,
          bucket_id AS "bucketId", bucket_name AS "bucketName", file_id AS "fileId",
          object_key AS "objectKey", provider, status_code AS "statusCode",
          bytes_transferred AS "bytesTransferred", source_ip AS "sourceIp",
          user_agent AS "userAgent", metadata_json AS "metadata", created_at AS "createdAt"
        FROM backend_storage_access_logs
        WHERE COALESCE(organization_id, 'org_goodos') = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [request.tenantContext.organizationId, limit]
    );
    return response.json({ success: true, accessLogs: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/lifecycle-runs", async (request, response, next) => {
  try {
    const result = await query(
      `
        SELECT id, status, scanned_buckets AS "scannedBuckets", scanned_files AS "scannedFiles",
          expired_signed_urls AS "expiredSignedUrls", purged_files AS "purgedFiles",
          purged_versions AS "purgedVersions", error_count AS "errorCount",
          error_json AS errors, started_at AS "startedAt", completed_at AS "completedAt"
        FROM backend_storage_lifecycle_runs
        WHERE COALESCE(organization_id, 'org_goodos') = $1
        ORDER BY started_at DESC
        LIMIT 100
      `,
      [request.tenantContext.organizationId]
    );
    return response.json({ success: true, lifecycleRuns: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/lifecycle/run", async (request, response, next) => {
  try {
    const result = await storage.runLifecycle({
      organizationId: request.tenantContext.organizationId,
      createdBy: request.user.id,
    });
    await audit(request, "storage.lifecycle.completed", "storage_lifecycle_run", result.id, {
      status: result.status,
      purgedFiles: result.purgedFiles,
      purgedVersions: result.purgedVersions,
    });
    return response.json({ success: true, lifecycleRun: result });
  } catch (error) {
    return next(error);
  }
});

router.use((error, request, response, next) => {
  console.error("Storage Control Plane request failed:", error);
  return response.status(error.statusCode || 500).json({
    success: false,
    code: error.code || "STORAGE_ADMIN_REQUEST_FAILED",
    message: error.message || "Storage administration request failed.",
  });
});

module.exports = router;
