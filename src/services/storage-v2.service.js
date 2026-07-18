"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const database = require("../config/database");

const STORAGE_ROOT = path.resolve(process.cwd(), "storage", "buckets");
const STORAGE_TMP = path.resolve(process.cwd(), "storage", "tmp");
const S3_PROVIDERS = new Set(["s3", "r2", "minio", "spaces", "wasabi"]);

function query(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  throw new Error("Database query function not found");
}

async function withTransaction(callback) {
  const pool = database.pool || (typeof database.getPool === "function" ? database.getPool() : null);
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("Database pool is required for storage transactions");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function statusError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function normalizeIp(value) {
  const ip = String(value || "").trim();
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}

function safeObjectKey(value) {
  const decoded = decodeURIComponent(String(value || "")).replace(/^\/+/, "");
  if (!decoded || decoded.includes("\0")) {
    throw statusError(400, "Object key is required.", "STORAGE_OBJECT_KEY_REQUIRED");
  }

  const parts = decoded.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw statusError(400, "Object key contains an invalid path segment.", "STORAGE_OBJECT_KEY_INVALID");
  }

  return parts.join("/").slice(0, 1024);
}

function safeBucketDirectory(bucketName) {
  const name = String(bucketName || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,126}$/.test(name)) {
    throw statusError(400, "Bucket name is invalid.", "STORAGE_BUCKET_NAME_INVALID");
  }
  return name;
}

function ensureInside(base, candidate) {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + path.sep)) {
    throw statusError(403, "Resolved storage path is outside the storage root.", "STORAGE_PATH_INVALID");
  }
  return resolvedCandidate;
}

function extensionOf(value) {
  return path.extname(String(value || "")).toLowerCase();
}

function normalizeProvider(value) {
  const provider = String(value || "local").trim().toLowerCase();
  return provider || "local";
}

function resolveSecretReference(reference) {
  const ref = String(reference || "").trim();
  if (!ref) return null;

  const match = ref.match(/^env:\/\/([A-Z0-9_]+)$/i);
  if (!match) {
    throw statusError(
      500,
      "Storage credential reference must use env://VARIABLE_NAME.",
      "STORAGE_SECRET_REFERENCE_INVALID"
    );
  }

  const value = process.env[match[1]];
  if (!value) {
    throw statusError(
      503,
      `Storage credential environment variable ${match[1]} is not configured.`,
      "STORAGE_PROVIDER_NOT_CONFIGURED"
    );
  }

  return value;
}

function awsEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(value) {
  const segments = String(value || "/").split("/").map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {}
    return awsEncode(decoded);
  });
  return segments.join("/").replace(/%2F/g, "/") || "/";
}

function amzTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secretKey, dateStamp, region, service = "s3") {
  const kDate = crypto.createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  return crypto.createHmac("sha256", kService).update("aws4_request").digest();
}

function providerEndpoint(provider) {
  const endpoint = String(provider.endpointUrl || provider.endpoint_url || "").trim();
  const region = String(provider.region || "us-east-1").trim();

  if (endpoint) return new URL(endpoint.replace(/\/+$/, ""));
  return new URL(`https://s3.${region}.amazonaws.com`);
}

function providerBucketName(provider, bucket) {
  return String(
    bucket.providerBucketName ||
    bucket.provider_bucket_name ||
    provider.bucketName ||
    provider.bucket_name ||
    bucket.name ||
    ""
  ).trim();
}

function physicalObjectKey(bucket, logicalObjectKey, versionId = null) {
  const prefix = String(bucket.providerPrefix || bucket.provider_prefix || "")
    .replace(/^\/+|\/+$/g, "");
  const logical = safeObjectKey(logicalObjectKey);
  const base = prefix ? `${prefix}/${logical}` : logical;
  if (!versionId) return base;
  return `.goodos-versions/${sha256(base).slice(0, 24)}/${versionId}/${path.basename(logical)}`;
}

function s3RequestUrl(provider, bucket, objectKey = "", queryValues = {}) {
  const endpoint = providerEndpoint(provider);
  const bucketName = providerBucketName(provider, bucket);
  const pathStyle = provider.pathStyle !== false && provider.path_style !== false;

  if (!bucketName) {
    throw statusError(500, "Storage provider bucket name is missing.", "STORAGE_PROVIDER_BUCKET_REQUIRED");
  }

  let host = endpoint.host;
  let pathname = endpoint.pathname.replace(/\/+$/, "");

  if (pathStyle) {
    pathname += `/${awsEncode(bucketName)}`;
  } else {
    host = `${bucketName}.${host}`;
  }

  if (objectKey) pathname += `/${canonicalUri(objectKey).replace(/^\//, "")}`;
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;

  const url = new URL(`${endpoint.protocol}//${host}${pathname}`);
  for (const [key, value] of Object.entries(queryValues)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) => {
      const keyCompare = aKey.localeCompare(bKey);
      return keyCompare || aValue.localeCompare(bValue);
    })
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");
}

function s3Credentials(provider) {
  const accessRef = provider.accessKeyRef || provider.access_key_ref || provider.metadata?.accessKeyRef;
  const secretRef = provider.secretKeyRef || provider.secret_key_ref || provider.secretRef || provider.secret_ref || provider.metadata?.secretKeyRef;
  const sessionRef = provider.sessionTokenRef || provider.session_token_ref || provider.metadata?.sessionTokenRef;

  return {
    accessKeyId: resolveSecretReference(accessRef),
    secretAccessKey: resolveSecretReference(secretRef),
    sessionToken: sessionRef ? resolveSecretReference(sessionRef) : null,
  };
}

async function signedS3Request({ provider, bucket, method, objectKey = "", body = null, headers = {}, queryValues = {} }) {
  const credentials = s3Credentials(provider);
  const region = String(provider.region || "us-east-1");
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const url = s3RequestUrl(provider, bucket, objectKey, queryValues);
  const payload = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  const payloadHash = sha256(payload);

  const normalizedHeaders = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  for (const [key, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null && String(value).trim()) {
      normalizedHeaders[String(key).toLowerCase()] = String(value).trim().replace(/\s+/g, " ");
    }
  }

  if (credentials.sessionToken) {
    normalizedHeaders["x-amz-security-token"] = credentials.sessionToken;
  }

  const sortedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${normalizedHeaders[name]}\n`).join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", signingKey(credentials.secretAccessKey, dateStamp, region))
    .update(stringToSign)
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const fetchHeaders = { ...normalizedHeaders, Authorization: authorization };

  const response = await fetch(url, {
    method: method.toUpperCase(),
    headers: fetchHeaders,
    body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : payload,
    redirect: "manual",
  });

  return { response, url };
}

function presignS3Url({ provider, bucket, method = "GET", objectKey = "", expiresSeconds = 900 }) {
  const credentials = s3Credentials(provider);
  const region = String(provider.region || "us-east-1");
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const expires = Math.min(Math.max(Number(expiresSeconds || 900), 1), 604800);
  const url = s3RequestUrl(provider, bucket, objectKey, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": expires,
    "X-Amz-SignedHeaders": "host",
  });

  if (credentials.sessionToken) url.searchParams.set("X-Amz-Security-Token", credentials.sessionToken);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", signingKey(credentials.secretAccessKey, dateStamp, region))
    .update(stringToSign)
    .digest("hex");

  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

async function loadBucketById(bucketId) {
  const result = await query(
    `
      SELECT
        bucket.*,
        provider.id AS "providerConfigIdResolved",
        provider.name AS "providerConfigName",
        provider.provider AS "providerTypeResolved",
        provider.status AS "providerStatus",
        provider.endpoint_url AS "endpointUrl",
        provider.region AS "providerConfigRegion",
        provider.bucket_name AS "providerConfigBucketName",
        provider.access_key_ref AS "accessKeyRef",
        provider.secret_key_ref AS "secretKeyRef",
        provider.session_token_ref AS "sessionTokenRef",
        provider.secret_ref AS "legacySecretRef",
        provider.cdn_base_url AS "providerCdnBaseUrl",
        provider.path_style AS "pathStyle",
        provider.force_ssl AS "forceSsl",
        provider.read_only AS "providerReadOnly",
        provider.signed_url_ttl_seconds AS "providerSignedUrlTtlSeconds",
        provider.max_upload_bytes AS "providerMaxUploadBytes",
        provider.metadata_json AS "providerMetadata"
      FROM backend_storage_buckets bucket
      LEFT JOIN backend_storage_provider_configs provider
        ON provider.id = bucket.provider_config_id
      WHERE bucket.id = $1
      LIMIT 1
    `,
    [bucketId]
  );

  const bucket = result.rows[0];
  if (!bucket) throw statusError(404, "Storage bucket was not found.", "STORAGE_BUCKET_NOT_FOUND");
  return hydrateBucket(bucket);
}

async function loadBucketByName(bucketName) {
  const result = await query(
    `
      SELECT
        bucket.*,
        provider.id AS "providerConfigIdResolved",
        provider.name AS "providerConfigName",
        provider.provider AS "providerTypeResolved",
        provider.status AS "providerStatus",
        provider.endpoint_url AS "endpointUrl",
        provider.region AS "providerConfigRegion",
        provider.bucket_name AS "providerConfigBucketName",
        provider.access_key_ref AS "accessKeyRef",
        provider.secret_key_ref AS "secretKeyRef",
        provider.session_token_ref AS "sessionTokenRef",
        provider.secret_ref AS "legacySecretRef",
        provider.cdn_base_url AS "providerCdnBaseUrl",
        provider.path_style AS "pathStyle",
        provider.force_ssl AS "forceSsl",
        provider.read_only AS "providerReadOnly",
        provider.signed_url_ttl_seconds AS "providerSignedUrlTtlSeconds",
        provider.max_upload_bytes AS "providerMaxUploadBytes",
        provider.metadata_json AS "providerMetadata"
      FROM backend_storage_buckets bucket
      LEFT JOIN backend_storage_provider_configs provider
        ON provider.id = bucket.provider_config_id
      WHERE bucket.name = $1
      LIMIT 1
    `,
    [bucketName]
  );

  const bucket = result.rows[0];
  if (!bucket) throw statusError(404, "Storage bucket was not found.", "STORAGE_BUCKET_NOT_FOUND");
  return hydrateBucket(bucket);
}

function hydrateBucket(row) {
  const providerType = normalizeProvider(row.providerTypeResolved || row.provider || "local");
  return {
    ...row,
    id: row.id,
    name: row.name,
    provider: providerType,
    providerConfigId: row.providerConfigIdResolved || row.provider_config_id || null,
    endpointUrl: row.endpointUrl || row.provider_endpoint || null,
    region: row.providerConfigRegion || row.provider_region || "us-east-1",
    bucketName: row.providerConfigBucketName || row.provider_bucket_name || row.name,
    accessKeyRef: row.accessKeyRef || null,
    secretKeyRef: row.secretKeyRef || row.legacySecretRef || null,
    sessionTokenRef: row.sessionTokenRef || null,
    cdnBaseUrl: row.cdn_base_url || row.providerCdnBaseUrl || null,
    pathStyle: row.pathStyle !== false,
    forceSsl: row.forceSsl !== false,
    readOnly: row.providerReadOnly === true,
    signedUrlTtlSeconds: Number(row.signed_url_ttl_seconds || row.providerSignedUrlTtlSeconds || 900),
    maxUploadBytes: Number(row.max_file_size_bytes || row.providerMaxUploadBytes || 104857600),
    providerPrefix: row.provider_prefix || "",
    metadata: row.providerMetadata || {},
  };
}

function validateBucketForWrite(bucket, input) {
  if (bucket.status !== "active") {
    throw statusError(409, "Storage bucket is not active.", "STORAGE_BUCKET_INACTIVE");
  }
  if (bucket.providerStatus && bucket.providerStatus !== "active") {
    throw statusError(503, "Storage provider is not active.", "STORAGE_PROVIDER_INACTIVE");
  }
  if (bucket.readOnly) {
    throw statusError(403, "Storage provider is read-only.", "STORAGE_PROVIDER_READ_ONLY");
  }

  const size = Number(input.sizeBytes || 0);
  if (size <= 0) throw statusError(400, "Uploaded object is empty.", "STORAGE_OBJECT_EMPTY");
  if (size > bucket.maxUploadBytes) {
    throw statusError(413, "Uploaded object exceeds the bucket size limit.", "STORAGE_OBJECT_TOO_LARGE");
  }

  const mime = String(input.mimeType || "application/octet-stream").toLowerCase();
  const extension = extensionOf(input.originalFilename || input.objectKey);
  const allowedMimeTypes = Array.isArray(bucket.allowed_mime_types) ? bucket.allowed_mime_types.map(String).map((v) => v.toLowerCase()) : [];
  const allowedExtensions = Array.isArray(bucket.allowed_extensions) ? bucket.allowed_extensions.map(String).map((v) => v.toLowerCase()) : [];

  if (allowedMimeTypes.length && !allowedMimeTypes.includes(mime)) {
    throw statusError(415, "Uploaded MIME type is not allowed by this bucket.", "STORAGE_MIME_NOT_ALLOWED");
  }
  if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
    throw statusError(415, "Uploaded file extension is not allowed by this bucket.", "STORAGE_EXTENSION_NOT_ALLOWED");
  }
}

function localVersionPath(bucket, objectKey, versionId, originalFilename) {
  const bucketDirectory = safeBucketDirectory(bucket.name);
  const basename = path.basename(originalFilename || objectKey || "object").replace(/[^a-zA-Z0-9._-]/g, "_");
  const candidate = path.join(STORAGE_ROOT, bucketDirectory, ".versions", sha256(objectKey).slice(0, 24), versionId, basename);
  return ensureInside(STORAGE_ROOT, candidate);
}

async function putProviderObject({ bucket, physicalKey, buffer, mimeType, cacheControl, contentDisposition, storageClass }) {
  if (bucket.provider === "local") {
    const localPath = localVersionPath(bucket, physicalKey, path.basename(path.dirname(physicalKey)), path.basename(physicalKey));
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await fsp.writeFile(localPath, buffer, { mode: 0o640 });
    return {
      storagePath: localPath,
      providerEtag: sha256(buffer),
      providerVersionId: null,
      providerMetadata: { local: true, physicalKey },
    };
  }

  if (!S3_PROVIDERS.has(bucket.provider)) {
    throw statusError(500, `Unsupported storage provider: ${bucket.provider}`, "STORAGE_PROVIDER_UNSUPPORTED");
  }

  const { response } = await signedS3Request({
    provider: bucket,
    bucket,
    method: "PUT",
    objectKey: physicalKey,
    body: buffer,
    headers: {
      "content-type": mimeType || "application/octet-stream",
      "cache-control": cacheControl || "private, max-age=0",
      "content-disposition": contentDisposition || undefined,
      "x-amz-storage-class": storageClass && storageClass !== "standard" ? storageClass.toUpperCase() : undefined,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw statusError(502, `S3-compatible upload failed with HTTP ${response.status}: ${detail.slice(0, 300)}`, "STORAGE_PROVIDER_UPLOAD_FAILED");
  }

  return {
    storagePath: null,
    providerEtag: String(response.headers.get("etag") || "").replaceAll('"', "") || sha256(buffer),
    providerVersionId: response.headers.get("x-amz-version-id") || null,
    providerMetadata: { s3Compatible: true, physicalKey },
  };
}

async function getFileById(fileId, includeDeleted = false) {
  const result = await query(
    `
      SELECT
        file_record.*,
        bucket.name AS "bucketName",
        bucket.visibility,
        bucket.public_read_enabled AS "publicReadEnabled",
        bucket.cdn_enabled AS "bucketCdnEnabled",
        bucket.cdn_base_url AS "bucketCdnBaseUrl",
        bucket.cache_control AS "bucketCacheControl",
        bucket.provider_config_id AS "bucketProviderConfigId",
        bucket.provider_prefix AS "bucketProviderPrefix",
        provider.endpoint_url AS "endpointUrl",
        provider.region AS "providerConfigRegion",
        provider.bucket_name AS "providerConfigBucketName",
        provider.access_key_ref AS "accessKeyRef",
        provider.secret_key_ref AS "secretKeyRef",
        provider.session_token_ref AS "sessionTokenRef",
        provider.secret_ref AS "legacySecretRef",
        provider.path_style AS "pathStyle",
        provider.force_ssl AS "forceSsl",
        provider.signed_url_ttl_seconds AS "providerSignedUrlTtlSeconds",
        provider.status AS "providerStatus",
        provider.metadata_json AS "providerMetadata"
      FROM backend_storage_files file_record
      JOIN backend_storage_buckets bucket ON bucket.id = file_record.bucket_id
      LEFT JOIN backend_storage_provider_configs provider ON provider.id = bucket.provider_config_id
      WHERE file_record.id = $1
        AND ($2::boolean = TRUE OR (file_record.status = 'active' AND COALESCE(file_record.file_deleted, FALSE) = FALSE))
      LIMIT 1
    `,
    [fileId, includeDeleted]
  );

  const file = result.rows[0];
  if (!file) throw statusError(404, "Storage object was not found.", "STORAGE_OBJECT_NOT_FOUND");
  return hydrateFile(file);
}

function hydrateFile(row) {
  const provider = normalizeProvider(row.provider || "local");
  const metadata = row.provider_metadata_json || {};
  const bucket = {
    id: row.bucket_id,
    name: row.bucketName,
    provider,
    providerConfigId: row.bucketProviderConfigId,
    providerPrefix: row.bucketProviderPrefix || "",
    endpointUrl: row.endpointUrl || row.provider_endpoint || null,
    region: row.providerConfigRegion || row.provider_region || "us-east-1",
    bucketName: row.providerConfigBucketName || row.provider_bucket_name || row.bucketName,
    accessKeyRef: row.accessKeyRef || null,
    secretKeyRef: row.secretKeyRef || row.legacySecretRef || null,
    sessionTokenRef: row.sessionTokenRef || null,
    pathStyle: row.pathStyle !== false,
    forceSsl: row.forceSsl !== false,
    signedUrlTtlSeconds: Number(row.providerSignedUrlTtlSeconds || 900),
    metadata: row.providerMetadata || {},
  };

  return {
    ...row,
    provider,
    bucket,
    objectKey: row.object_key || row.filename,
    physicalKey: metadata.physicalKey || physicalObjectKey(bucket, row.object_key || row.filename, row.version_id || row.id),
  };
}

async function putObject(input) {
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
  await fsp.mkdir(STORAGE_TMP, { recursive: true });

  const bucket = await loadBucketById(input.bucketId);
  const objectKey = safeObjectKey(input.objectKey || input.originalFilename);
  const buffer = input.buffer ? Buffer.from(input.buffer) : await fsp.readFile(input.tempPath);
  const mimeType = String(input.mimeType || "application/octet-stream");
  const originalFilename = String(input.originalFilename || path.basename(objectKey));

  validateBucketForWrite(bucket, {
    sizeBytes: buffer.length,
    mimeType,
    originalFilename,
    objectKey,
  });

  const checksumSha256 = sha256(buffer);
  const checksumMd5 = md5(buffer);
  if (input.expectedChecksum && String(input.expectedChecksum).toLowerCase() !== checksumSha256) {
    throw statusError(422, "Uploaded checksum does not match X-Content-SHA256.", "STORAGE_CHECKSUM_MISMATCH");
  }

  const fileId = identifier("storagefile");
  const versionId = identifier("storagever");
  const currentResult = await query(
    `
      SELECT id, parent_file_id, version_number
      FROM backend_storage_files
      WHERE bucket_id = $1
        AND object_key = $2
        AND is_latest_version = TRUE
      ORDER BY version_number DESC, created_at DESC
      LIMIT 1
    `,
    [bucket.id, objectKey]
  );
  const current = currentResult.rows[0] || null;
  const versionNumber = Number(current?.version_number || 0) + 1;
  const physicalKey = physicalObjectKey(bucket, objectKey, versionId);
  const cacheControl = String(input.cacheControl || bucket.cache_control || "private, max-age=0");
  const contentDisposition = input.contentDisposition || null;
  const storageClass = String(input.storageClass || bucket.storage_class || "standard");

  const providerWrite = await putProviderObject({
    bucket,
    physicalKey,
    buffer,
    mimeType,
    cacheControl,
    contentDisposition,
    storageClass,
  });

  const publicEnabled = bucket.public_read_enabled === true || bucket.visibility === "public";
  const publicUrl = publicEnabled
    ? `https://backend.goodos.app/storage/v2/public/${encodeURIComponent(bucket.name)}/${objectKey.split("/").map(awsEncode).join("/")}`
    : null;
  const cdnUrl = bucket.cdn_enabled === true && bucket.cdnBaseUrl
    ? `${String(bucket.cdnBaseUrl).replace(/\/+$/, "")}/${objectKey.split("/").map(awsEncode).join("/")}`
    : null;

  const saved = await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE backend_storage_files
        SET is_latest_version = FALSE, updated_at = NOW()
        WHERE bucket_id = $1 AND object_key = $2 AND is_latest_version = TRUE
      `,
      [bucket.id, objectKey]
    );

    const insertResult = await client.query(
      `
        INSERT INTO backend_storage_files (
          id, bucket_id, filename, original_filename, mime_type, size_bytes, status,
          created_by, storage_path, folder_path, checksum_sha256, display_name,
          metadata_json, organization_id, project_id, environment_id, object_key,
          provider, provider_bucket_name, provider_region, provider_endpoint,
          provider_etag, provider_version_id, version_id, version_number,
          parent_file_id, is_latest_version, checksum_md5, checksum_algorithm,
          public_url, cdn_url, content_disposition, content_encoding, cache_control,
          storage_class, provider_metadata_json, file_deleted, deleted_marker, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,'active',$7::uuid,$8,$9,$10,$11,
          $12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
          $25,TRUE,$26,'sha256',$27,$28,$29,$30,$31,$32,$33::jsonb,FALSE,FALSE,NOW()
        )
        RETURNING *
      `,
      [
        fileId,
        bucket.id,
        path.basename(objectKey),
        originalFilename,
        mimeType,
        buffer.length,
        input.createdBy || null,
        providerWrite.storagePath,
        path.dirname(objectKey) === "." ? "" : path.dirname(objectKey),
        checksumSha256,
        input.displayName || originalFilename,
        JSON.stringify(input.metadata || {}),
        input.organizationId || bucket.organization_id || "org_goodos",
        input.projectId || bucket.project_id || "proj_goodos_platform",
        input.environmentId || bucket.environment_id || "env_goodos_production",
        objectKey,
        bucket.provider,
        bucket.bucketName,
        bucket.region,
        bucket.endpointUrl,
        providerWrite.providerEtag,
        providerWrite.providerVersionId,
        versionId,
        versionNumber,
        current?.parent_file_id || current?.id || null,
        checksumMd5,
        publicUrl,
        cdnUrl,
        contentDisposition,
        input.contentEncoding || null,
        cacheControl,
        storageClass,
        JSON.stringify(providerWrite.providerMetadata || {}),
      ]
    );

    await client.query(
      `
        INSERT INTO backend_storage_object_versions (
          id, file_id, bucket_id, object_key, version_id, version_number, provider,
          provider_version_id, size_bytes, checksum_sha256, checksum_md5, storage_path,
          public_url, cdn_url, content_type, content_encoding, content_disposition,
          cache_control, storage_class, provider_metadata_json, status, metadata_json,
          organization_id, project_id, environment_id, created_by
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20::jsonb,'active',$21::jsonb,$22,$23,$24,$25::uuid
        )
      `,
      [
        identifier("storageobjver"),
        fileId,
        bucket.id,
        objectKey,
        versionId,
        versionNumber,
        bucket.provider,
        providerWrite.providerVersionId,
        buffer.length,
        checksumSha256,
        checksumMd5,
        providerWrite.storagePath,
        publicUrl,
        cdnUrl,
        mimeType,
        input.contentEncoding || null,
        contentDisposition,
        cacheControl,
        storageClass,
        JSON.stringify(providerWrite.providerMetadata || {}),
        JSON.stringify({ uploadedBy: input.actorType || "api_key" }),
        input.organizationId || bucket.organization_id || "org_goodos",
        input.projectId || bucket.project_id || "proj_goodos_platform",
        input.environmentId || bucket.environment_id || "env_goodos_production",
        input.createdBy || null,
      ]
    );

    return insertResult.rows[0];
  });

  return hydrateFile({
    ...saved,
    bucketName: bucket.name,
    bucketProviderConfigId: bucket.providerConfigId,
    bucketProviderPrefix: bucket.providerPrefix,
    endpointUrl: bucket.endpointUrl,
    providerConfigRegion: bucket.region,
    providerConfigBucketName: bucket.bucketName,
    accessKeyRef: bucket.accessKeyRef,
    secretKeyRef: bucket.secretKeyRef,
    sessionTokenRef: bucket.sessionTokenRef,
    pathStyle: bucket.pathStyle,
    forceSsl: bucket.forceSsl,
    providerSignedUrlTtlSeconds: bucket.signedUrlTtlSeconds,
  });
}

async function listBuckets({ organizationId, projectId, environmentId }) {
  const result = await query(
    `
      SELECT
        bucket.*,
        provider.name AS "providerName",
        provider.health_status AS "providerHealthStatus",
        COUNT(file_record.id) FILTER (
          WHERE file_record.status = 'active' AND COALESCE(file_record.file_deleted, FALSE) = FALSE AND file_record.is_latest_version = TRUE
        )::int AS "objectCount",
        COALESCE(SUM(file_record.size_bytes) FILTER (
          WHERE file_record.status = 'active' AND COALESCE(file_record.file_deleted, FALSE) = FALSE AND file_record.is_latest_version = TRUE
        ), 0)::bigint AS "totalBytes"
      FROM backend_storage_buckets bucket
      LEFT JOIN backend_storage_provider_configs provider ON provider.id = bucket.provider_config_id
      LEFT JOIN backend_storage_files file_record ON file_record.bucket_id = bucket.id
      WHERE COALESCE(bucket.organization_id, 'org_goodos') = $1
        AND ($2::text IS NULL OR bucket.project_id = $2)
        AND ($3::text IS NULL OR bucket.environment_id = $3)
      GROUP BY bucket.id, provider.name, provider.health_status
      ORDER BY bucket.name
    `,
    [organizationId || "org_goodos", projectId || null, environmentId || null]
  );
  return result.rows;
}

async function listObjects({ bucketId, limit = 100, offset = 0, includeDeleted = false, prefix = "" }) {
  await loadBucketById(bucketId);
  const safeLimit = Math.min(Math.max(Number(limit || 100), 1), 500);
  const safeOffset = Math.max(Number(offset || 0), 0);
  const result = await query(
    `
      SELECT
        file_record.*,
        COUNT(*) OVER()::int AS "totalCount"
      FROM backend_storage_files file_record
      WHERE file_record.bucket_id = $1
        AND file_record.is_latest_version = TRUE
        AND ($2::boolean = TRUE OR (file_record.status = 'active' AND COALESCE(file_record.file_deleted, FALSE) = FALSE))
        AND ($3 = '' OR file_record.object_key LIKE $3 || '%')
      ORDER BY file_record.object_key
      LIMIT $4 OFFSET $5
    `,
    [bucketId, includeDeleted, String(prefix || ""), safeLimit, safeOffset]
  );
  return {
    objects: result.rows,
    total: Number(result.rows[0]?.totalCount || 0),
    limit: safeLimit,
    offset: safeOffset,
  };
}

async function getLatestObjectByKey(bucketId, objectKey, includeDeleted = false) {
  const key = safeObjectKey(objectKey);
  const result = await query(
    `
      SELECT id
      FROM backend_storage_files
      WHERE bucket_id = $1
        AND object_key = $2
        AND is_latest_version = TRUE
        AND ($3::boolean = TRUE OR (status = 'active' AND COALESCE(file_deleted, FALSE) = FALSE))
      ORDER BY version_number DESC, created_at DESC
      LIMIT 1
    `,
    [bucketId, key, includeDeleted]
  );

  if (!result.rows[0]) {
    throw statusError(404, "Storage object was not found.", "STORAGE_OBJECT_NOT_FOUND");
  }

  return getFileById(result.rows[0].id, includeDeleted);
}

async function listVersions(fileId) {
  const file = await getFileById(fileId, true);
  const result = await query(
    `
      SELECT *
      FROM backend_storage_object_versions
      WHERE bucket_id = $1 AND object_key = $2
      ORDER BY version_number DESC, created_at DESC
    `,
    [file.bucket_id, file.objectKey]
  );
  return result.rows;
}

async function resolveDownload(file, expiresSeconds = 900) {
  if (file.provider === "local") {
    const fullPath = ensureInside(STORAGE_ROOT, file.storage_path || "");
    if (!fs.existsSync(fullPath)) {
      throw statusError(404, "Object bytes are missing from local storage.", "STORAGE_OBJECT_BYTES_MISSING");
    }
    return { type: "local", path: fullPath };
  }

  const url = presignS3Url({
    provider: file.bucket,
    bucket: file.bucket,
    method: "GET",
    objectKey: file.physicalKey,
    expiresSeconds,
  });
  return { type: "redirect", url };
}

async function createSignedUrl({ fileId, expiresSeconds, maxDownloads = 1, allowedIp = null, userAgentLimit = null, createdBy = null, organizationId, projectId, environmentId }) {
  const file = await getFileById(fileId);
  const ttl = Math.min(Math.max(Number(expiresSeconds || file.bucket.signedUrlTtlSeconds || 900), 30), 604800);
  const token = `stg_${crypto.randomBytes(36).toString("base64url")}`;
  const signedId = identifier("storagesigned");

  await query(
    `
      INSERT INTO backend_storage_signed_urls (
        id, file_id, token_hash, token_prefix, status, expires_at, max_downloads,
        download_count, created_by, purpose, allowed_ip, user_agent_limit, method,
        public_url, cdn_url, metadata_json, organization_id, project_id, environment_id
      )
      VALUES (
        $1,$2,$3,$4,'active',NOW() + ($5::text || ' seconds')::interval,$6,0,$7::uuid,
        'download',$8,$9,'GET',$10,$11,$12::jsonb,$13,$14,$15
      )
    `,
    [
      signedId,
      fileId,
      sha256(token),
      token.slice(0, 12),
      ttl,
      maxDownloads === null ? null : Math.max(Number(maxDownloads || 1), 1),
      createdBy || null,
      allowedIp ? normalizeIp(allowedIp) : null,
      userAgentLimit || null,
      `https://backend.goodos.app/storage/v2/signed/${token}`,
      file.cdn_url || null,
      JSON.stringify({ phase: 18, provider: file.provider }),
      organizationId || file.organization_id || "org_goodos",
      projectId || file.project_id || "proj_goodos_platform",
      environmentId || file.environment_id || "env_goodos_production",
    ]
  );

  return {
    id: signedId,
    token,
    url: `https://backend.goodos.app/storage/v2/signed/${token}`,
    expiresInSeconds: ttl,
    maxDownloads: maxDownloads === null ? null : Math.max(Number(maxDownloads || 1), 1),
  };
}

async function consumeSignedUrl({ token, sourceIp, userAgent }) {
  const result = await query(
    `
      UPDATE backend_storage_signed_urls signed_url
      SET download_count = signed_url.download_count + 1, last_used_at = NOW()
      WHERE signed_url.token_hash = $1
        AND signed_url.status = 'active'
        AND signed_url.revoked_at IS NULL
        AND signed_url.expires_at > NOW()
        AND (signed_url.max_downloads IS NULL OR signed_url.download_count < signed_url.max_downloads)
        AND (signed_url.allowed_ip IS NULL OR signed_url.allowed_ip = $2)
        AND (signed_url.user_agent_limit IS NULL OR $3 ILIKE '%' || signed_url.user_agent_limit || '%')
      RETURNING signed_url.id, signed_url.file_id AS "fileId"
    `,
    [sha256(token), normalizeIp(sourceIp), String(userAgent || "")]
  );

  if (!result.rows[0]) {
    throw statusError(403, "Signed URL is invalid, expired, restricted, revoked, or exhausted.", "STORAGE_SIGNED_URL_INVALID");
  }
  return result.rows[0];
}

async function releaseSignedConsumption(id) {
  await query(
    `UPDATE backend_storage_signed_urls SET download_count = GREATEST(download_count - 1, 0) WHERE id = $1`,
    [id]
  ).catch(() => {});
}

async function softDeleteObject({
  fileId,
  actorId = null,
  createdBy = null,
  reason = "Deleted through Storage V2 API",
}) {
  const file = await getFileById(fileId);
  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE backend_storage_files
        SET status = 'deleted', file_deleted = TRUE, deleted_marker = TRUE,
            deleted_at = NOW(), deleted_by = $2, deleted_reason = $3, updated_at = NOW()
        WHERE id = $1
      `,
      [fileId, actorId, reason]
    );

    await client.query(
      `
        INSERT INTO backend_storage_object_versions (
          id, file_id, bucket_id, object_key, version_id, version_number, provider,
          size_bytes, checksum_sha256, checksum_md5, storage_path, public_url, cdn_url,
          status, metadata_json, organization_id, project_id, environment_id, created_by,
          is_delete_marker, provider_metadata_json
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,0,NULL,NULL,NULL,NULL,NULL,'deleted',$8::jsonb,
          $9,$10,$11,$12::uuid,TRUE,'{}'::jsonb
        )
      `,
      [
        identifier("storageobjver"),
        fileId,
        file.bucket_id,
        file.objectKey,
        identifier("delete"),
        Number(file.version_number || 1) + 1,
        file.provider,
        JSON.stringify({ reason }),
        file.organization_id,
        file.project_id,
        file.environment_id,
        createdBy || null,
      ]
    );
  });
  return { id: fileId, deleted: true };
}

async function restoreVersion({ fileId, versionRecordId, createdBy = null, actorType = "api_key" }) {
  const current = await getFileById(fileId, true);
  const versionResult = await query(
    `SELECT * FROM backend_storage_object_versions WHERE id = $1 AND bucket_id = $2 AND object_key = $3 LIMIT 1`,
    [versionRecordId, current.bucket_id, current.objectKey]
  );
  const version = versionResult.rows[0];
  if (!version || version.is_delete_marker) {
    throw statusError(404, "Restorable object version was not found.", "STORAGE_VERSION_NOT_FOUND");
  }

  let buffer;
  if (version.provider === "local") {
    const sourcePath = ensureInside(STORAGE_ROOT, version.storage_path || "");
    buffer = await fsp.readFile(sourcePath);
  } else {
    const physicalKey = version.provider_metadata_json?.physicalKey || current.physicalKey;
    const { response } = await signedS3Request({
      provider: current.bucket,
      bucket: current.bucket,
      method: "GET",
      objectKey: physicalKey,
    });
    if (!response.ok) {
      throw statusError(502, `S3-compatible restore read failed with HTTP ${response.status}.`, "STORAGE_VERSION_READ_FAILED");
    }
    buffer = Buffer.from(await response.arrayBuffer());
  }

  const restored = await putObject({
    bucketId: current.bucket_id,
    objectKey: current.objectKey,
    originalFilename: current.original_filename || current.filename,
    mimeType: version.content_type || current.mime_type,
    buffer,
    cacheControl: version.cache_control || current.cache_control,
    contentDisposition: version.content_disposition || current.content_disposition,
    contentEncoding: version.content_encoding || current.content_encoding,
    storageClass: version.storage_class || current.storage_class,
    createdBy,
    actorType,
    organizationId: current.organization_id,
    projectId: current.project_id,
    environmentId: current.environment_id,
    metadata: { restoredFromVersionId: versionRecordId },
  });

  await query(
    `UPDATE backend_storage_object_versions SET restored_from_version_id = $2 WHERE file_id = $1 AND version_id = $3`,
    [restored.id, versionRecordId, restored.version_id]
  ).catch(() => {});

  return restored;
}

async function logAccess(input) {
  await query(
    `
      INSERT INTO backend_storage_access_logs (
        id, request_id, organization_id, project_id, environment_id, api_key_id,
        actor_type, actor_id, operation, bucket_id, bucket_name, file_id, object_key,
        provider, status_code, bytes_transferred, source_ip, user_agent, metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
    `,
    [
      identifier("storageaccess"),
      input.requestId || null,
      input.organizationId || "org_goodos",
      input.projectId || null,
      input.environmentId || null,
      input.apiKeyId || null,
      input.actorType || "api_key",
      input.actorId || null,
      input.operation,
      input.bucketId || null,
      input.bucketName || null,
      input.fileId || null,
      input.objectKey || null,
      input.provider || "local",
      input.statusCode || null,
      Number(input.bytesTransferred || 0),
      normalizeIp(input.sourceIp),
      input.userAgent || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
}

async function touchFileAccess(fileId) {
  await query(
    `UPDATE backend_storage_files SET last_accessed_at = NOW(), access_count = access_count + 1, updated_at = NOW() WHERE id = $1`,
    [fileId]
  ).catch(() => {});
}

async function testProvider(providerId) {
  const result = await query(`SELECT * FROM backend_storage_provider_configs WHERE id = $1 LIMIT 1`, [providerId]);
  const provider = result.rows[0];
  if (!provider) throw statusError(404, "Storage provider was not found.", "STORAGE_PROVIDER_NOT_FOUND");

  let healthy = false;
  let detail = null;
  try {
    if (normalizeProvider(provider.provider) === "local") {
      await fsp.mkdir(STORAGE_ROOT, { recursive: true });
      await fsp.access(STORAGE_ROOT, fs.constants.R_OK | fs.constants.W_OK);
      healthy = true;
      detail = `Local storage root is readable and writable: ${STORAGE_ROOT}`;
    } else {
      const pseudoBucket = hydrateBucket({
        id: "provider-test",
        name: provider.bucket_name || "provider-test",
        providerTypeResolved: provider.provider,
        providerConfigIdResolved: provider.id,
        endpointUrl: provider.endpoint_url,
        providerConfigRegion: provider.region,
        providerConfigBucketName: provider.bucket_name,
        accessKeyRef: provider.access_key_ref,
        secretKeyRef: provider.secret_key_ref || provider.secret_ref,
        sessionTokenRef: provider.session_token_ref,
        pathStyle: provider.path_style,
        forceSsl: provider.force_ssl,
        providerStatus: provider.status,
        providerMetadata: provider.metadata_json,
      });
      const { response } = await signedS3Request({ provider: pseudoBucket, bucket: pseudoBucket, method: "HEAD" });
      healthy = response.ok;
      detail = healthy ? `Provider returned HTTP ${response.status}.` : `Provider returned HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 250)}`;
    }
  } catch (error) {
    detail = error.message;
  }

  await query(
    `
      UPDATE backend_storage_provider_configs
      SET health_status = $2, last_health_check_at = NOW(), last_health_error = $3, updated_at = NOW()
      WHERE id = $1
    `,
    [providerId, healthy ? "healthy" : "unhealthy", healthy ? null : detail]
  );

  return { providerId, healthy, detail };
}

async function runLifecycle({ organizationId = "org_goodos", createdBy = null } = {}) {
  const runId = identifier("storagelifecycle");
  await query(
    `INSERT INTO backend_storage_lifecycle_runs (id, organization_id, status, created_by, metadata_json) VALUES ($1,$2,'running',$3::uuid,'{"phase":18}'::jsonb)`,
    [runId, organizationId, createdBy || null]
  );

  const errors = [];
  let scannedBuckets = 0;
  let scannedFiles = 0;
  let expiredSignedUrls = 0;
  let purgedFiles = 0;
  let purgedVersions = 0;

  try {
    const expired = await query(
      `UPDATE backend_storage_signed_urls SET status = 'expired' WHERE status = 'active' AND expires_at <= NOW() RETURNING id`
    );
    expiredSignedUrls = expired.rowCount;

    const buckets = await query(
      `SELECT id, name, provider, version_retention_count, soft_delete_retention_days FROM backend_storage_buckets WHERE COALESCE(organization_id, 'org_goodos') = $1 AND status = 'active'`,
      [organizationId]
    );
    scannedBuckets = buckets.rowCount;

    for (const bucket of buckets.rows) {
      const files = await query(`SELECT id, storage_path, provider FROM backend_storage_files WHERE bucket_id = $1`, [bucket.id]);
      scannedFiles += files.rowCount;

      const purge = await query(
        `
          SELECT id, storage_path, provider
          FROM backend_storage_files
          WHERE bucket_id = $1
            AND file_deleted = TRUE
            AND deleted_at IS NOT NULL
            AND deleted_at < NOW() - ($2::text || ' days')::interval
        `,
        [bucket.id, Math.max(Number(bucket.soft_delete_retention_days || 30), 1)]
      );

      for (const file of purge.rows) {
        try {
          if (file.provider === "local" && file.storage_path) {
            const fullPath = ensureInside(STORAGE_ROOT, file.storage_path);
            await fsp.rm(fullPath, { force: true });
          }
          await query(`DELETE FROM backend_storage_files WHERE id = $1`, [file.id]);
          purgedFiles += 1;
        } catch (error) {
          errors.push({ fileId: file.id, message: error.message });
        }
      }

      const retention = Math.max(Number(bucket.version_retention_count || 25), 1);
      const oldVersions = await query(
        `
          WITH ranked AS (
            SELECT id, storage_path, provider,
                   ROW_NUMBER() OVER (PARTITION BY object_key ORDER BY version_number DESC, created_at DESC) AS rank
            FROM backend_storage_object_versions
            WHERE bucket_id = $1 AND is_delete_marker = FALSE
          )
          SELECT id, storage_path, provider FROM ranked WHERE rank > $2
        `,
        [bucket.id, retention]
      );

      for (const version of oldVersions.rows) {
        try {
          if (version.provider === "local" && version.storage_path) {
            const fullPath = ensureInside(STORAGE_ROOT, version.storage_path);
            await fsp.rm(fullPath, { force: true });
          }
          await query(`DELETE FROM backend_storage_object_versions WHERE id = $1`, [version.id]);
          purgedVersions += 1;
        } catch (error) {
          errors.push({ versionId: version.id, message: error.message });
        }
      }
    }

    await query(
      `
        UPDATE backend_storage_lifecycle_runs
        SET status = $2, scanned_buckets = $3, scanned_files = $4,
            expired_signed_urls = $5, purged_files = $6, purged_versions = $7,
            error_count = $8, error_json = $9::jsonb, completed_at = NOW()
        WHERE id = $1
      `,
      [runId, errors.length ? "completed_with_errors" : "completed", scannedBuckets, scannedFiles, expiredSignedUrls, purgedFiles, purgedVersions, errors.length, JSON.stringify(errors)]
    );
  } catch (error) {
    errors.push({ message: error.message });
    await query(
      `UPDATE backend_storage_lifecycle_runs SET status = 'failed', error_count = $2, error_json = $3::jsonb, completed_at = NOW() WHERE id = $1`,
      [runId, errors.length, JSON.stringify(errors)]
    );
    throw error;
  }

  return {
    id: runId,
    status: errors.length ? "completed_with_errors" : "completed",
    scannedBuckets,
    scannedFiles,
    expiredSignedUrls,
    purgedFiles,
    purgedVersions,
    errors,
  };
}

module.exports = {
  STORAGE_ROOT,
  STORAGE_TMP,
  identifier,
  statusError,
  safeObjectKey,
  loadBucketById,
  loadBucketByName,
  getFileById,
  getLatestObjectByKey,
  listBuckets,
  listObjects,
  listVersions,
  putObject,
  resolveDownload,
  createSignedUrl,
  consumeSignedUrl,
  releaseSignedConsumption,
  softDeleteObject,
  restoreVersion,
  logAccess,
  touchFileAccess,
  testProvider,
  runLifecycle,
  presignS3Url,
};
