"use strict";

const crypto =
  require("crypto");

const express =
  require("express");

const bcrypt =
  require("bcryptjs");

const rateLimit =
  require("express-rate-limit");

const {
  pool,
  query,
} = require("../config/database");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const {
  logAudit,
} = require("../services/audit.service");

const router =
  express.Router();

const SCIM_BASE =
  "https://backend.goodos.app/scim/v2";

const USER_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:User";

const GROUP_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:Group";

const LIST_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";

const ERROR_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:Error";

const PATCH_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const scimLimiter =
  rateLimit({
    windowMs:
      60 * 1000,

    limit: 600,

    standardHeaders: true,

    legacyHeaders: false,
  });

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto
      .randomUUID()
      .replaceAll(
        "-",
        ""
      )
  );
}

function cleanText(
  value,
  maximum = 320
) {
  const result =
    String(value || "")
      .trim()
      .replace(
        /\s+/g,
        " "
      )
      .slice(
        0,
        maximum
      );

  return (
    result ||
    null
  );
}

function normalizedEmail(
  value
) {
  const email =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/
      .test(email)
  ) {
    return null;
  }

  return email;
}

function scimRole(
  value
) {
  const role =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    [
      "admin",
      "manager",
      "member",
      "viewer",
    ].includes(role)
  ) {
    return role;
  }

  return "member";
}

function organizationRole(
  role
) {
  if (
    role === "admin"
  ) {
    return "admin";
  }

  if (
    role === "manager"
  ) {
    return "manager";
  }

  return "member";
}

function applicationRole(
  role
) {
  if (
    role === "admin"
  ) {
    return "admin";
  }

  if (
    role === "viewer"
  ) {
    return "viewer";
  }

  return "member";
}

function tokenPepper() {
  const value =
    String(
      process.env
        .SCIM_TOKEN_PEPPER ||
      ""
    );

  if (
    value.length < 32
  ) {
    const error =
      new Error(
        "SCIM token security is not configured."
      );

    error.statusCode = 503;
    error.scimType =
      "temporarilyUnavailable";

    throw error;
  }

  return value;
}

function hashToken(
  value
) {
  return crypto
    .createHmac(
      "sha256",
      tokenPepper()
    )
    .update(
      String(value || "")
    )
    .digest("hex");
}

function scimError(
  response,
  status,
  detail,
  scimType = null
) {
  const payload = {
    schemas: [
      ERROR_SCHEMA,
    ],

    status:
      String(status),

    detail,
  };

  if (scimType) {
    payload.scimType =
      scimType;
  }

  return response
    .status(status)
    .type(
      "application/scim+json"
    )
    .json(payload);
}

function listResponse({
  resources,
  startIndex,
  totalResults,
}) {
  return {
    schemas: [
      LIST_SCHEMA,
    ],

    totalResults,

    startIndex,

    itemsPerPage:
      resources.length,

    Resources:
      resources,
  };
}

function pageValue(
  value,
  fallback
) {
  const parsed =
    Number.parseInt(
      String(value || ""),
      10
    );

  if (
    !Number.isFinite(parsed) ||
    parsed < 1
  ) {
    return fallback;
  }

  return parsed;
}

function requestEmail(
  body
) {
  const primaryEmail =
    Array.isArray(
      body?.emails
    )
      ? (
          body.emails.find(
            entry =>
              entry?.primary ===
              true
          ) ||
          body.emails[0]
        )
      : null;

  return normalizedEmail(
    body?.userName ||
    primaryEmail?.value
  );
}

function requestRole(
  body
) {
  const primaryRole =
    Array.isArray(
      body?.roles
    )
      ? (
          body.roles.find(
            entry =>
              entry?.primary ===
              true
          ) ||
          body.roles[0]
        )
      : null;

  return scimRole(
    primaryRole?.value ||
    body?.userType
  );
}

function scimVersion(
  version
) {
  return (
    `W/"${Number(
      version || 1
    )}"`
  );
}

function userLocation(
  scimId
) {
  return (
    `${SCIM_BASE}/Users/` +
    encodeURIComponent(
      scimId
    )
  );
}

function groupLocation(
  groupId
) {
  return (
    `${SCIM_BASE}/Groups/` +
    encodeURIComponent(
      groupId
    )
  );
}

async function transaction(
  callback
) {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await callback(
        client
      );

    await client.query(
      "COMMIT"
    );

    return result;
  } catch (error) {
    await client
      .query(
        "ROLLBACK"
      )
      .catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

async function scimAuthentication(
  request,
  response,
  next
) {
  try {
    const authorization =
      String(
        request.headers
          .authorization ||
        ""
      );

    const match =
      authorization.match(
        /^Bearer\s+(.+)$/i
      );

    if (!match) {
      return scimError(
        response,
        401,
        "A valid SCIM bearer token is required."
      );
    }

    const rawToken =
      match[1].trim();

    if (
      rawToken.length < 40 ||
      rawToken.length > 300
    ) {
      return scimError(
        response,
        401,
        "The SCIM bearer token is invalid."
      );
    }

    const result =
      await query(
        `
          SELECT
            id,
            organization_id,
            name,
            token_prefix,
            created_by,
            expires_at
          FROM backend_scim_tokens
          WHERE token_hash =
                $1
            AND status =
                'active'
            AND (
              expires_at IS NULL
              OR expires_at >
                 NOW()
            )
          LIMIT 1
        `,
        [
          hashToken(
            rawToken
          ),
        ]
      );

    const token =
      result.rows[0];

    if (!token) {
      return scimError(
        response,
        401,
        "The SCIM bearer token is invalid or expired."
      );
    }

    request.scimToken =
      token;

    query(
      `
        UPDATE backend_scim_tokens
        SET
          last_used_at =
            NOW(),
          updated_at =
            NOW()
        WHERE id =
              $1
      `,
      [
        token.id,
      ]
    ).catch(() => {});

    return next();
  } catch (error) {
    return next(error);
  }
}

async function identityAdminRequired(
  request,
  response,
  next
) {
  try {
    const result =
      await query(
        `
          SELECT
            account.platform_role,

            membership.role
              AS membership_role

          FROM users
               AS account

          JOIN backend_organization_memberships
               AS membership
            ON membership.user_id =
               account.id

          WHERE account.id =
                $1::uuid

            AND membership.organization_id =
                $2

            AND account.status =
                'active'

            AND membership.status =
                'active'

          LIMIT 1
        `,
        [
          request.user.id,

          request.tenantContext
            .organizationId,
        ]
      );

    const identity =
      result.rows[0];

    const allowed =
      identity &&
      (
        [
          "owner",
          "admin",
        ].includes(
          identity.platform_role
        )
        ||
        [
          "owner",
          "admin",
        ].includes(
          identity.membership_role
        )
      );

    if (!allowed) {
      return response
        .status(403)
        .json({
          success: false,

          code:
            "IDENTITY_ADMIN_REQUIRED",

          message:
            "SCIM administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function auditScim({
  request,
  action,
  entityType,
  entityId,
  metadata = {},
  userId = null,
}) {
  return logAudit({
    userId:
      userId ||
      request.scimToken
        ?.created_by ||
      null,

    action,

    entityType,

    entityId,

    ipAddress:
      request.ip,

    metadata: {
      organizationId:
        request.scimToken
          ?.organization_id ||
        request.tenantContext
          ?.organizationId ||
        null,

      tokenId:
        request.scimToken
          ?.id ||
        null,

      userAgent:
        request.headers[
          "user-agent"
        ] || null,

      ...metadata,
    },
  }).catch(error => {
    console.error(
      "SCIM audit failed:",
      error.message
    );
  });
}

async function ensureOrganizationMembership({
  client,
  organizationId,
  userId,
  role,
}) {
  const normalizedRole =
    organizationRole(
      role
    );

  const update =
    await client.query(
      `
        UPDATE backend_organization_memberships
        SET
          role = $3,
          status = 'active',
          updated_at = NOW()
        WHERE organization_id =
              $1
          AND user_id =
              $2::uuid
      `,
      [
        organizationId,
        userId,
        normalizedRole,
      ]
    );

  if (
    update.rowCount === 0
  ) {
    await client.query(
      `
        INSERT INTO
          backend_organization_memberships (
            id,
            organization_id,
            user_id,
            role,
            status
          )
        VALUES (
          $1,
          $2,
          $3::uuid,
          $4,
          'active'
        )
      `,
      [
        identifier("orgmem"),
        organizationId,
        userId,
        normalizedRole,
      ]
    );
  }
}

async function syncApplicationMemberships({
  client,
  organizationId,
  userId,
  role,
  active,
}) {
  const appRole =
    applicationRole(
      role
    );

  await client.query(
    `
      INSERT INTO app_memberships (
        user_id,
        app_id,
        role,
        status,
        organization_id,
        project_id,
        environment_id
      )
      SELECT
        $1::uuid,
        app.id,
        $2,
        $3,
        $4,
        'proj_goodos_platform',
        'env_goodos_production'
      FROM apps AS app
      WHERE app.status =
            'active'
      ON CONFLICT (
        user_id,
        app_id
      )
      DO UPDATE SET
        role =
          EXCLUDED.role,

        status =
          EXCLUDED.status,

        organization_id =
          EXCLUDED.organization_id,

        project_id =
          EXCLUDED.project_id,

        environment_id =
          EXCLUDED.environment_id,

        updated_at =
          NOW()
    `,
    [
      userId,
      appRole,
      active
        ? "active"
        : "pending",
      organizationId,
    ]
  );
}

async function revokeUserSessions(
  client,
  userId
) {
  await client.query(
    `
      UPDATE sessions
      SET
        revoked_at =
          COALESCE(
            revoked_at,
            NOW()
          )
      WHERE user_id =
            $1::uuid
        AND revoked_at
            IS NULL
    `,
    [
      userId,
    ]
  );
}

async function loadScimUser(
  client,
  organizationId,
  scimId
) {
  const result =
    await client.query(
      `
        SELECT
          resource.scim_id,
          resource.external_id,
          resource.active
            AS resource_active,
          resource.version,
          resource.created_at
            AS resource_created_at,
          resource.updated_at
            AS resource_updated_at,

          account.id
            AS user_id,

          account.email,
          account.first_name,
          account.last_name,
          account.display_name,
          account.platform_role,
          account.status
            AS user_status,
          account.email_verified,

          membership.role
            AS organization_role,

          membership.status
            AS membership_status

        FROM backend_scim_resources
             AS resource

        JOIN users
             AS account
          ON account.id::text =
             resource.local_id

        LEFT JOIN
          backend_organization_memberships
             AS membership
          ON membership.user_id =
             account.id
         AND membership.organization_id =
             resource.organization_id

        WHERE resource.organization_id =
              $1

          AND resource.resource_type =
              'User'

          AND resource.scim_id =
              $2

        LIMIT 1
      `,
      [
        organizationId,
        scimId,
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

function userRepresentation(
  row
) {
  const active =
    Boolean(
      row.resource_active
    ) &&
    row.user_status ===
      "active" &&
    row.membership_status ===
      "active";

  return {
    schemas: [
      USER_SCHEMA,
    ],

    id:
      row.scim_id,

    externalId:
      row.external_id ||
      undefined,

    userName:
      row.email,

    name: {
      givenName:
        row.first_name ||
        "",

      familyName:
        row.last_name ||
        "",

      formatted:
        row.display_name ||
        [
          row.first_name,
          row.last_name,
        ]
          .filter(Boolean)
          .join(" "),
    },

    displayName:
      row.display_name ||
      row.email,

    active,

    emails: [
      {
        value:
          row.email,

        type:
          "work",

        primary:
          true,
      },
    ],

    roles: [
      {
        value:
          row.organization_role ||
          "member",

        primary:
          true,
      },
    ],

    meta: {
      resourceType:
        "User",

      created:
        row.resource_created_at,

      lastModified:
        row.resource_updated_at,

      version:
        scimVersion(
          row.version
        ),

      location:
        userLocation(
          row.scim_id
        ),
    },
  };
}

async function createScimUser({
  request,
  body,
}) {
  const organizationId =
    request.scimToken
      .organization_id;

  const email =
    requestEmail(
      body
    );

  if (!email) {
    const error =
      new Error(
        "A valid userName or primary email is required."
      );

    error.statusCode = 400;
    error.scimType =
      "invalidValue";

    throw error;
  }

  const firstName =
    cleanText(
      body?.name?.givenName,
      80
    ) || "";

  const lastName =
    cleanText(
      body?.name?.familyName,
      80
    ) || "";

  const displayName =
    cleanText(
      body?.displayName,
      160
    ) ||
    [
      firstName,
      lastName,
    ]
      .filter(Boolean)
      .join(" ") ||
    email;

  const role =
    requestRole(
      body
    );

  const active =
    body?.active !==
      false;

  const externalId =
    cleanText(
      body?.externalId,
      255
    );

  const passwordHash =
    await bcrypt.hash(
      crypto
        .randomBytes(48)
        .toString("base64url"),
      12
    );

  return transaction(
    async client => {
      const existing =
        await client.query(
          `
            SELECT
              account.id,
              account.platform_role,

              resource.scim_id
                AS existing_scim_id

            FROM users AS account

            LEFT JOIN
              backend_scim_resources
                 AS resource
              ON resource.local_id =
                 account.id::text

             AND resource.organization_id =
                 $2

             AND resource.resource_type =
                 'User'

            WHERE lower(
              account.email
            ) = lower($1)

            LIMIT 1

            FOR UPDATE OF account
          `,
          [
            email,
            organizationId,
          ]
        );

      const existingUser =
        existing.rows[0];

      if (existingUser) {
        if (
          existingUser
            .existing_scim_id
        ) {
          const error =
            new Error(
              "A SCIM user already exists for this email address."
            );

          error.statusCode = 409;
          error.scimType =
            "uniqueness";

          throw error;
        }

        const error =
          new Error(
            "An unmanaged GoodOS account already uses this email address."
          );

        error.statusCode = 409;
        error.scimType =
          "uniqueness";

        throw error;
      }

      const accountResult =
        await client.query(
          `
            INSERT INTO users (
              email,
              password_hash,
              first_name,
              last_name,
              display_name,
              platform_role,
              status,
              email_verified,
              password_updated_at,
              auth_metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              'user',
              $6,
              TRUE,
              NOW(),
              $7::jsonb
            )
            RETURNING
              id
          `,
          [
            email,
            passwordHash,
            firstName,
            lastName,
            displayName,
            active
              ? "active"
              : "pending",
            JSON.stringify({
              registrationSource:
                "scim",

              provisionedAt:
                new Date()
                  .toISOString(),

              scimExternalId:
                externalId,
            }),
          ]
        );

      const userId =
        accountResult.rows[0]
          .id;

      await ensureOrganizationMembership({
        client,
        organizationId,
        userId,
        role,
      });

      await syncApplicationMemberships({
        client,
        organizationId,
        userId,
        role,
        active,
      });

      if (!active) {
        await revokeUserSessions(
          client,
          userId
        );
      }

      const scimId =
        identifier(
          "scimusr"
        );

      await client.query(
        `
          INSERT INTO
            backend_scim_resources (
              scim_id,
              organization_id,
              resource_type,
              external_id,
              local_id,
              active,
              metadata_json
            )
          VALUES (
            $1,
            $2,
            'User',
            $3,
            $4,
            $5,
            $6::jsonb
          )
        `,
        [
          scimId,
          organizationId,
          externalId,
          String(userId),
          active,
          JSON.stringify({
            role,
          }),
        ]
      );

      return loadScimUser(
        client,
        organizationId,
        scimId
      );
    }
  );
}

async function updateScimUser({
  request,
  scimId,
  changes,
}) {
  const organizationId =
    request.scimToken
      .organization_id;

  return transaction(
    async client => {
      const current =
        await loadScimUser(
          client,
          organizationId,
          scimId
        );

      if (!current) {
        const error =
          new Error(
            "The requested SCIM user does not exist."
          );

        error.statusCode = 404;
        throw error;
      }

      const email =
        changes.email ===
          undefined
          ? current.email
          : normalizedEmail(
              changes.email
            );

      if (!email) {
        const error =
          new Error(
            "A valid userName or primary email is required."
          );

        error.statusCode = 400;
        error.scimType =
          "invalidValue";

        throw error;
      }

      const firstName =
        changes.firstName ===
          undefined
          ? (
              current.first_name ||
              ""
            )
          : (
              cleanText(
                changes.firstName,
                80
              ) || ""
            );

      const lastName =
        changes.lastName ===
          undefined
          ? (
              current.last_name ||
              ""
            )
          : (
              cleanText(
                changes.lastName,
                80
              ) || ""
            );

      const displayName =
        changes.displayName ===
          undefined
          ? (
              current.display_name ||
              email
            )
          : (
              cleanText(
                changes.displayName,
                160
              ) ||
              email
            );

      const role =
        changes.role ===
          undefined
          ? scimRole(
              current
                .organization_role
            )
          : scimRole(
              changes.role
            );

      const active =
        changes.active ===
          undefined
          ? Boolean(
              current.resource_active
            )
          : Boolean(
              changes.active
            );

      const externalId =
        changes.externalId ===
          undefined
          ? current.external_id
          : cleanText(
              changes.externalId,
              255
            );

      const duplicate =
        await client.query(
          `
            SELECT id
            FROM users
            WHERE lower(email) =
                  lower($1)
              AND id <>
                  $2::uuid
            LIMIT 1
          `,
          [
            email,
            current.user_id,
          ]
        );

      if (
        duplicate.rowCount > 0
      ) {
        const error =
          new Error(
            "Another GoodOS account already uses this email address."
          );

        error.statusCode = 409;
        error.scimType =
          "uniqueness";

        throw error;
      }

      await client.query(
        `
          UPDATE users
          SET
            email = $2,
            first_name = $3,
            last_name = $4,
            display_name = $5,
            status = $6,
            email_verified = TRUE,
            updated_at = NOW(),

            auth_metadata_json =
              COALESCE(
                auth_metadata_json,
                '{}'::jsonb
              ) ||
              $7::jsonb

          WHERE id =
                $1::uuid
        `,
        [
          current.user_id,
          email,
          firstName,
          lastName,
          displayName,
          active
            ? "active"
            : "pending",
          JSON.stringify({
            registrationSource:
              "scim",

            scimUpdatedAt:
              new Date()
                .toISOString(),

            scimExternalId:
              externalId,
          }),
        ]
      );

      await ensureOrganizationMembership({
        client,
        organizationId,
        userId:
          current.user_id,
        role,
      });

      await syncApplicationMemberships({
        client,
        organizationId,
        userId:
          current.user_id,
        role,
        active,
      });

      if (!active) {
        await revokeUserSessions(
          client,
          current.user_id
        );
      }

      await client.query(
        `
          UPDATE backend_scim_resources
          SET
            external_id = $3,
            active = $4,
            version = version + 1,

            metadata_json =
              COALESCE(
                metadata_json,
                '{}'::jsonb
              ) ||
              $5::jsonb,

            updated_at =
              NOW()

          WHERE organization_id =
                $1

            AND scim_id =
                $2

            AND resource_type =
                'User'
        `,
        [
          organizationId,
          scimId,
          externalId,
          active,
          JSON.stringify({
            role,
          }),
        ]
      );

      return loadScimUser(
        client,
        organizationId,
        scimId
      );
    }
  );
}

function patchChanges(
  operations
) {
  const changes = {};

  for (
    const operation
    of Array.isArray(
      operations
    )
      ? operations
      : []
  ) {
    const op =
      String(
        operation?.op ||
        "replace"
      ).toLowerCase();

    const path =
      String(
        operation?.path ||
        ""
      )
        .trim()
        .toLowerCase();

    const value =
      operation?.value;

    if (
      !path &&
      value &&
      typeof value ===
        "object"
    ) {
      const body = value;

      const email =
        requestEmail(
          body
        );

      if (email) {
        changes.email =
          email;
      }

      if (
        body.active !==
        undefined
      ) {
        changes.active =
          Boolean(
            body.active
          );
      }

      if (
        body.displayName !==
        undefined
      ) {
        changes.displayName =
          body.displayName;
      }

      if (
        body.name?.givenName !==
        undefined
      ) {
        changes.firstName =
          body.name
            .givenName;
      }

      if (
        body.name?.familyName !==
        undefined
      ) {
        changes.lastName =
          body.name
            .familyName;
      }

      if (
        body.externalId !==
        undefined
      ) {
        changes.externalId =
          body.externalId;
      }

      if (
        body.roles ||
        body.userType
      ) {
        changes.role =
          requestRole(
            body
          );
      }

      continue;
    }

    if (
      path === "active"
    ) {
      changes.active =
        op === "remove"
          ? false
          : Boolean(value);

      continue;
    }

    if (
      path === "username" ||
      path.startsWith(
        "emails"
      )
    ) {
      if (
        op !== "remove"
      ) {
        changes.email =
          typeof value ===
            "string"
            ? value
            : (
                Array.isArray(value)
                  ? value[0]?.value
                  : value?.value
              );
      }

      continue;
    }

    if (
      path === "displayname"
    ) {
      changes.displayName =
        op === "remove"
          ? ""
          : value;

      continue;
    }

    if (
      path ===
      "name.givenname"
    ) {
      changes.firstName =
        op === "remove"
          ? ""
          : value;

      continue;
    }

    if (
      path ===
      "name.familyname"
    ) {
      changes.lastName =
        op === "remove"
          ? ""
          : value;

      continue;
    }

    if (
      path === "externalid"
    ) {
      changes.externalId =
        op === "remove"
          ? null
          : value;

      continue;
    }

    if (
      path === "roles" ||
      path === "usertype"
    ) {
      changes.role =
        op === "remove"
          ? "member"
          : (
              typeof value ===
                "string"
                ? value
                : (
                    Array.isArray(value)
                      ? value[0]?.value
                      : value?.value
                  )
            );
    }
  }

  return changes;
}

async function listScimUsers(
  request
) {
  const organizationId =
    request.scimToken
      .organization_id;

  const startIndex =
    pageValue(
      request.query
        .startIndex,
      1
    );

  const count =
    Math.min(
      pageValue(
        request.query.count,
        100
      ),
      200
    );

  const offset =
    startIndex - 1;

  const parameters = [
    organizationId,
  ];

  let filterSql = "";

  const filter =
    String(
      request.query.filter ||
      ""
    ).trim();

  if (filter) {
    const match =
      filter.match(
        /^(userName|externalId|displayName)\s+eq\s+"([^"]+)"$/i
      );

    if (!match) {
      const error =
        new Error(
          "Only userName, externalId and displayName equality filters are supported."
        );

      error.statusCode = 400;
      error.scimType =
        "invalidFilter";

      throw error;
    }

    const attribute =
      match[1]
        .toLowerCase();

    parameters.push(
      match[2]
    );

    if (
      attribute ===
      "username"
    ) {
      filterSql =
        `
          AND lower(
            account.email
          ) = lower($2)
        `;
    } else if (
      attribute ===
      "externalid"
    ) {
      filterSql =
        `
          AND resource.external_id =
              $2
        `;
    } else {
      filterSql =
        `
          AND lower(
            account.display_name
          ) = lower($2)
        `;
    }
  }

  const countParameter =
    parameters.length + 1;

  const offsetParameter =
    parameters.length + 2;

  const result =
    await query(
      `
        WITH filtered AS (
          SELECT
            resource.scim_id,
            resource.external_id,
            resource.active
              AS resource_active,
            resource.version,
            resource.created_at
              AS resource_created_at,
            resource.updated_at
              AS resource_updated_at,

            account.id
              AS user_id,

            account.email,
            account.first_name,
            account.last_name,
            account.display_name,
            account.platform_role,
            account.status
              AS user_status,
            account.email_verified,

            membership.role
              AS organization_role,

            membership.status
              AS membership_status

          FROM backend_scim_resources
               AS resource

          JOIN users
               AS account
            ON account.id::text =
               resource.local_id

          LEFT JOIN
            backend_organization_memberships
               AS membership
            ON membership.user_id =
               account.id

           AND membership.organization_id =
               resource.organization_id

          WHERE resource.organization_id =
                $1

            AND resource.resource_type =
                'User'

          ${filterSql}
        )

        SELECT
          filtered.*,

          COUNT(*) OVER()::int
            AS total_results

        FROM filtered

        ORDER BY
          email ASC

        LIMIT
          $${countParameter}

        OFFSET
          $${offsetParameter}
      `,
      [
        ...parameters,
        count,
        offset,
      ]
    );

  const totalResults =
    result.rows[0]
      ?.total_results ||
    0;

  return listResponse({
    resources:
      result.rows.map(
        userRepresentation
      ),

    startIndex,

    totalResults,
  });
}

async function loadGroup(
  client,
  organizationId,
  groupId
) {
  const groupResult =
    await client.query(
      `
        SELECT
          id,
          external_id,
          display_name,
          description,
          status,
          version,
          created_at,
          updated_at
        FROM backend_scim_groups
        WHERE organization_id =
              $1
          AND id =
              $2
          AND status <>
              'deleted'
        LIMIT 1
      `,
      [
        organizationId,
        groupId,
      ]
    );

  const group =
    groupResult.rows[0];

  if (!group) {
    return null;
  }

  const memberResult =
    await client.query(
      `
        SELECT
          membership.user_scim_id,

          account.display_name,

          account.email

        FROM backend_scim_group_members
             AS membership

        JOIN backend_scim_resources
             AS resource
          ON resource.scim_id =
             membership.user_scim_id

         AND resource.organization_id =
             $1

         AND resource.resource_type =
             'User'

        JOIN users
             AS account
          ON account.id::text =
             resource.local_id

        WHERE membership.group_id =
              $2

        ORDER BY
          account.email
      `,
      [
        organizationId,
        groupId,
      ]
    );

  return {
    ...group,

    members:
      memberResult.rows,
  };
}

function groupRepresentation(
  group
) {
  return {
    schemas: [
      GROUP_SCHEMA,
    ],

    id:
      group.id,

    externalId:
      group.external_id ||
      undefined,

    displayName:
      group.display_name,

    members:
      group.members.map(
        member => ({
          value:
            member.user_scim_id,

          display:
            member.display_name ||
            member.email,

          $ref:
            userLocation(
              member.user_scim_id
            ),
        })
      ),

    meta: {
      resourceType:
        "Group",

      created:
        group.created_at,

      lastModified:
        group.updated_at,

      version:
        scimVersion(
          group.version
        ),

      location:
        groupLocation(
          group.id
        ),
    },
  };
}

async function validateMemberIds({
  client,
  organizationId,
  members,
}) {
  const values = [
    ...new Set(
      (
        Array.isArray(
          members
        )
          ? members
          : []
      )
        .map(member =>
          String(
            member?.value ||
            member ||
            ""
          ).trim()
        )
        .filter(Boolean)
    ),
  ];

  if (
    values.length === 0
  ) {
    return [];
  }

  const result =
    await client.query(
      `
        SELECT scim_id
        FROM backend_scim_resources
        WHERE organization_id =
              $1
          AND resource_type =
              'User'
          AND scim_id =
              ANY($2::text[])
      `,
      [
        organizationId,
        values,
      ]
    );

  if (
    result.rows.length !==
    values.length
  ) {
    const error =
      new Error(
        "One or more SCIM group members do not exist."
      );

    error.statusCode = 400;
    error.scimType =
      "invalidValue";

    throw error;
  }

  return values;
}

async function replaceGroupMembers({
  client,
  organizationId,
  groupId,
  members,
}) {
  const values =
    await validateMemberIds({
      client,
      organizationId,
      members,
    });

  await client.query(
    `
      DELETE FROM
        backend_scim_group_members
      WHERE group_id =
            $1
    `,
    [
      groupId,
    ]
  );

  for (
    const value
    of values
  ) {
    await client.query(
      `
        INSERT INTO
          backend_scim_group_members (
            group_id,
            user_scim_id
          )
        VALUES (
          $1,
          $2
        )
        ON CONFLICT DO NOTHING
      `,
      [
        groupId,
        value,
      ]
    );
  }

  return values;
}

async function createGroup({
  request,
  body,
}) {
  const organizationId =
    request.scimToken
      .organization_id;

  const displayName =
    cleanText(
      body?.displayName,
      160
    );

  if (!displayName) {
    const error =
      new Error(
        "A SCIM group displayName is required."
      );

    error.statusCode = 400;
    error.scimType =
      "invalidValue";

    throw error;
  }

  const externalId =
    cleanText(
      body?.externalId,
      255
    );

  return transaction(
    async client => {
      const duplicate =
        await client.query(
          `
            SELECT id
            FROM backend_scim_groups
            WHERE organization_id =
                  $1
              AND status <>
                  'deleted'
              AND (
                lower(
                  display_name
                ) = lower($2)

                OR (
                  $3::text
                    IS NOT NULL

                  AND external_id =
                      $3
                )
              )
            LIMIT 1
          `,
          [
            organizationId,
            displayName,
            externalId,
          ]
        );

      if (
        duplicate.rowCount > 0
      ) {
        const error =
          new Error(
            "A matching SCIM group already exists."
          );

        error.statusCode = 409;
        error.scimType =
          "uniqueness";

        throw error;
      }

      const groupId =
        identifier(
          "scimgrp"
        );

      await client.query(
        `
          INSERT INTO
            backend_scim_groups (
              id,
              organization_id,
              external_id,
              display_name,
              description,
              created_by
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::uuid
          )
        `,
        [
          groupId,
          organizationId,
          externalId,
          displayName,
          cleanText(
            body?.description,
            500
          ),
          request.scimToken
            .created_by,
        ]
      );

      await replaceGroupMembers({
        client,
        organizationId,
        groupId,
        members:
          body?.members,
      });

      await client.query(
        `
          INSERT INTO
            backend_scim_resources (
              scim_id,
              organization_id,
              resource_type,
              external_id,
              local_id,
              active
            )
          VALUES (
            $1,
            $2,
            'Group',
            $3,
            $1,
            TRUE
          )
        `,
        [
          groupId,
          organizationId,
          externalId,
        ]
      );

      return loadGroup(
        client,
        organizationId,
        groupId
      );
    }
  );
}

async function updateGroup({
  request,
  groupId,
  displayName,
  externalId,
  members,
  description,
}) {
  const organizationId =
    request.scimToken
      .organization_id;

  return transaction(
    async client => {
      const current =
        await loadGroup(
          client,
          organizationId,
          groupId
        );

      if (!current) {
        const error =
          new Error(
            "The requested SCIM group does not exist."
          );

        error.statusCode = 404;
        throw error;
      }

      const nextDisplayName =
        displayName ===
          undefined
          ? current.display_name
          : cleanText(
              displayName,
              160
            );

      if (!nextDisplayName) {
        const error =
          new Error(
            "A SCIM group displayName is required."
          );

        error.statusCode = 400;
        error.scimType =
          "invalidValue";

        throw error;
      }

      const nextExternalId =
        externalId ===
          undefined
          ? current.external_id
          : cleanText(
              externalId,
              255
            );

      await client.query(
        `
          UPDATE backend_scim_groups
          SET
            display_name =
              $3,

            external_id =
              $4,

            description =
              COALESCE(
                $5,
                description
              ),

            version =
              version + 1,

            updated_at =
              NOW()

          WHERE organization_id =
                $1

            AND id =
                $2
        `,
        [
          organizationId,
          groupId,
          nextDisplayName,
          nextExternalId,
          description ===
            undefined
            ? null
            : cleanText(
                description,
                500
              ),
        ]
      );

      if (
        members !==
        undefined
      ) {
        await replaceGroupMembers({
          client,
          organizationId,
          groupId,
          members,
        });
      }

      await client.query(
        `
          UPDATE backend_scim_resources
          SET
            external_id =
              $3,

            version =
              version + 1,

            updated_at =
              NOW()

          WHERE organization_id =
                $1

            AND scim_id =
                $2

            AND resource_type =
                'Group'
        `,
        [
          organizationId,
          groupId,
          nextExternalId,
        ]
      );

      return loadGroup(
        client,
        organizationId,
        groupId
      );
    }
  );
}

router.get(
  "/api/identity/scim/status",
  authRequired,
  tenantContext,
  identityAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const result =
        await query(
          `
            SELECT
              (
                SELECT COUNT(*)::int
                FROM backend_scim_tokens
                WHERE organization_id =
                      $1
                  AND status =
                      'active'
                  AND (
                    expires_at IS NULL
                    OR expires_at >
                       NOW()
                  )
              ) AS active_tokens,

              (
                SELECT COUNT(*)::int
                FROM backend_scim_resources
                WHERE organization_id =
                      $1
                  AND resource_type =
                      'User'
              ) AS users,

              (
                SELECT COUNT(*)::int
                FROM backend_scim_groups
                WHERE organization_id =
                      $1
                  AND status =
                      'active'
              ) AS groups
          `,
          [
            organizationId,
          ]
        );

      return response.json({
        success: true,

        status:
          "ready",

        endpoint:
          SCIM_BASE,

        serviceProviderConfig:
          `${SCIM_BASE}/ServiceProviderConfig`,

        ...result.rows[0],
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/api/identity/scim/tokens",
  authRequired,
  tenantContext,
  identityAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              id,
              name,
              token_prefix
                AS "tokenPrefix",
              status,
              last_used_at
                AS "lastUsedAt",
              expires_at
                AS "expiresAt",
              created_at
                AS "createdAt",
              revoked_at
                AS "revokedAt"
            FROM backend_scim_tokens
            WHERE organization_id =
                  $1
            ORDER BY
              created_at DESC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      return response.json({
        success: true,

        tokens:
          result.rows,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/api/identity/scim/tokens",
  authRequired,
  tenantContext,
  identityAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const name =
        cleanText(
          request.body?.name,
          150
        ) ||
        "SCIM Token";

      const expiresInDays =
        Number.isInteger(
          request.body
            ?.expiresInDays
        )
          ? Math.min(
              Math.max(
                request.body
                  .expiresInDays,
                1
              ),
              3650
            )
          : 365;

      const rawToken =
        `scim_${crypto
          .randomBytes(48)
          .toString("base64url")}`;

      const tokenId =
        identifier(
          "scimtok"
        );

      const tokenPrefix =
        rawToken.slice(
          0,
          16
        );

      await query(
        `
          INSERT INTO
            backend_scim_tokens (
              id,
              organization_id,
              name,
              token_hash,
              token_prefix,
              created_by,
              expires_at
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::uuid,
            NOW() +
              (
                $7::text ||
                ' days'
              )::interval
          )
        `,
        [
          tokenId,

          request.tenantContext
            .organizationId,

          name,

          hashToken(
            rawToken
          ),

          tokenPrefix,

          request.user.id,

          expiresInDays,
        ]
      );

      await auditScim({
        request,

        action:
          "scim.token.created",

        entityType:
          "scim_token",

        entityId:
          tokenId,

        userId:
          request.user.id,

        metadata: {
          name,
          expiresInDays,
        },
      });

      return response
        .status(201)
        .json({
          success: true,

          token: {
            id:
              tokenId,

            name,

            tokenPrefix,

            expiresInDays,

            value:
              rawToken,
          },

          warning:
            "This token value is shown once. Store it securely.",
        });
    } catch (error) {
      return next(error);
    }
  }
);

router.delete(
  "/api/identity/scim/tokens/:tokenId",
  authRequired,
  tenantContext,
  identityAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            UPDATE backend_scim_tokens
            SET
              status =
                'revoked',

              revoked_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

              AND status =
                  'active'

            RETURNING id
          `,
          [
            request.params
              .tokenId,

            request.tenantContext
              .organizationId,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,

            message:
              "The active SCIM token was not found.",
          });
      }

      await auditScim({
        request,

        action:
          "scim.token.revoked",

        entityType:
          "scim_token",

        entityId:
          request.params
            .tokenId,

        userId:
          request.user.id,
      });

      return response.json({
        success: true,

        message:
          "SCIM token revoked.",
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.use(
  "/scim/v2",
  scimLimiter,
  scimAuthentication
);

router.get(
  "/scim/v2/ServiceProviderConfig",
  (
    request,
    response
  ) => {
    return response
      .type(
        "application/scim+json"
      )
      .json({
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
        ],

        patch: {
          supported: true,
        },

        bulk: {
          supported: false,
          maxOperations: 0,
          maxPayloadSize: 0,
        },

        filter: {
          supported: true,
          maxResults: 200,
        },

        changePassword: {
          supported: false,
        },

        sort: {
          supported: false,
        },

        etag: {
          supported: true,
        },

        authenticationSchemes: [
          {
            type:
              "oauthbearertoken",

            name:
              "Bearer Token",

            description:
              "GoodOS SCIM bearer-token authentication",

            specUri:
              "https://www.rfc-editor.org/rfc/rfc6750",

            primary:
              true,
          },
        ],

        meta: {
          resourceType:
            "ServiceProviderConfig",

          location:
            `${SCIM_BASE}/ServiceProviderConfig`,
        },
      });
  }
);

router.get(
  "/scim/v2/ResourceTypes",
  (
    request,
    response
  ) => {
    return response
      .type(
        "application/scim+json"
      )
      .json(
        listResponse({
          startIndex: 1,

          totalResults: 2,

          resources: [
            {
              schemas: [
                "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
              ],

              id: "User",

              name: "User",

              endpoint:
                "/Users",

              schema:
                USER_SCHEMA,
            },

            {
              schemas: [
                "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
              ],

              id: "Group",

              name: "Group",

              endpoint:
                "/Groups",

              schema:
                GROUP_SCHEMA,
            },
          ],
        })
      );
  }
);

router.get(
  "/scim/v2/Schemas",
  (
    request,
    response
  ) => {
    return response
      .type(
        "application/scim+json"
      )
      .json(
        listResponse({
          startIndex: 1,

          totalResults: 2,

          resources: [
            {
              id:
                USER_SCHEMA,

              name:
                "User",

              description:
                "GoodOS SCIM User",

              attributes: [],
            },

            {
              id:
                GROUP_SCHEMA,

              name:
                "Group",

              description:
                "GoodOS SCIM Group",

              attributes: [],
            },
          ],
        })
      );
  }
);

router.get(
  "/scim/v2/Users",
  async (
    request,
    response
  ) => {
    try {
      const payload =
        await listScimUsers(
          request
        );

      return response
        .type(
          "application/scim+json"
        )
        .json(payload);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "SCIM users could not be listed.",

        error.scimType
      );
    }
  }
);

router.post(
  "/scim/v2/Users",
  async (
    request,
    response
  ) => {
    try {
      const user =
        await createScimUser({
          request,
          body:
            request.body ||
            {},
        });

      const resource =
        userRepresentation(
          user
        );

      await auditScim({
        request,

        action:
          "scim.user.created",

        entityType:
          "scim_user",

        entityId:
          user.scim_id,

        metadata: {
          email:
            user.email,

          externalId:
            user.external_id,
        },
      });

      response.set(
        "Location",
        resource.meta
          .location
      );

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .status(201)
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM user could not be created.",

        error.scimType
      );
    }
  }
);

router.get(
  "/scim/v2/Users/:scimId",
  async (
    request,
    response
  ) => {
    try {
      const user =
        await loadScimUser(
          {
            query:
              (...args) =>
                query(...args),
          },

          request.scimToken
            .organization_id,

          request.params
            .scimId
        );

      if (!user) {
        return scimError(
          response,
          404,
          "The requested SCIM user does not exist."
        );
      }

      const resource =
        userRepresentation(
          user
        );

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM user could not be loaded.",

        error.scimType
      );
    }
  }
);

router.put(
  "/scim/v2/Users/:scimId",
  async (
    request,
    response
  ) => {
    try {
      const body =
        request.body ||
        {};

      const user =
        await updateScimUser({
          request,

          scimId:
            request.params
              .scimId,

          changes: {
            email:
              requestEmail(
                body
              ),

            firstName:
              body.name
                ?.givenName,

            lastName:
              body.name
                ?.familyName,

            displayName:
              body.displayName,

            externalId:
              body.externalId,

            active:
              body.active !==
              false,

            role:
              requestRole(
                body
              ),
          },
        });

      const resource =
        userRepresentation(
          user
        );

      await auditScim({
        request,

        action:
          "scim.user.replaced",

        entityType:
          "scim_user",

        entityId:
          user.scim_id,
      });

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM user could not be replaced.",

        error.scimType
      );
    }
  }
);

router.patch(
  "/scim/v2/Users/:scimId",
  async (
    request,
    response
  ) => {
    try {
      if (
        !Array.isArray(
          request.body
            ?.Operations
        )
      ) {
        return scimError(
          response,
          400,
          "A SCIM PatchOp Operations array is required.",
          "invalidSyntax"
        );
      }

      const changes =
        patchChanges(
          request.body
            .Operations
        );

      const user =
        await updateScimUser({
          request,

          scimId:
            request.params
              .scimId,

          changes,
        });

      const resource =
        userRepresentation(
          user
        );

      await auditScim({
        request,

        action:
          "scim.user.patched",

        entityType:
          "scim_user",

        entityId:
          user.scim_id,

        metadata: {
          changedFields:
            Object.keys(
              changes
            ),
        },
      });

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM user could not be patched.",

        error.scimType
      );
    }
  }
);

router.delete(
  "/scim/v2/Users/:scimId",
  async (
    request,
    response
  ) => {
    try {
      const user =
        await updateScimUser({
          request,

          scimId:
            request.params
              .scimId,

          changes: {
            active: false,
          },
        });

      await auditScim({
        request,

        action:
          "scim.user.deprovisioned",

        entityType:
          "scim_user",

        entityId:
          user.scim_id,

        metadata: {
          sessionsRevoked:
            true,
        },
      });

      return response
        .status(204)
        .end();
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM user could not be deprovisioned.",

        error.scimType
      );
    }
  }
);

router.get(
  "/scim/v2/Groups",
  async (
    request,
    response
  ) => {
    try {
      const organizationId =
        request.scimToken
          .organization_id;

      const startIndex =
        pageValue(
          request.query
            .startIndex,
          1
        );

      const count =
        Math.min(
          pageValue(
            request.query.count,
            100
          ),
          200
        );

      const offset =
        startIndex - 1;

      const client =
        await pool.connect();

      try {
        const groupsResult =
          await client.query(
            `
              SELECT
                group_record.*,

                COUNT(*) OVER()::int
                  AS total_results

              FROM backend_scim_groups
                   AS group_record

              WHERE group_record
                      .organization_id =
                    $1

                AND group_record
                      .status =
                    'active'

              ORDER BY
                group_record
                  .display_name

              LIMIT $2
              OFFSET $3
            `,
            [
              organizationId,
              count,
              offset,
            ]
          );

        const resources = [];

        for (
          const row
          of groupsResult.rows
        ) {
          const group =
            await loadGroup(
              client,
              organizationId,
              row.id
            );

          resources.push(
            groupRepresentation(
              group
            )
          );
        }

        return response
          .type(
            "application/scim+json"
          )
          .json(
            listResponse({
              resources,

              startIndex,

              totalResults:
                groupsResult
                  .rows[0]
                  ?.total_results ||
                0,
            })
          );
      } finally {
        client.release();
      }
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "SCIM groups could not be listed.",

        error.scimType
      );
    }
  }
);

router.post(
  "/scim/v2/Groups",
  async (
    request,
    response
  ) => {
    try {
      const group =
        await createGroup({
          request,

          body:
            request.body ||
            {},
        });

      const resource =
        groupRepresentation(
          group
        );

      await auditScim({
        request,

        action:
          "scim.group.created",

        entityType:
          "scim_group",

        entityId:
          group.id,

        metadata: {
          displayName:
            group.display_name,
        },
      });

      response.set(
        "Location",
        resource.meta
          .location
      );

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .status(201)
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM group could not be created.",

        error.scimType
      );
    }
  }
);

router.get(
  "/scim/v2/Groups/:groupId",
  async (
    request,
    response
  ) => {
    const client =
      await pool.connect();

    try {
      const group =
        await loadGroup(
          client,

          request.scimToken
            .organization_id,

          request.params
            .groupId
        );

      if (!group) {
        return scimError(
          response,
          404,
          "The requested SCIM group does not exist."
        );
      }

      const resource =
        groupRepresentation(
          group
        );

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM group could not be loaded.",

        error.scimType
      );
    } finally {
      client.release();
    }
  }
);

router.put(
  "/scim/v2/Groups/:groupId",
  async (
    request,
    response
  ) => {
    try {
      const group =
        await updateGroup({
          request,

          groupId:
            request.params
              .groupId,

          displayName:
            request.body
              ?.displayName,

          externalId:
            request.body
              ?.externalId,

          description:
            request.body
              ?.description,

          members:
            request.body
              ?.members ||
            [],
        });

      const resource =
        groupRepresentation(
          group
        );

      await auditScim({
        request,

        action:
          "scim.group.replaced",

        entityType:
          "scim_group",

        entityId:
          group.id,
      });

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM group could not be replaced.",

        error.scimType
      );
    }
  }
);

router.patch(
  "/scim/v2/Groups/:groupId",
  async (
    request,
    response
  ) => {
    try {
      const operations =
        request.body
          ?.Operations;

      if (
        !Array.isArray(
          operations
        )
      ) {
        return scimError(
          response,
          400,
          "A SCIM PatchOp Operations array is required.",
          "invalidSyntax"
        );
      }

      const client =
        await pool.connect();

      let current;

      try {
        current =
          await loadGroup(
            client,

            request.scimToken
              .organization_id,

            request.params
              .groupId
          );
      } finally {
        client.release();
      }

      if (!current) {
        return scimError(
          response,
          404,
          "The requested SCIM group does not exist."
        );
      }

      let displayName =
        undefined;

      let externalId =
        undefined;

      let members =
        current.members.map(
          member => ({
            value:
              member
                .user_scim_id,
          })
        );

      for (
        const operation
        of operations
      ) {
        const op =
          String(
            operation?.op ||
            "replace"
          ).toLowerCase();

        const path =
          String(
            operation?.path ||
            ""
          ).toLowerCase();

        const value =
          operation?.value;

        if (
          path ===
          "displayname"
        ) {
          displayName =
            op === "remove"
              ? null
              : value;

          continue;
        }

        if (
          path ===
          "externalid"
        ) {
          externalId =
            op === "remove"
              ? null
              : value;

          continue;
        }

        if (
          path === "members"
        ) {
          const next =
            Array.isArray(value)
              ? value
              : [];

          if (
            op === "add"
          ) {
            members = [
              ...members,
              ...next,
            ];
          } else if (
            op === "remove"
          ) {
            const remove =
              new Set(
                next.map(
                  entry =>
                    String(
                      entry?.value ||
                      entry
                    )
                )
              );

            members =
              members.filter(
                entry =>
                  !remove.has(
                    String(
                      entry?.value ||
                      entry
                    )
                  )
              );
          } else {
            members =
              next;
          }

          continue;
        }

        const memberFilter =
          path.match(
            /^members\[value eq "([^"]+)"\]$/
          );

        if (
          memberFilter &&
          op === "remove"
        ) {
          members =
            members.filter(
              entry =>
                String(
                  entry?.value ||
                  entry
                ) !==
                memberFilter[1]
            );
        }
      }

      const group =
        await updateGroup({
          request,

          groupId:
            request.params
              .groupId,

          displayName,

          externalId,

          members,
        });

      const resource =
        groupRepresentation(
          group
        );

      await auditScim({
        request,

        action:
          "scim.group.patched",

        entityType:
          "scim_group",

        entityId:
          group.id,
      });

      response.set(
        "ETag",
        resource.meta
          .version
      );

      return response
        .type(
          "application/scim+json"
        )
        .json(resource);
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM group could not be patched.",

        error.scimType
      );
    }
  }
);

router.delete(
  "/scim/v2/Groups/:groupId",
  async (
    request,
    response
  ) => {
    try {
      const organizationId =
        request.scimToken
          .organization_id;

      const result =
        await transaction(
          async client => {
            const update =
              await client.query(
                `
                  UPDATE backend_scim_groups
                  SET
                    status =
                      'deleted',

                    version =
                      version + 1,

                    updated_at =
                      NOW()

                  WHERE organization_id =
                        $1

                    AND id =
                        $2

                    AND status =
                        'active'

                  RETURNING id
                `,
                [
                  organizationId,

                  request.params
                    .groupId,
                ]
              );

            if (
              update.rowCount ===
              0
            ) {
              return null;
            }

            await client.query(
              `
                DELETE FROM
                  backend_scim_group_members
                WHERE group_id =
                      $1
              `,
              [
                request.params
                  .groupId,
              ]
            );

            await client.query(
              `
                UPDATE backend_scim_resources
                SET
                  active =
                    FALSE,

                  version =
                    version + 1,

                  updated_at =
                    NOW()

                WHERE organization_id =
                      $1

                  AND scim_id =
                      $2

                  AND resource_type =
                      'Group'
              `,
              [
                organizationId,

                request.params
                  .groupId,
              ]
            );

            return update
              .rows[0];
          }
        );

      if (!result) {
        return scimError(
          response,
          404,
          "The requested SCIM group does not exist."
        );
      }

      await auditScim({
        request,

        action:
          "scim.group.deleted",

        entityType:
          "scim_group",

        entityId:
          request.params
            .groupId,
      });

      return response
        .status(204)
        .end();
    } catch (error) {
      return scimError(
        response,

        error.statusCode ||
          500,

        error.message ||
          "The SCIM group could not be deleted.",

        error.scimType
      );
    }
  }
);

router.use(
  (
    error,
    request,
    response,
    next
  ) => {
    if (
      !request.path.startsWith(
        "/scim/v2"
      )
    ) {
      return next(error);
    }

    console.error(
      "SCIM request failed:",
      error
    );

    return scimError(
      response,

      error.statusCode ||
        500,

      error.message ||
        "The SCIM request could not be completed.",

      error.scimType
    );
  }
);

module.exports =
  router;
