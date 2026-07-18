"use strict";

const crypto = require("crypto");
const express = require("express");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const {
  query,
} = require("../config/database");

const router = express.Router();

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

function cleanText(
  value,
  maxLength = 500
) {
  const result =
    String(value || "")
      .trim();

  return result
    ? result.slice(0, maxLength)
    : null;
}

async function identityAdminRequired(
  request,
  response,
  next
) {
  try {
    const userId =
      request.user?.id;

    const organizationId =
      request.tenantContext
        ?.organizationId;

    const result = await query(
      `
        SELECT
          account.platform_role,
          membership.role
            AS membership_role

        FROM users AS account

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
        userId,
        organizationId,
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
            "Identity administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

router.use(
  authRequired,
  tenantContext,
  identityAdminRequired
);


router.get(
  "/summary",
  async (request, response, next) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const result = await query(
        `
          SELECT
            (
              SELECT COUNT(*)::int
              FROM backend_organization_memberships
              WHERE organization_id = $1
                AND status = 'active'
            ) AS users,

            (
              SELECT COUNT(*)::int
              FROM sessions AS session
              JOIN backend_organization_memberships
                   AS membership
                ON membership.user_id =
                   session.user_id
              WHERE membership.organization_id = $1
                AND membership.status = 'active'
                AND session.revoked_at IS NULL
                AND session.expires_at > NOW()
            ) AS active_sessions,

            (
              SELECT COUNT(*)::int
              FROM backend_user_invites
              WHERE organization_id = $1
                AND status = 'pending'
                AND expires_at > NOW()
            ) AS pending_invites,

            (
              SELECT COUNT(*)::int
              FROM backend_mfa_factors AS factor
              JOIN backend_organization_memberships
                   AS membership
                ON membership.user_id =
                   factor.user_id
              WHERE membership.organization_id = $1
                AND factor.status = 'active'
            ) AS active_mfa_factors,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_providers
              WHERE organization_id = $1
            ) AS providers,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_bindings
              WHERE organization_id = $1
                AND status = 'active'
            ) AS external_identities
        `,
        [organizationId]
      );

      response.json({
        success: true,
        organizationId,
        summary:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/policy",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          SELECT
            organization_id
              AS "organizationId",

            local_password_enabled
              AS "localPasswordEnabled",

            invite_only
              AS "inviteOnly",

            mfa_mode
              AS "mfaMode",

            session_days
              AS "sessionDays",

            max_active_sessions
              AS "maxActiveSessions",

            sso_required
              AS "ssoRequired",

            default_provider_id
              AS "defaultProviderId",

            updated_at
              AS "updatedAt"

          FROM backend_identity_policies

          WHERE organization_id =
                $1
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      response.json({
        success: true,
        policy:
          result.rows[0] || null,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.patch(
  "/policy",
  async (request, response, next) => {
    try {
      const body =
        request.body || {};

      const mfaMode =
        body.mfaMode === undefined
          ? null
          : cleanText(
              body.mfaMode,
              30
            );

      if (
        mfaMode &&
        ![
          "optional",
          "admin_required",
          "required",
        ].includes(mfaMode)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid MFA mode.",
          });
      }

      const result = await query(
        `
          UPDATE backend_identity_policies
          SET
            local_password_enabled =
              COALESCE(
                $2::boolean,
                local_password_enabled
              ),

            invite_only =
              COALESCE(
                $3::boolean,
                invite_only
              ),

            mfa_mode =
              COALESCE(
                $4,
                mfa_mode
              ),

            session_days =
              COALESCE(
                $5::integer,
                session_days
              ),

            max_active_sessions =
              COALESCE(
                $6::integer,
                max_active_sessions
              ),

            updated_by =
              $7::uuid,

            updated_at =
              NOW()

          WHERE organization_id =
                $1

          RETURNING
            organization_id
              AS "organizationId",

            local_password_enabled
              AS "localPasswordEnabled",

            invite_only
              AS "inviteOnly",

            mfa_mode
              AS "mfaMode",

            session_days
              AS "sessionDays",

            max_active_sessions
              AS "maxActiveSessions",

            sso_required
              AS "ssoRequired",

            updated_at
              AS "updatedAt"
        `,
        [
          request.tenantContext
            .organizationId,

          typeof body
            .localPasswordEnabled ===
            "boolean"
            ? body.localPasswordEnabled
            : null,

          typeof body.inviteOnly ===
            "boolean"
            ? body.inviteOnly
            : null,

          mfaMode,

          Number.isInteger(
            body.sessionDays
          )
            ? body.sessionDays
            : null,

          Number.isInteger(
            body.maxActiveSessions
          )
            ? body.maxActiveSessions
            : null,

          request.user.id,
        ]
      );

      response.json({
        success: true,
        policy:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/providers",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          SELECT
            id,
            provider_type
              AS "providerType",
            name,
            display_name
              AS "displayName",
            issuer_url
              AS "issuerUrl",
            client_id
              AS "clientId",
            secret_reference
              AS "secretReference",
            status,
            domains,
            created_at
              AS "createdAt",
            updated_at
              AS "updatedAt"

          FROM backend_identity_providers

          WHERE organization_id =
                $1

          ORDER BY
            created_at ASC
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      const providers =
        result.rows.map(provider => ({
          ...provider,

          secretConfigured:
            Boolean(
              provider.secretReference &&
              process.env[
                provider.secretReference
              ]
            ),
        }));

      response.json({
        success: true,
        providers,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/providers",
  async (request, response, next) => {
    try {
      const body =
        request.body || {};

      const providerType =
        cleanText(
          body.providerType,
          20
        );

      const name =
        cleanText(
          body.name,
          100
        );

      const displayName =
        cleanText(
          body.displayName,
          150
        );

      const secretReference =
        cleanText(
          body.secretReference,
          150
        );

      if (
        ![
          "oidc",
          "saml",
        ].includes(providerType)
        ||
        !name
        ||
        !displayName
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Provider type, name, and display name are required.",
          });
      }

      if (
        secretReference &&
        !/^[A-Z][A-Z0-9_]{2,149}$/
          .test(secretReference)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Secret reference must be an uppercase environment-variable name.",
          });
      }

      const domains =
        Array.isArray(body.domains)
          ? body.domains
              .map(value =>
                cleanText(
                  value,
                  255
                )
              )
              .filter(Boolean)
              .slice(0, 25)
          : [];

      const result = await query(
        `
          INSERT INTO
            backend_identity_providers (
              id,
              organization_id,
              provider_type,
              name,
              display_name,
              issuer_url,
              authorization_endpoint,
              token_endpoint,
              jwks_uri,
              client_id,
              secret_reference,
              status,
              domains,
              created_by
            )
          VALUES (
            $1,
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
            'disabled',
            $12::text[],
            $13::uuid
          )
          RETURNING
            id,
            provider_type
              AS "providerType",
            name,
            display_name
              AS "displayName",
            status,
            domains,
            created_at
              AS "createdAt"
        `,
        [
          identifier("idp"),
          request.tenantContext
            .organizationId,
          providerType,
          name,
          displayName,
          cleanText(
            body.issuerUrl,
            1000
          ),
          cleanText(
            body.authorizationEndpoint,
            1000
          ),
          cleanText(
            body.tokenEndpoint,
            1000
          ),
          cleanText(
            body.jwksUri,
            1000
          ),
          cleanText(
            body.clientId,
            500
          ),
          secretReference,
          domains,
          request.user.id,
        ]
      );

      response
        .status(201)
        .json({
          success: true,
          provider:
            result.rows[0],
          message:
            "Identity provider registered in disabled mode. No secret value was stored.",
        });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/users",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          SELECT
            account.id,
            account.email,

            account.display_name
              AS "displayName",

            account.platform_role
              AS "platformRole",

            account.status,
            account.email_verified
              AS "emailVerified",

            account.mfa_enabled
              AS "mfaEnabled",

            account.mfa_required
              AS "mfaRequired",

            account.last_login_at
              AS "lastLoginAt",

            membership.role
              AS "membershipRole",

            membership.status
              AS "membershipStatus"

          FROM backend_organization_memberships
               AS membership

          JOIN users AS account
            ON account.id =
               membership.user_id

          WHERE membership.organization_id =
                $1

          ORDER BY
            account.created_at ASC
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      response.json({
        success: true,
        users:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/sessions",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          SELECT
            session.id,

            session.user_id
              AS "userId",

            account.email,

            session.ip_address
              AS "ipAddress",

            session.user_agent
              AS "userAgent",

            session.auth_level
              AS "authLevel",

            session.mfa_verified
              AS "mfaVerified",

            session.device_label
              AS "deviceLabel",

            session.risk_score
              AS "riskScore",

            session.last_seen_at
              AS "lastSeenAt",

            session.expires_at
              AS "expiresAt",

            session.revoked_at
              AS "revokedAt",

            session.created_at
              AS "createdAt"

          FROM sessions AS session

          JOIN users AS account
            ON account.id =
               session.user_id

          JOIN backend_organization_memberships
               AS membership
            ON membership.user_id =
               session.user_id

          WHERE membership.organization_id =
                $1

          ORDER BY
            session.created_at DESC

          LIMIT 250
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      response.json({
        success: true,
        sessions:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/sessions/:sessionId/revoke",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          UPDATE sessions AS session
          SET
            revoked_at =
              COALESCE(
                session.revoked_at,
                NOW()
              ),

            metadata_json =
              COALESCE(
                session.metadata_json,
                '{}'::jsonb
              ) ||
              jsonb_build_object(
                'revokedBy',
                'phase5_identity_admin',
                'revokedByUserId',
                $3::text
              )

          WHERE session.id =
                $1::uuid

            AND EXISTS (
              SELECT 1

              FROM backend_organization_memberships
                   AS membership

              WHERE membership.user_id =
                    session.user_id

                AND membership.organization_id =
                    $2
            )

          RETURNING
            session.id,
            session.user_id
              AS "userId",
            session.revoked_at
              AS "revokedAt"
        `,
        [
          request.params
            .sessionId,

          request.tenantContext
            .organizationId,

          request.user.id,
        ]
      );

      if (result.rowCount === 0) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Session was not found in this organization.",
          });
      }

      response.json({
        success: true,
        session:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/invites",
  async (request, response, next) => {
    try {
      const result = await query(
        `
          SELECT
            id,
            email,
            platform_role
              AS "platformRole",
            app_id
              AS "appId",
            app_role
              AS "appRole",
            status,
            expires_at
              AS "expiresAt",
            accepted_at
              AS "acceptedAt",
            created_at
              AS "createdAt"

          FROM backend_user_invites

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

      response.json({
        success: true,
        invitations:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
