"use strict";

const { query } = require("../config/database");

const RESOURCE_TYPES = new Set([
  "campaigns", "content", "approvals", "calendar", "connections",
  "publishing_jobs", "analytics", "media", "link_hubs", "automations",
  "notifications", "email_campaigns", "designs", "flyers",
  "business_cards", "qr_codes", "videos", "brand", "audit_events",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUTATING_ROLES = new Set(["owner", "admin", "manager", "editor", "member"]);
const DESTRUCTIVE_ROLES = new Set(["owner", "admin", "manager"]);

function serviceError(message, statusCode = 400, code = "GOODADS_REQUEST_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireResourceType(type) {
  if (!RESOURCE_TYPES.has(type)) throw serviceError("Unsupported GoodAds resource.", 404, "GOODADS_RESOURCE_NOT_FOUND");
  return type;
}

function normalizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("A JSON object is required.");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 262144) {
    throw serviceError("Resource payload exceeds 256 KB.", 413, "GOODADS_PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(encoded);
}

function requireUuid(value) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw serviceError("A valid resource ID is required.");
  return id;
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").toLowerCase();
}

function requireMutationRole(context) {
  if (!MUTATING_ROLES.has(roleFromContext(context))) {
    throw serviceError("Your organization role cannot modify GoodAds resources.", 403, "GOODADS_WRITE_FORBIDDEN");
  }
}

function requireDestructiveRole(context) {
  if (!DESTRUCTIVE_ROLES.has(roleFromContext(context))) {
    throw serviceError("Owner, admin, or manager access is required.", 403, "GOODADS_DELETE_FORBIDDEN");
  }
}

function rowToResource(row) {
  return {
    id: row.id,
    resourceType: row.resource_type,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.data,
  };
}

async function listResources({ type, context, limit = 50, offset = 0, status = null }) {
  requireResourceType(type);
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const boundedOffset = Math.max(Number(offset) || 0, 0);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL
       AND ($3::text IS NULL OR status = $3)
     ORDER BY updated_at DESC
     LIMIT $4 OFFSET $5`,
    [context.organizationId, type, status || null, boundedLimit, boundedOffset]
  );
  const count = await query(
    `SELECT COUNT(*)::integer AS count FROM goodads_resources
     WHERE organization_id = $1 AND resource_type = $2
       AND archived_at IS NULL AND ($3::text IS NULL OR status = $3)`,
    [context.organizationId, type, status || null]
  );
  return { items: result.rows.map(rowToResource), total: count.rows[0]?.count || 0, limit: boundedLimit, offset: boundedOffset };
}

async function getResource({ type, id, context }) {
  requireResourceType(type);
  const result = await query(
    `SELECT * FROM goodads_resources
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  return rowToResource(result.rows[0]);
}

async function upsertResource({ type, id, payload, context, userId }) {
  requireMutationRole(context);
  requireResourceType(type);
  const data = normalizePayload(payload);
  const resourceId = id ? requireUuid(id) : (data.id && UUID_PATTERN.test(String(data.id)) ? String(data.id) : null);
  const name = String(data.name || data.title || "").trim().slice(0, 240);
  const status = String(data.status || "draft").toLowerCase();
  const result = await query(
    `INSERT INTO goodads_resources (
       id, resource_type, organization_id, project_id, environment_id,
       owner_user_id, name, status, data
     ) VALUES (
       COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::uuid, $7, $8, $9::jsonb
     )
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       version = goodads_resources.version + 1,
       updated_at = NOW()
     WHERE goodads_resources.organization_id = EXCLUDED.organization_id
       AND goodads_resources.resource_type = EXCLUDED.resource_type
     RETURNING *`,
    [resourceId, type, context.organizationId, context.projectId, context.environmentId, userId, name, status, JSON.stringify(data)]
  );
  if (!result.rows[0]) throw serviceError("The resource belongs to another tenant.", 409, "GOODADS_TENANT_CONFLICT");
  await recordEvent({
    resourceId: result.rows[0].id,
    context,
    userId,
    eventType: resourceId ? `${type}.updated` : `${type}.created`,
    nextStatus: result.rows[0].status,
  });
  return rowToResource(result.rows[0]);
}

async function archiveResource({ type, id, context, userId }) {
  requireDestructiveRole(context);
  requireResourceType(type);
  const result = await query(
    `UPDATE goodads_resources
     SET status = 'archived', archived_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE id = $1::uuid AND organization_id = $2 AND resource_type = $3
       AND archived_at IS NULL RETURNING *`,
    [requireUuid(id), context.organizationId, type]
  );
  if (!result.rows[0]) throw serviceError("GoodAds resource not found.", 404, "GOODADS_RECORD_NOT_FOUND");
  await recordEvent({ resourceId: result.rows[0].id, context, userId, eventType: `${type}.archived`, previousStatus: result.rows[0].status, nextStatus: "archived" });
  return rowToResource(result.rows[0]);
}

async function transitionResource({ type, id, nextStatus, context, userId, eventType }) {
  requireMutationRole(context);
  requireResourceType(type);
  const current = await getResource({ type, id, context });
  const result = await query(
    `UPDATE goodads_resources
     SET status = $1, updated_at = NOW(), version = version + 1,
         data = data || jsonb_build_object('status', $1::text, 'updatedAt', NOW()::text)
     WHERE id = $2::uuid AND organization_id = $3 AND resource_type = $4
       AND archived_at IS NULL RETURNING *`,
    [nextStatus, requireUuid(id), context.organizationId, type]
  );
  await recordEvent({ resourceId: id, context, userId, eventType, previousStatus: current.status, nextStatus });
  return rowToResource(result.rows[0]);
}

async function recordEvent({ resourceId, context, userId, eventType, previousStatus = null, nextStatus = null, metadata = {} }) {
  await query(
    `INSERT INTO goodads_resource_events (
       resource_id, organization_id, actor_user_id, event_type,
       previous_status, next_status, metadata
     ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb)`,
    [resourceId, context.organizationId, userId, eventType, previousStatus, nextStatus, JSON.stringify(metadata)]
  );
}

async function dashboard(context) {
  const result = await query(
    `SELECT resource_type, status, COUNT(*)::integer AS count
     FROM goodads_resources
     WHERE organization_id = $1 AND archived_at IS NULL
     GROUP BY resource_type, status ORDER BY resource_type, status`,
    [context.organizationId]
  );
  return {
    organization: context.organization,
    project: context.project,
    environment: context.environment,
    counts: result.rows,
    generatedAt: new Date().toISOString(),
  };
}

async function workspace(context) {
  const brand = await listResources({ type: "brand", context, limit: 1 });
  return {
    id: context.organization.id,
    name: context.organization.name,
    slug: context.organization.slug,
    plan: context.organization.plan,
    status: context.organization.status,
    role: context.organization.membershipRole,
    project: context.project,
    environment: context.environment,
    brand: brand.items[0] || null,
  };
}

module.exports = {
  RESOURCE_TYPES,
  normalizePayload,
  requireUuid,
  dashboard,
  workspace,
  listResources,
  getResource,
  upsertResource,
  archiveResource,
  transitionResource,
};
