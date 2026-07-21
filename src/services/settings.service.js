/* GOODOS_SETTINGS_LIVE_V1 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const {
  profileAvatarUrl
} = require("../utils/managedAssetUrl");

const fileSystem = fs.promises;
const PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PROFILE_AVATAR_ROOT = path.resolve(
  process.env.GOODOS_PROFILE_AVATAR_DIR ||
    path.join(process.cwd(), "storage", "profile-avatars")
);
const BUSINESS_LOGO_MAX_BYTES = 4 * 1024 * 1024;
const BUSINESS_LOGO_ROOT = path.resolve(
  process.env.GOODOS_BUSINESS_LOGO_DIR ||
    path.join(process.cwd(), "storage", "business-logos")
);
const PUBLIC_BACKEND_URL = String(
  process.env.PUBLIC_BACKEND_URL || "https://base.goodos.app"
).replace(/\/+$/, "");

const database =
  require("../config/database");

const {
  logAudit
} = require("./audit.service");

function dbQuery(
  sql,
  params = []
) {
  if (
    typeof database.query ===
    "function"
  ) {
    return database.query(
      sql,
      params
    );
  }

  if (
    database.pool &&
    typeof database.pool.query ===
      "function"
  ) {
    return database.pool.query(
      sql,
      params
    );
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database
      .getPool()
      .query(
        sql,
        params
      );
  }

  throw new Error(
    "Database query function not found"
  );
}

function getPool() {
  if (
    database.pool &&
    typeof database.pool.connect ===
      "function"
  ) {
    return database.pool;
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database.getPool();
  }

  throw new Error(
    "Database connection pool not found"
  );
}

function serviceError(
  message,
  statusCode = 400
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}

function cleanText(
  value,
  maximum = 255
) {
  return String(
    value ?? ""
  )
    .trim()
    .slice(
      0,
      maximum
    );
}

function nullableText(
  value,
  maximum = 255
) {
  const cleaned =
    cleanText(
      value,
      maximum
    );

  return cleaned || null;
}

function nullableEmail(
  value,
  label = "Email"
) {
  const cleaned =
    nullableText(
      value,
      320
    );

  if (
    cleaned &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      cleaned
    )
  ) {
    throw serviceError(
      `${label} must be a valid email address.`
    );
  }

  return cleaned;
}

function nullableWebUrl(
  value
) {
  const cleaned =
    nullableText(
      value,
      500
    );

  if (!cleaned) {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(cleaned);
  } catch {
    throw serviceError(
      "Website must be a valid URL."
    );
  }

  if (
    ![
      "http:",
      "https:"
    ].includes(parsed.protocol)
  ) {
    throw serviceError(
      "Website must use http or https."
    );
  }

  return parsed.toString();
}

function allowedValue(
  value,
  allowed,
  fallback
) {
  const normalized =
    cleanText(value, 100);

  return allowed.includes(
    normalized
  )
    ? normalized
    : fallback;
}

function publicProfile(row) {
  return {
    id: row.id,
    email: row.email,
    firstName:
      row.first_name || "",
    lastName:
      row.last_name || "",
    displayName:
      row.display_name || "",
    phone:
      row.phone || "",
    avatarUrl:
      profileAvatarUrl(row),
    avatarUpdatedAt:
      row.avatar_updated_at || null,
    platformRole:
      row.platform_role,
    status:
      row.status,
    emailVerified:
      Boolean(
        row.email_verified
      ),
    mfaEnabled:
      Boolean(
        row.mfa_enabled
      ),
    mfaRequired:
      Boolean(
        row.mfa_required
      ),
    lastLoginAt:
      row.last_login_at,
    passwordUpdatedAt:
      row.password_updated_at,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at
  };
}

function publicPreferences(row) {
  return {
    theme:
      row.theme,
    accent:
      row.accent,
    reducedMotion:
      Boolean(
        row.reduced_motion
      ),
    compactMode:
      Boolean(
        row.compact_mode
      ),
    language:
      row.language,
    timezone:
      row.timezone,
    dateFormat:
      row.date_format,
    timeFormat:
      row.time_format,
    emailNotifications:
      Boolean(
        row.email_notifications
      ),
    pushNotifications:
      Boolean(
        row.push_notifications
      ),
    securityNotifications:
      Boolean(
        row.security_notifications
      ),
    billingNotifications:
      Boolean(
        row.billing_notifications
      ),
    systemNotifications:
      Boolean(
        row.system_notifications
      ),
    digestFrequency:
      row.digest_frequency,
    createdAt:
      row.created_at,
    updatedAt:
      row.updated_at
  };
}

async function getProfile(
  userId
) {
  const result =
    await dbQuery(
      `
        SELECT
          id,
          email,
          first_name,
          last_name,
          display_name,
          phone,
          avatar_url,
          avatar_file_name,
          avatar_updated_at,
          platform_role,
          status,
          email_verified,
          mfa_enabled,
          mfa_required,
          last_login_at,
          password_updated_at,
          created_at,
          updated_at
        FROM users
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [userId]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "User account was not found.",
      404
    );
  }

  return publicProfile(
    result.rows[0]
  );
}

async function ensurePreferences(
  userId
) {
  await dbQuery(
    `
      INSERT INTO
        backend_user_preferences (
          user_id
        )
      VALUES (
        $1::uuid
      )
      ON CONFLICT (
        user_id
      )
      DO NOTHING
    `,
    [userId]
  );
}

async function getPreferences(
  userId
) {
  await ensurePreferences(
    userId
  );

  const result =
    await dbQuery(
      `
        SELECT *
        FROM
          backend_user_preferences
        WHERE
          user_id = $1::uuid
        LIMIT 1
      `,
      [userId]
    );

  return publicPreferences(
    result.rows[0]
  );
}

async function getOrganizationForUser(
  userId
) {
  const result =
    await dbQuery(
      `
        SELECT
          organization.id,
          organization.name,
          organization.slug,
          organization.plan,
          organization.status,
          membership.role,
          organization.legal_name,
          organization.website_url,
          organization.business_email,
          organization.phone,
          organization.industry,
          organization.company_size,
          organization.address_line_1,
          organization.address_line_2,
          organization.city,
          organization.region,
          organization.postal_code,
          organization.country_code,
          organization.logo_url,
          organization.logo_updated_at,
          workspace.description,
          workspace.visibility,
          workspace.member_join_policy,
          workspace.default_role,
          workspace.support_email,
          organization.created_at,
          organization.updated_at
        FROM
          backend_organization_memberships
            AS membership
        JOIN
          backend_organizations
            AS organization
          ON organization.id =
             membership.organization_id
        LEFT JOIN
          backend_workspace_settings
            AS workspace
          ON workspace.organization_id =
             organization.id
        WHERE
          membership.user_id =
            $1::uuid
          AND membership.status =
            'active'
          AND organization.status =
            'active'
        ORDER BY
          CASE membership.role
            WHEN 'owner' THEN 1
            WHEN 'admin' THEN 2
            WHEN 'manager' THEN 3
            ELSE 4
          END,
          organization.created_at ASC
        LIMIT 1
      `,
      [userId]
    );

  const row =
    result.rows[0];

  if (!row) {
    return {
      organization: null,
      workspace: null
    };
  }

  return {
    organization: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      status: row.status,
      role: row.role,
      legalName:
        row.legal_name || "",
      websiteUrl:
        row.website_url || "",
      businessEmail:
        row.business_email || "",
      phone:
        row.phone || "",
      industry:
        row.industry || "",
      companySize:
        row.company_size || "",
      addressLine1:
        row.address_line_1 || "",
      addressLine2:
        row.address_line_2 || "",
      city:
        row.city || "",
      region:
        row.region || "",
      postalCode:
        row.postal_code || "",
      countryCode:
        row.country_code || "",
      logoUrl:
        row.logo_url || null,
      logoUpdatedAt:
        row.logo_updated_at || null,
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at
    },
    workspace: {
      description:
        row.description || "",
      visibility:
        row.visibility ||
        "private",
      memberJoinPolicy:
        row.member_join_policy ||
        "invite_only",
      defaultRole:
        row.default_role ||
        "viewer",
      supportEmail:
        row.support_email || ""
    }
  };
}

async function getOverviewForUser({
  userId,
  currentSessionId
}) {
  const [
    profile,
    preferences,
    organizationResult
  ] = await Promise.all([
    getProfile(userId),
    getPreferences(userId),
    getOrganizationForUser(
      userId
    )
  ]);

  const organizationId =
    organizationResult
      .organization
      ?.id || null;

  const [
    sessionsResult,
    countsResult,
    auditResult
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          id::text AS id,
          ip_address::text
            AS "ipAddress",
          user_agent
            AS "userAgent",
          device_label
            AS "deviceLabel",
          auth_level
            AS "authLevel",
          mfa_verified
            AS "mfaVerified",
          risk_score
            AS "riskScore",
          created_at
            AS "createdAt",
          last_seen_at
            AS "lastSeenAt",
          expires_at
            AS "expiresAt",
          revoked_at
            AS "revokedAt",
          (
            id = $2::uuid
          ) AS "isCurrent"
        FROM sessions
        WHERE user_id =
          $1::uuid
          AND revoked_at
            IS NULL
          AND expires_at >
            NOW()
        ORDER BY
          last_seen_at
            DESC NULLS LAST,
          created_at DESC
      `,
      [
        userId,
        currentSessionId
      ]
    ),

    dbQuery(
      `
        SELECT
          (
            SELECT COUNT(*)::int
            FROM app_memberships
            WHERE user_id =
              $1::uuid
              AND status =
                'active'
          ) AS applications,

          (
            SELECT COUNT(*)::int
            FROM
              backend_organization_memberships
            WHERE
              organization_id =
                $2::text
              AND status =
                'active'
          ) AS members,

          (
            SELECT COUNT(*)::int
            FROM backend_teams
            WHERE organization_id =
              $2::text
              AND status =
                'active'
          ) AS teams,

          (
            SELECT COUNT(*)::int
            FROM backend_api_keys
            WHERE COALESCE(
              status,
              'active'
            ) = 'active'
          ) AS active_api_keys,

          (
            SELECT COUNT(*)::int
            FROM backend_webhooks
            WHERE status =
              'active'
          ) AS active_webhooks,

          (
            SELECT COUNT(*)::int
            FROM
              backend_notification_channels
            WHERE status =
              'active'
          ) AS notification_channels
      `,
      [
        userId,
        organizationId
      ]
    ),

    dbQuery(
      `
        SELECT
          audit.id::text
            AS id,
          audit.action,
          audit.entity_type
            AS "entityType",
          audit.entity_id::text
            AS "entityId",
          audit.ip_address::text
            AS "ipAddress",
          audit.metadata,
          audit.created_at
            AS "createdAt",
          COALESCE(
            actor.display_name,
            actor.email,
            'System'
          ) AS actor
        FROM audit_logs
          AS audit
        LEFT JOIN users
          AS actor
          ON actor.id =
             audit.user_id
        WHERE audit.user_id =
          $1::uuid
        ORDER BY
          audit.created_at DESC
        LIMIT 100
      `,
      [userId]
    )
  ]);

  const counts =
    countsResult.rows[0] ||
    {};

  return {
    profile,
    preferences,
    organization:
      organizationResult
        .organization,
    workspace:
      organizationResult
        .workspace,
    sessions:
      sessionsResult.rows,
    counts: {
      applications:
        Number(
          counts.applications ||
          0
        ),
      members:
        Number(
          counts.members ||
          0
        ),
      teams:
        Number(
          counts.teams ||
          0
        ),
      activeApiKeys:
        Number(
          counts.active_api_keys ||
          0
        ),
      activeWebhooks:
        Number(
          counts.active_webhooks ||
          0
        ),
      notificationChannels:
        Number(
          counts.notification_channels ||
          0
        )
    },
    auditLogs:
      auditResult.rows
  };
}

async function updateProfileForUser({
  userId,
  input,
  ipAddress
}) {
  const current =
    await getProfile(
      userId
    );

  const firstName =
    cleanText(
      input.firstName ??
        current.firstName,
      100
    );

  const lastName =
    cleanText(
      input.lastName ??
        current.lastName,
      100
    );

  const requestedDisplayName =
    cleanText(
      input.displayName ??
        current.displayName,
      160
    );

  const displayName =
    requestedDisplayName ||
    [firstName, lastName]
      .filter(Boolean)
      .join(" ") ||
    current.email;

  const phone =
    nullableText(
      input.phone ??
        current.phone,
      50
    );

  const result =
    await dbQuery(
      `
        UPDATE users
        SET
          first_name = $2,
          last_name = $3,
          display_name = $4,
          phone = $5,
          updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING
          id,
          email,
          first_name,
          last_name,
          display_name,
          phone,
          avatar_url,
          avatar_file_name,
          avatar_updated_at,
          platform_role,
          status,
          email_verified,
          mfa_enabled,
          mfa_required,
          last_login_at,
          password_updated_at,
          created_at,
          updated_at
      `,
      [
        userId,
        firstName || null,
        lastName || null,
        displayName,
        phone
      ]
    );

  await logAudit({
    userId,
    action:
      "settings.profile.updated",
    entityType:
      "user",
    entityId:
      userId,
    ipAddress,
    metadata: {
      displayName,
      phoneUpdated:
        phone !==
        (current.phone || null)
    }
  });

  return publicProfile(
    result.rows[0]
  );
}

function detectManagedImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return {
      contentType: "image/jpeg",
      extension: "jpg"
    };
  }

  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
        0x0d, 0x0a, 0x1a, 0x0a
      ])
    )
  ) {
    return {
      contentType: "image/png",
      extension: "png"
    };
  }

  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return {
      contentType: "image/webp",
      extension: "webp"
    };
  }

  return null;
}

function safeManagedImagePath(
  root,
  fileName
) {
  const normalized = path.basename(
    String(fileName || "")
  );

  if (!normalized || normalized !== fileName) {
    return null;
  }

  const filePath = path.join(
    root,
    normalized
  );

  return filePath.startsWith(
    root + path.sep
  )
    ? filePath
    : null;
}

function safeAvatarPath(fileName) {
  return safeManagedImagePath(
    PROFILE_AVATAR_ROOT,
    fileName
  );
}

function safeBusinessLogoPath(fileName) {
  return safeManagedImagePath(
    BUSINESS_LOGO_ROOT,
    fileName
  );
}

async function getAvatarForPublicUser(
  userId
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(userId || "")
    )
  ) {
    throw serviceError(
      "Profile avatar was not found.",
      404
    );
  }

  const result = await dbQuery(
    `
      SELECT
        avatar_file_name,
        avatar_content_type,
        avatar_size_bytes,
        avatar_updated_at
      FROM users
      WHERE
        id = $1::uuid
        AND status = 'active'
      LIMIT 1
    `,
    [userId]
  );

  const row = result.rows[0];
  const filePath = safeAvatarPath(
    row?.avatar_file_name
  );

  if (!row || !filePath) {
    throw serviceError(
      "Profile avatar was not found.",
      404
    );
  }

  try {
    await fileSystem.access(
      filePath,
      fs.constants.R_OK
    );
  } catch {
    throw serviceError(
      "Profile avatar was not found.",
      404
    );
  }

  return {
    filePath,
    contentType:
      row.avatar_content_type ||
      "application/octet-stream",
    sizeBytes:
      Number(
        row.avatar_size_bytes || 0
      ),
    updatedAt:
      row.avatar_updated_at || null
  };
}

async function saveAvatarForUser({
  userId,
  buffer,
  ipAddress
}) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0
  ) {
    throw serviceError(
      "Choose a profile photo to upload.",
      400
    );
  }

  if (
    buffer.length >
    PROFILE_AVATAR_MAX_BYTES
  ) {
    throw serviceError(
      "Profile photos must be 2 MB or smaller.",
      413
    );
  }

  const detected =
    detectManagedImageType(buffer);

  if (!detected) {
    throw serviceError(
      "Use a JPEG, PNG, or WebP profile photo.",
      415
    );
  }

  const currentResult =
    await dbQuery(
      `
        SELECT avatar_file_name
        FROM users
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [userId]
    );

  if (!currentResult.rows[0]) {
    throw serviceError(
      "User account was not found.",
      404
    );
  }

  await fileSystem.mkdir(
    PROFILE_AVATAR_ROOT,
    {
      recursive: true,
      mode: 0o750
    }
  );

  const fileName =
    `${userId}-${crypto.randomUUID()}.${detected.extension}`;
  const finalPath =
    safeAvatarPath(fileName);
  const temporaryPath =
    `${finalPath}.uploading`;

  await fileSystem.writeFile(
    temporaryPath,
    buffer,
    {
      mode: 0o640,
      flag: "wx"
    }
  );

  await fileSystem.rename(
    temporaryPath,
    finalPath
  );

  const avatarUrl =
    profileAvatarUrl({
      id: userId,
      avatar_file_name:
        fileName,
      avatar_updated_at:
        new Date()
    });

  try {
    await dbQuery(
      `
        UPDATE users
        SET
          avatar_url = $2,
          avatar_file_name = $3,
          avatar_content_type = $4,
          avatar_size_bytes = $5,
          avatar_updated_at = NOW(),
          updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [
        userId,
        avatarUrl,
        fileName,
        detected.contentType,
        buffer.length
      ]
    );
  } catch (requestError) {
    await fileSystem.unlink(
      finalPath
    ).catch(() => {});
    throw requestError;
  }

  const previousPath =
    safeAvatarPath(
      currentResult.rows[0]
        .avatar_file_name
    );

  if (
    previousPath &&
    previousPath !== finalPath
  ) {
    await fileSystem.unlink(
      previousPath
    ).catch(() => {});
  }

  await logAudit({
    userId,
    action:
      "settings.profile.avatar_updated",
    entityType:
      "user",
    entityId:
      userId,
    ipAddress,
    metadata: {
      contentType:
        detected.contentType,
      sizeBytes:
        buffer.length
    }
  });

  return getProfile(userId);
}

async function removeAvatarForUser({
  userId,
  ipAddress
}) {
  const result = await dbQuery(
    `
      WITH previous AS (
        SELECT
          id,
          avatar_file_name
        FROM users
        WHERE id = $1::uuid
        FOR UPDATE
      ),
      updated AS (
        UPDATE users
        SET
          avatar_url = NULL,
          avatar_file_name = NULL,
          avatar_content_type = NULL,
          avatar_size_bytes = NULL,
          avatar_updated_at = NOW(),
          updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id
      )
      SELECT previous.avatar_file_name
      FROM previous
      JOIN updated USING (id)
    `,
    [userId]
  );

  if (!result.rows[0]) {
    throw serviceError(
      "User account was not found.",
      404
    );
  }

  const previousPath =
    safeAvatarPath(
      result.rows[0]
        .avatar_file_name
    );

  if (previousPath) {
    await fileSystem.unlink(
      previousPath
    ).catch(() => {});
  }

  await logAudit({
    userId,
    action:
      "settings.profile.avatar_removed",
    entityType:
      "user",
    entityId:
      userId,
    ipAddress,
    metadata: {}
  });

  return getProfile(userId);
}

function requireBusinessAdministrator(
  organization,
  platformRole
) {
  if (!organization) {
    throw serviceError(
      "No active business profile was found.",
      404
    );
  }

  const permitted =
    ["owner", "admin"].includes(
      organization.role
    ) ||
    ["owner", "admin"].includes(
      platformRole
    );

  if (!permitted) {
    throw serviceError(
      "Business profile administration requires owner or administrator access.",
      403
    );
  }
}

async function getBusinessLogoForPublicOrganization(
  organizationId
) {
  const normalizedId =
    cleanText(
      organizationId,
      160
    );

  if (
    !normalizedId ||
    !/^[a-zA-Z0-9_-]+$/.test(
      normalizedId
    )
  ) {
    throw serviceError(
      "Business logo was not found.",
      404
    );
  }

  const result = await dbQuery(
    `
      SELECT
        logo_file_name,
        logo_content_type,
        logo_size_bytes,
        logo_updated_at
      FROM backend_organizations
      WHERE
        id = $1
        AND status = 'active'
      LIMIT 1
    `,
    [normalizedId]
  );

  const row = result.rows[0];
  const filePath =
    safeBusinessLogoPath(
      row?.logo_file_name
    );

  if (!row || !filePath) {
    throw serviceError(
      "Business logo was not found.",
      404
    );
  }

  try {
    await fileSystem.access(
      filePath,
      fs.constants.R_OK
    );
  } catch {
    throw serviceError(
      "Business logo was not found.",
      404
    );
  }

  return {
    filePath,
    contentType:
      row.logo_content_type ||
      "application/octet-stream",
    sizeBytes:
      Number(
        row.logo_size_bytes || 0
      ),
    updatedAt:
      row.logo_updated_at || null
  };
}

async function saveBusinessLogoForUser({
  userId,
  platformRole,
  buffer,
  ipAddress
}) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0
  ) {
    throw serviceError(
      "Choose a business logo to upload.",
      400
    );
  }

  if (
    buffer.length >
    BUSINESS_LOGO_MAX_BYTES
  ) {
    throw serviceError(
      "Business logos must be 4 MB or smaller.",
      413
    );
  }

  const detected =
    detectManagedImageType(
      buffer
    );

  if (!detected) {
    throw serviceError(
      "Use a JPEG, PNG, or WebP business logo.",
      415
    );
  }

  const current =
    await getOrganizationForUser(
      userId
    );

  requireBusinessAdministrator(
    current.organization,
    platformRole
  );

  const organizationId =
    current.organization.id;

  const currentResult =
    await dbQuery(
      `
        SELECT logo_file_name
        FROM backend_organizations
        WHERE id = $1
        LIMIT 1
      `,
      [organizationId]
    );

  await fileSystem.mkdir(
    BUSINESS_LOGO_ROOT,
    {
      recursive: true,
      mode: 0o750
    }
  );

  const fileName =
    `${organizationId}-${crypto.randomUUID()}.${detected.extension}`;
  const finalPath =
    safeBusinessLogoPath(
      fileName
    );
  const temporaryPath =
    `${finalPath}.uploading`;

  await fileSystem.writeFile(
    temporaryPath,
    buffer,
    {
      mode: 0o640,
      flag: "wx"
    }
  );

  await fileSystem.rename(
    temporaryPath,
    finalPath
  );

  const logoUrl =
    `${PUBLIC_BACKEND_URL}/api/settings/business-logos/${organizationId}?v=${Date.now()}`;

  try {
    await dbQuery(
      `
        UPDATE backend_organizations
        SET
          logo_url = $2,
          logo_file_name = $3,
          logo_content_type = $4,
          logo_size_bytes = $5,
          logo_updated_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        organizationId,
        logoUrl,
        fileName,
        detected.contentType,
        buffer.length
      ]
    );
  } catch (requestError) {
    await fileSystem.unlink(
      finalPath
    ).catch(() => {});
    throw requestError;
  }

  const previousPath =
    safeBusinessLogoPath(
      currentResult.rows[0]
        ?.logo_file_name
    );

  if (
    previousPath &&
    previousPath !== finalPath
  ) {
    await fileSystem.unlink(
      previousPath
    ).catch(() => {});
  }

  await logAudit({
    userId,
    action:
      "settings.business.logo_updated",
    entityType:
      "organization",
    entityId:
      organizationId,
    ipAddress,
    metadata: {
      contentType:
        detected.contentType,
      sizeBytes:
        buffer.length
    }
  });

  return getOrganizationForUser(
    userId
  );
}

async function removeBusinessLogoForUser({
  userId,
  platformRole,
  ipAddress
}) {
  const current =
    await getOrganizationForUser(
      userId
    );

  requireBusinessAdministrator(
    current.organization,
    platformRole
  );

  const organizationId =
    current.organization.id;
  const result = await dbQuery(
    `
      WITH previous AS (
        SELECT id, logo_file_name
        FROM backend_organizations
        WHERE id = $1
        FOR UPDATE
      ),
      updated AS (
        UPDATE backend_organizations
        SET
          logo_url = NULL,
          logo_file_name = NULL,
          logo_content_type = NULL,
          logo_size_bytes = NULL,
          logo_updated_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING id
      )
      SELECT previous.logo_file_name
      FROM previous
      JOIN updated USING (id)
    `,
    [organizationId]
  );

  const previousPath =
    safeBusinessLogoPath(
      result.rows[0]
        ?.logo_file_name
    );

  if (previousPath) {
    await fileSystem.unlink(
      previousPath
    ).catch(() => {});
  }

  await logAudit({
    userId,
    action:
      "settings.business.logo_removed",
    entityType:
      "organization",
    entityId:
      organizationId,
    ipAddress,
    metadata: {}
  });

  return getOrganizationForUser(
    userId
  );
}

async function updateBusinessProfileForUser({
  userId,
  platformRole,
  input,
  ipAddress
}) {
  const current =
    await getOrganizationForUser(
      userId
    );
  const organization =
    current.organization;

  requireBusinessAdministrator(
    organization,
    platformRole
  );

  const name =
    cleanText(
      input.name ??
        organization.name,
      100
    );

  if (name.length < 2) {
    throw serviceError(
      "Business name must contain at least two characters."
    );
  }

  const legalName =
    nullableText(
      input.legalName ??
        organization.legalName,
      200
    );
  const websiteUrl =
    nullableWebUrl(
      input.websiteUrl ??
        organization.websiteUrl
    );
  const businessEmail =
    nullableEmail(
      input.businessEmail ??
        organization.businessEmail,
      "Business email"
    );
  const phone =
    nullableText(
      input.phone ??
        organization.phone,
      50
    );
  const industry =
    nullableText(
      input.industry ??
        organization.industry,
      120
    );
  const companySize =
    nullableText(
      input.companySize ??
        organization.companySize,
      50
    );
  const addressLine1 =
    nullableText(
      input.addressLine1 ??
        organization.addressLine1,
      200
    );
  const addressLine2 =
    nullableText(
      input.addressLine2 ??
        organization.addressLine2,
      200
    );
  const city =
    nullableText(
      input.city ??
        organization.city,
      120
    );
  const region =
    nullableText(
      input.region ??
        organization.region,
      120
    );
  const postalCode =
    nullableText(
      input.postalCode ??
        organization.postalCode,
      30
    );
  const requestedCountry =
    cleanText(
      input.countryCode ??
        organization.countryCode,
      2
    ).toUpperCase();
  const countryCode =
    requestedCountry || null;

  if (
    countryCode &&
    !/^[A-Z]{2}$/.test(
      countryCode
    )
  ) {
    throw serviceError(
      "Country must use a two-letter country code."
    );
  }

  const workspace =
    current.workspace || {};
  const description =
    nullableText(
      input.description ??
        workspace.description,
      1000
    );
  const supportEmail =
    nullableEmail(
      input.supportEmail ??
        workspace.supportEmail,
      "Support email"
    );

  const client =
    await getPool()
      .connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE backend_organizations
        SET
          name = $2,
          legal_name = $3,
          website_url = $4,
          business_email = $5,
          phone = $6,
          industry = $7,
          company_size = $8,
          address_line_1 = $9,
          address_line_2 = $10,
          city = $11,
          region = $12,
          postal_code = $13,
          country_code = $14,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        organization.id,
        name,
        legalName,
        websiteUrl,
        businessEmail,
        phone,
        industry,
        companySize,
        addressLine1,
        addressLine2,
        city,
        region,
        postalCode,
        countryCode
      ]
    );
    await client.query(
      `
        INSERT INTO backend_workspace_settings (
          organization_id,
          description,
          support_email,
          updated_at
        )
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (organization_id)
        DO UPDATE SET
          description = EXCLUDED.description,
          support_email = EXCLUDED.support_email,
          updated_at = NOW()
      `,
      [
        organization.id,
        description,
        supportEmail
      ]
    );
    await client.query("COMMIT");
  } catch (requestError) {
    await client.query("ROLLBACK");
    throw requestError;
  } finally {
    client.release();
  }

  await logAudit({
    userId,
    action:
      "settings.business.profile_updated",
    entityType:
      "organization",
    entityId:
      organization.id,
    ipAddress,
    metadata: {
      name,
      countryCode,
      websiteConfigured:
        Boolean(websiteUrl),
      businessEmailConfigured:
        Boolean(businessEmail)
    }
  });

  return getOrganizationForUser(
    userId
  );
}

async function updatePreferencesForUser({
  userId,
  input,
  ipAddress
}) {
  const current =
    await getPreferences(
      userId
    );

  const merged = {
    ...current,
    ...input
  };

  const theme =
    allowedValue(
      merged.theme,
      [
        "system",
        "light",
        "dark"
      ],
      "system"
    );

  const accent =
    allowedValue(
      merged.accent,
      [
        "indigo",
        "emerald",
        "rose",
        "blue",
        "amber",
        "cyan",
        "zinc"
      ],
      "indigo"
    );

  const language =
    cleanText(
      merged.language,
      20
    ) || "en-US";

  const timezone =
    cleanText(
      merged.timezone,
      100
    ) || "UTC";

  const dateFormat =
    allowedValue(
      merged.dateFormat,
      [
        "MM/DD/YYYY",
        "DD/MM/YYYY",
        "YYYY-MM-DD"
      ],
      "MM/DD/YYYY"
    );

  const timeFormat =
    allowedValue(
      merged.timeFormat,
      [
        "12h",
        "24h"
      ],
      "12h"
    );

  const digestFrequency =
    allowedValue(
      merged.digestFrequency,
      [
        "instant",
        "daily",
        "weekly",
        "off"
      ],
      "instant"
    );

  const result =
    await dbQuery(
      `
        INSERT INTO
          backend_user_preferences (
            user_id,
            theme,
            accent,
            reduced_motion,
            compact_mode,
            language,
            timezone,
            date_format,
            time_format,
            email_notifications,
            push_notifications,
            security_notifications,
            billing_notifications,
            system_notifications,
            digest_frequency,
            updated_at
          )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          NOW()
        )
        ON CONFLICT (
          user_id
        )
        DO UPDATE SET
          theme =
            EXCLUDED.theme,
          accent =
            EXCLUDED.accent,
          reduced_motion =
            EXCLUDED.reduced_motion,
          compact_mode =
            EXCLUDED.compact_mode,
          language =
            EXCLUDED.language,
          timezone =
            EXCLUDED.timezone,
          date_format =
            EXCLUDED.date_format,
          time_format =
            EXCLUDED.time_format,
          email_notifications =
            EXCLUDED.email_notifications,
          push_notifications =
            EXCLUDED.push_notifications,
          security_notifications =
            EXCLUDED.security_notifications,
          billing_notifications =
            EXCLUDED.billing_notifications,
          system_notifications =
            EXCLUDED.system_notifications,
          digest_frequency =
            EXCLUDED.digest_frequency,
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        userId,
        theme,
        accent,
        Boolean(
          merged.reducedMotion
        ),
        Boolean(
          merged.compactMode
        ),
        language,
        timezone,
        dateFormat,
        timeFormat,
        Boolean(
          merged.emailNotifications
        ),
        Boolean(
          merged.pushNotifications
        ),
        Boolean(
          merged.securityNotifications
        ),
        Boolean(
          merged.billingNotifications
        ),
        Boolean(
          merged.systemNotifications
        ),
        digestFrequency
      ]
    );

  await logAudit({
    userId,
    action:
      "settings.preferences.updated",
    entityType:
      "user_preferences",
    entityId:
      userId,
    ipAddress,
    metadata: {
      theme,
      accent,
      language,
      timezone,
      reducedMotion:
        Boolean(
          merged.reducedMotion
        ),
      compactMode:
        Boolean(
          merged.compactMode
        )
    }
  });

  return publicPreferences(
    result.rows[0]
  );
}

async function resetPreferencesForUser({
  userId,
  ipAddress
}) {
  await dbQuery(
    `
      DELETE FROM
        backend_user_preferences
      WHERE user_id =
        $1::uuid
    `,
    [userId]
  );

  const preferences =
    await getPreferences(
      userId
    );

  await logAudit({
    userId,
    action:
      "settings.preferences.reset",
    entityType:
      "user_preferences",
    entityId:
      userId,
    ipAddress,
    metadata: {
      resetToDefaults: true
    }
  });

  return preferences;
}

async function updateWorkspaceForUser({
  userId,
  platformRole,
  input,
  ipAddress
}) {
  const current =
    await getOrganizationForUser(
      userId
    );

  const organization =
    current.organization;

  if (!organization) {
    throw serviceError(
      "No active workspace was found.",
      404
    );
  }

  const permitted =
    ["owner", "admin"].includes(
      organization.role
    ) ||
    ["owner", "admin"].includes(
      platformRole
    );

  if (!permitted) {
    throw serviceError(
      "Workspace owner or administrator access is required.",
      403
    );
  }

  const name =
    cleanText(
      input.name ??
        organization.name,
      100
    );

  if (
    name.length < 2
  ) {
    throw serviceError(
      "Workspace name must contain at least two characters."
    );
  }

  const workspace =
    current.workspace || {};

  const description =
    nullableText(
      input.description ??
        workspace.description,
      1000
    );

  const visibility =
    allowedValue(
      input.visibility ??
        workspace.visibility,
      [
        "private",
        "organization"
      ],
      "private"
    );

  const memberJoinPolicy =
    allowedValue(
      input.memberJoinPolicy ??
        workspace.memberJoinPolicy,
      [
        "invite_only",
        "request"
      ],
      "invite_only"
    );

  const defaultRole =
    allowedValue(
      input.defaultRole ??
        workspace.defaultRole,
      [
        "viewer",
        "user",
        "developer",
        "manager"
      ],
      "viewer"
    );

  const supportEmail =
    nullableText(
      input.supportEmail ??
        workspace.supportEmail,
      320
    );

  if (
    supportEmail &&
    !supportEmail.includes("@")
  ) {
    throw serviceError(
      "Support email must be a valid email address."
    );
  }

  const pool =
    getPool();

  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      `
        UPDATE
          backend_organizations
        SET
          name = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        organization.id,
        name
      ]
    );

    await client.query(
      `
        INSERT INTO
          backend_workspace_settings (
            organization_id,
            description,
            visibility,
            member_join_policy,
            default_role,
            support_email,
            updated_at
          )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NOW()
        )
        ON CONFLICT (
          organization_id
        )
        DO UPDATE SET
          description =
            EXCLUDED.description,
          visibility =
            EXCLUDED.visibility,
          member_join_policy =
            EXCLUDED.member_join_policy,
          default_role =
            EXCLUDED.default_role,
          support_email =
            EXCLUDED.support_email,
          updated_at =
            NOW()
      `,
      [
        organization.id,
        description,
        visibility,
        memberJoinPolicy,
        defaultRole,
        supportEmail
      ]
    );

    await client.query(
      "COMMIT"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }

  await logAudit({
    userId,
    action:
      "settings.workspace.updated",
    entityType:
      "organization",
    entityId:
      organization.id,
    ipAddress,
    metadata: {
      name,
      visibility,
      memberJoinPolicy,
      defaultRole,
      supportEmail
    }
  });

  return getOrganizationForUser(
    userId
  );
}

async function changePasswordForUser({
  userId,
  currentSessionId,
  currentPassword,
  newPassword,
  ipAddress
}) {
  if (
    typeof currentPassword !==
      "string" ||
    !currentPassword
  ) {
    throw serviceError(
      "Current password is required."
    );
  }

  if (
    typeof newPassword !==
      "string" ||
    newPassword.length < 12
  ) {
    throw serviceError(
      "New password must contain at least 12 characters."
    );
  }

  if (
    newPassword.length > 128
  ) {
    throw serviceError(
      "New password is too long."
    );
  }

  if (
    currentPassword ===
    newPassword
  ) {
    throw serviceError(
      "New password must be different from the current password."
    );
  }

  const userResult =
    await dbQuery(
      `
        SELECT
          password_hash
        FROM users
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [userId]
    );

  const user =
    userResult.rows[0];

  if (
    !user ||
    !user.password_hash
  ) {
    throw serviceError(
      "Password authentication is unavailable for this account.",
      409
    );
  }

  const valid =
    await bcrypt.compare(
      currentPassword,
      user.password_hash
    );

  if (!valid) {
    throw serviceError(
      "Current password is incorrect.",
      401
    );
  }

  const passwordHash =
    await bcrypt.hash(
      newPassword,
      12
    );

  const pool =
    getPool();

  const client =
    await pool.connect();

  let revokedSessions = 0;

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      `
        UPDATE users
        SET
          password_hash = $2,
          password_updated_at =
            NOW(),
          updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [
        userId,
        passwordHash
      ]
    );

    const revokeResult =
      await client.query(
        `
          UPDATE sessions
          SET revoked_at =
            NOW()
          WHERE
            user_id =
              $1::uuid
            AND id <>
              $2::uuid
            AND revoked_at
              IS NULL
        `,
        [
          userId,
          currentSessionId
        ]
      );

    revokedSessions =
      revokeResult.rowCount ||
      0;

    await client.query(
      "COMMIT"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }

  await logAudit({
    userId,
    action:
      "settings.password.changed",
    entityType:
      "user",
    entityId:
      userId,
    ipAddress,
    metadata: {
      revokedOtherSessions:
        revokedSessions
    }
  });

  return {
    message:
      "Password updated successfully.",
    revokedOtherSessions:
      revokedSessions
  };
}

async function revokeUserSession({
  userId,
  currentSessionId,
  targetSessionId,
  ipAddress
}) {
  if (
    !targetSessionId
  ) {
    throw serviceError(
      "Session identifier is required."
    );
  }

  if (
    targetSessionId ===
    currentSessionId
  ) {
    throw serviceError(
      "The current session cannot be revoked from this control.",
      409
    );
  }

  const result =
    await dbQuery(
      `
        UPDATE sessions
        SET revoked_at =
          NOW()
        WHERE
          id = $1::uuid
          AND user_id =
            $2::uuid
          AND revoked_at
            IS NULL
        RETURNING
          id::text AS id
      `,
      [
        targetSessionId,
        userId
      ]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "Active session was not found.",
      404
    );
  }

  await logAudit({
    userId,
    action:
      "settings.session.revoked",
    entityType:
      "session",
    entityId:
      targetSessionId,
    ipAddress,
    metadata: {
      revokedFromSettings: true
    }
  });

  return {
    id:
      result.rows[0].id,
    revoked: true
  };
}

async function createSettingsExport({
  userId,
  currentSessionId,
  ipAddress
}) {
  const overview =
    await getOverviewForUser({
      userId,
      currentSessionId
    });

  const organizationId =
    overview.organization?.id ||
    null;

  const [
    appsResult,
    teamsResult
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          app.id,
          app.name,
          app.domain,
          app.description,
          app.status
            AS "appStatus",
          membership.role,
          membership.status
            AS "membershipStatus"
        FROM app_memberships
          AS membership
        JOIN apps
          AS app
          ON app.id =
             membership.app_id
        WHERE
          membership.user_id =
            $1::uuid
        ORDER BY
          app.name ASC
      `,
      [userId]
    ),

    dbQuery(
      `
        SELECT
          id,
          name,
          description,
          status,
          created_at
            AS "createdAt",
          updated_at
            AS "updatedAt"
        FROM backend_teams
        WHERE organization_id =
          $1::text
        ORDER BY
          name ASC
      `,
      [organizationId]
    )
  ]);

  const exportedAt =
    new Date()
      .toISOString();

  const exportId =
    `setexp_${crypto
      .randomUUID()
      .replace(/-/g, "")}`;

  const data = {
    schema:
      "goodos.settings.export.v1",
    exportedAt,
    overview,
    applications:
      appsResult.rows,
    teams:
      teamsResult.rows
  };

  await dbQuery(
    `
      INSERT INTO
        backend_settings_export_requests (
          id,
          user_id,
          organization_id,
          status,
          format,
          requested_at,
          completed_at,
          metadata_json
        )
      VALUES (
        $1,
        $2::uuid,
        $3,
        'completed',
        'json',
        NOW(),
        NOW(),
        $4::jsonb
      )
    `,
    [
      exportId,
      userId,
      organizationId,
      JSON.stringify({
        applications:
          appsResult.rows.length,
        teams:
          teamsResult.rows.length,
        sessions:
          overview.sessions.length,
        auditEvents:
          overview.auditLogs.length
      })
    ]
  );

  await logAudit({
    userId,
    action:
      "settings.data.exported",
    entityType:
      "settings_export",
    entityId:
      exportId,
    ipAddress,
    metadata: {
      format: "json",
      applications:
        appsResult.rows.length,
      teams:
        teamsResult.rows.length
    }
  });

  return {
    exportId,
    exportedAt,
    fileName:
      `goodos-settings-${exportedAt.slice(
        0,
        10
      )}.json`,
    data
  };
}

module.exports = {
  getOverviewForUser,
  updateProfileForUser,
  getAvatarForPublicUser,
  saveAvatarForUser,
  removeAvatarForUser,
  getBusinessLogoForPublicOrganization,
  saveBusinessLogoForUser,
  removeBusinessLogoForUser,
  updateBusinessProfileForUser,
  updatePreferencesForUser,
  resetPreferencesForUser,
  updateWorkspaceForUser,
  changePasswordForUser,
  revokeUserSession,
  createSettingsExport,
  __test: {
    detectManagedImageType,
    safeManagedImagePath,
    nullableEmail,
    nullableWebUrl
  }
};
