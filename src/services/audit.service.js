const { query } = require("../config/database");

async function logAudit({
  userId = null,
  appId = null,
  action,
  entityType = null,
  entityId = null,
  ipAddress = null,
  metadata = {}
}) {
  if (!action) return null;

  const result = await query(
    `
    INSERT INTO audit_logs (
      user_id,
      app_id,
      action,
      entity_type,
      entity_id,
      ip_address,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      NULLIF($6, '')::inet,
      $7::jsonb
    )
    RETURNING id, action, created_at;
    `,
    [
      userId,
      appId,
      action,
      entityType,
      entityId,
      ipAddress || null,
      JSON.stringify(metadata || {})
    ]
  );

  return result.rows[0];
}

module.exports = {
  logAudit
};
