"use strict";

const crypto = require("crypto");
const dns = require("dns").promises;
const express = require("express");
const rateLimit =
  require("express-rate-limit");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const {
  query,
} = require("../config/database");

const router = express.Router();

const providerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

function identifier(prefix) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

function keyBuffer() {
  const value = String(
    process.env.OIDC_ENCRYPTION_KEY || ""
  );

  if (!/^[a-f0-9]{64}$/i.test(value)) {
    const error = new Error(
      "OIDC encryption is not configured."
    );

    error.statusCode = 503;
    throw error;
  }

  return Buffer.from(value, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    keyBuffer(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(
      String(value),
      "utf8"
    ),
    cipher.final(),
  ]);

  return [
    iv.toString("base64url"),
    cipher.getAuthTag()
      .toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decrypt(value) {
  const parts =
    String(value || "").split(".");

  if (parts.length !== 3) {
    throw new Error(
      "Stored OIDC value is not encrypted."
    );
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyBuffer(),
    Buffer.from(
      parts[0],
      "base64url"
    )
  );

  decipher.setAuthTag(
    Buffer.from(
      parts[1],
      "base64url"
    )
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(
        parts[2],
        "base64url"
      )
    ),
    decipher.final(),
  ]).toString("utf8");
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function cleanText(
  value,
  maxLength = 500
) {
  const result =
    String(value || "").trim();

  return result
    ? result.slice(0, maxLength)
    : null;
}

function cleanDomain(value) {
  let domain =
    String(value || "")
      .trim()
      .toLowerCase();

  domain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");

  if (
    domain.length < 3 ||
    domain.length > 253 ||
    domain.includes("*") ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    !domain.includes(".") ||
    domain.split(".")
      .some(label =>
        !label ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-")
      )
  ) {
    return null;
  }

  return domain;
}

function providerSecretConfigured(
  provider
) {
  return Boolean(
    provider.secret_reference &&
    process.env[
      provider.secret_reference
    ]
  );
}

async function providerForOrganization(
  providerId,
  organizationId
) {
  const result = await query(
    `
      SELECT
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
        metadata_json,
        last_discovered_at,
        activated_at,
        created_at,
        updated_at
      FROM backend_identity_providers
      WHERE id = $1
        AND organization_id = $2
      LIMIT 1
    `,
    [
      providerId,
      organizationId,
    ]
  );

  return result.rows[0] || null;
}

async function identityAdminRequired(
  request,
  response,
  next
) {
  try {
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
            "OIDC administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

router.get(
  "/health",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result = await query(
        `
          SELECT
            to_regclass(
              'public.backend_identity_domains'
            ) IS NOT NULL
              AS domains_ready,

            to_regclass(
              'public.backend_oidc_transactions'
            ) IS NOT NULL
              AS transactions_ready,

            (
              SELECT COUNT(*)::int
              FROM backend_identity_providers
              WHERE provider_type = 'oidc'
                AND status = 'active'
            ) AS active_providers
        `
      );

      const databaseState =
        result.rows[0];

      response.json({
        success: true,
        status:
          databaseState.domains_ready &&
          databaseState.transactions_ready &&
          /^[a-f0-9]{64}$/i.test(
            String(
              process.env
                .OIDC_ENCRYPTION_KEY ||
              ""
            )
          )
            ? "ready"
            : "not_ready",

        encryptionConfigured:
          /^[a-f0-9]{64}$/i.test(
            String(
              process.env
                .OIDC_ENCRYPTION_KEY ||
              ""
            )
          ),

        domainsReady:
          databaseState.domains_ready,

        transactionsReady:
          databaseState
            .transactions_ready,

        activeProviders:
          databaseState
            .active_providers,

        callbackUrl:
          "https://backend.goodos.app/api/oidc/callback",

        ssoEnforced: false,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/providers",
  providerLimiter,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result = await query(
        `
          SELECT
            provider.id,
            provider.name,
            provider.display_name
              AS "displayName",

            provider.issuer_url
              AS "issuerUrl",

            ARRAY(
              SELECT domain.domain
              FROM backend_identity_domains
                   AS domain
              WHERE domain.provider_id =
                    provider.id
                AND domain.status =
                    'active'
              ORDER BY domain.domain
            ) AS domains

          FROM backend_identity_providers
               AS provider

          WHERE provider.provider_type =
                'oidc'

            AND provider.status =
                'active'

          ORDER BY
            provider.display_name
        `
      );

      response.json({
        success: true,
        providers: result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.use(
  "/admin",
  authRequired,
  tenantContext,
  identityAdminRequired
);

router.get(
  "/admin/providers",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const result = await query(
        `
          SELECT
            provider.id,
            provider.provider_type
              AS "providerType",

            provider.name,

            provider.display_name
              AS "displayName",

            provider.issuer_url
              AS "issuerUrl",

            provider.authorization_endpoint
              AS "authorizationEndpoint",

            provider.token_endpoint
              AS "tokenEndpoint",

            provider.jwks_uri
              AS "jwksUri",

            provider.client_id
              AS "clientId",

            provider.secret_reference
              AS "secretReference",

            provider.status,
            provider.domains,

            provider.metadata_json
              AS "metadata",

            provider.last_discovered_at
              AS "lastDiscoveredAt",

            provider.activated_at
              AS "activatedAt",

            (
              SELECT COUNT(*)::int
              FROM backend_identity_domains
                   AS domain
              WHERE domain.provider_id =
                    provider.id
                AND domain.status =
                    'active'
            ) AS "verifiedDomainCount"

          FROM backend_identity_providers
               AS provider

          WHERE provider.organization_id =
                $1

            AND provider.provider_type =
                'oidc'

          ORDER BY
            provider.created_at ASC
        `,
        [organizationId]
      );

      response.json({
        success: true,

        callbackUrl:
          "https://backend.goodos.app/api/oidc/callback",

        providers:
          result.rows.map(
            provider => ({
              ...provider,

              secretConfigured:
                providerSecretConfigured({
                  secret_reference:
                    provider.secretReference,
                }),

              readyForActivation:
                Boolean(
                  provider.issuerUrl &&
                  provider.clientId &&
                  provider.lastDiscoveredAt &&
                  provider
                    .verifiedDomainCount > 0 &&
                  providerSecretConfigured({
                    secret_reference:
                      provider.secretReference,
                  })
                ),
            })
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/admin/domains",
  async (
    request,
    response,
    next
  ) => {
    try {
      const result = await query(
        `
          SELECT
            domain.id,
            domain.provider_id
              AS "providerId",

            provider.display_name
              AS "providerDisplayName",

            domain.domain,
            domain.status,

            domain.verification_method
              AS "verificationMethod",

            domain.verification_record_name
              AS "verificationRecordName",

            domain.verification_token_prefix
              AS "verificationTokenPrefix",

            domain.verification_expires_at
              AS "verificationExpiresAt",

            domain.verified_at
              AS "verifiedAt",

            domain.last_checked_at
              AS "lastCheckedAt",

            domain.created_at
              AS "createdAt",

            domain.updated_at
              AS "updatedAt"

          FROM backend_identity_domains
               AS domain

          JOIN backend_identity_providers
               AS provider
            ON provider.id =
               domain.provider_id

          WHERE domain.organization_id =
                $1

          ORDER BY
            domain.created_at ASC
        `,
        [
          request.tenantContext
            .organizationId,
        ]
      );

      response.json({
        success: true,
        domains: result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/admin/domains",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const providerId =
        cleanText(
          request.body?.providerId,
          200
        );

      const domain =
        cleanDomain(
          request.body?.domain
        );

      if (!providerId || !domain) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "A valid provider and domain are required.",
          });
      }

      const provider =
        await providerForOrganization(
          providerId,
          organizationId
        );

      if (
        !provider ||
        provider.provider_type !== "oidc"
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "OIDC provider was not found.",
          });
      }

      const rawToken =
        crypto.randomBytes(24)
          .toString("base64url");

      const recordName =
        `_goodos-oidc.${domain}`;

      const recordValue =
        `goodos-verification=${rawToken}`;

      const result = await query(
        `
          INSERT INTO
            backend_identity_domains (
              id,
              organization_id,
              provider_id,
              domain,
              status,
              verification_method,
              verification_record_name,
              verification_token_hash,
              verification_token_encrypted,
              verification_token_prefix,
              verification_expires_at,
              created_by,
              updated_by
            )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'pending',
            'dns_txt',
            $5,
            $6,
            $7,
            $8,
            NOW() + INTERVAL '7 days',
            $9::uuid,
            $9::uuid
          )
          ON CONFLICT (
            organization_id,
            domain
          )
          DO UPDATE SET
            provider_id =
              EXCLUDED.provider_id,

            status = 'pending',

            verification_record_name =
              EXCLUDED
                .verification_record_name,

            verification_token_hash =
              EXCLUDED
                .verification_token_hash,

            verification_token_encrypted =
              EXCLUDED
                .verification_token_encrypted,

            verification_token_prefix =
              EXCLUDED
                .verification_token_prefix,

            verification_expires_at =
              EXCLUDED
                .verification_expires_at,

            verified_at = NULL,
            last_checked_at = NULL,
            updated_by =
              EXCLUDED.updated_by,

            updated_at = NOW()

          RETURNING
            id,
            provider_id
              AS "providerId",
            domain,
            status,
            verification_record_name
              AS "verificationRecordName",
            verification_expires_at
              AS "verificationExpiresAt"
        `,
        [
          identifier("domain"),
          organizationId,
          provider.id,
          domain,
          recordName,
          hash(rawToken),
          encrypt(rawToken),
          rawToken.slice(0, 6),
          request.user.id,
        ]
      );

      response
        .status(201)
        .json({
          success: true,
          domain: result.rows[0],

          dnsRecord: {
            type: "TXT",
            name: recordName,
            value: recordValue,
          },

          warning:
            "The DNS verification value is displayed only in this response.",
        });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/admin/domains/:domainId/verify",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const result = await query(
        `
          SELECT
            id,
            provider_id,
            domain,
            status,
            verification_record_name,
            verification_token_hash,
            verification_token_encrypted,
            verification_expires_at
          FROM backend_identity_domains
          WHERE id = $1
            AND organization_id = $2
          LIMIT 1
        `,
        [
          request.params.domainId,
          organizationId,
        ]
      );

      const domain =
        result.rows[0];

      if (!domain) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Identity domain was not found.",
          });
      }

      if (
        domain.verification_expires_at &&
        new Date(
          domain.verification_expires_at
        ).getTime() < Date.now()
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              "Domain verification token has expired. Create a new verification record.",
          });
      }

      const rawToken =
        decrypt(
          domain
            .verification_token_encrypted
        );

      if (
        hash(rawToken) !==
        domain.verification_token_hash
      ) {
        throw new Error(
          "Stored domain token failed integrity validation."
        );
      }

      const expected =
        `goodos-verification=${rawToken}`;

      let records = [];

      try {
        records = await dns.resolveTxt(
          domain.verification_record_name
        );
      } catch (dnsError) {
        await query(
          `
            UPDATE backend_identity_domains
            SET
              last_checked_at = NOW(),
              metadata_json =
                metadata_json ||
                jsonb_build_object(
                  'lastDnsError',
                  $3
                ),
              updated_by = $4::uuid,
              updated_at = NOW()
            WHERE id = $1
              AND organization_id = $2
          `,
          [
            domain.id,
            organizationId,
            String(
              dnsError.code ||
              dnsError.message ||
              "DNS lookup failed"
            ).slice(0, 300),
            request.user.id,
          ]
        );

        return response
          .status(409)
          .json({
            success: false,
            code:
              "DOMAIN_VERIFICATION_PENDING",
            message:
              "The required DNS TXT record was not found yet.",
          });
      }

      const values =
        records.map(parts =>
          parts.join("")
        );

      const verified =
        values.includes(expected);

      if (!verified) {
        await query(
          `
            UPDATE backend_identity_domains
            SET
              last_checked_at = NOW(),
              metadata_json =
                metadata_json ||
                jsonb_build_object(
                  'lastDnsValuesFound',
                  $3::jsonb
                ),
              updated_by = $4::uuid,
              updated_at = NOW()
            WHERE id = $1
              AND organization_id = $2
          `,
          [
            domain.id,
            organizationId,
            JSON.stringify(
              values.slice(0, 20)
            ),
            request.user.id,
          ]
        );

        return response
          .status(409)
          .json({
            success: false,
            code:
              "DOMAIN_VERIFICATION_PENDING",
            message:
              "DNS TXT records were found, but the GoodOS verification value did not match.",
          });
      }

      const verifiedResult =
        await query(
          `
            UPDATE backend_identity_domains
            SET
              status = 'active',
              verified_at =
                COALESCE(
                  verified_at,
                  NOW()
                ),
              last_checked_at = NOW(),
              updated_by = $3::uuid,
              metadata_json =
                metadata_json ||
                jsonb_build_object(
                  'verifiedBy',
                  'dns_txt'
                ),
              updated_at = NOW()
            WHERE id = $1
              AND organization_id = $2
            RETURNING
              id,
              provider_id
                AS "providerId",
              domain,
              status,
              verified_at
                AS "verifiedAt"
          `,
          [
            domain.id,
            organizationId,
            request.user.id,
          ]
        );

      await query(
        `
          UPDATE backend_identity_providers
             AS provider
          SET
            domains =
              ARRAY(
                SELECT identity_domain.domain
                FROM backend_identity_domains
                     AS identity_domain
                WHERE identity_domain
                        .provider_id =
                      provider.id
                  AND identity_domain.status =
                      'active'
                ORDER BY
                  identity_domain.domain
              ),
            updated_at = NOW()
          WHERE provider.id = $1
            AND provider.organization_id =
                $2
        `,
        [
          domain.provider_id,
          organizationId,
        ]
      );

      response.json({
        success: true,
        domain:
          verifiedResult.rows[0],
        message:
          "Identity domain verified.",
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/admin/providers/:providerId/discover",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const provider =
        await providerForOrganization(
          request.params.providerId,
          organizationId
        );

      if (
        !provider ||
        provider.provider_type !== "oidc"
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "OIDC provider was not found.",
          });
      }

      if (
        !provider.issuer_url ||
        !provider.client_id
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Issuer URL and client ID are required before discovery.",
          });
      }

      let issuerUrl;

      try {
        issuerUrl =
          new URL(
            provider.issuer_url
          );
      } catch {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Issuer URL is invalid.",
          });
      }

      if (
        issuerUrl.protocol !== "https:"
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "OIDC issuer must use HTTPS.",
          });
      }

      const oidc =
        await import("openid-client");

      const configuration =
        await oidc.discovery(
          issuerUrl,
          provider.client_id
        );

      const serverMetadata =
        typeof configuration
          .serverMetadata === "function"
          ? configuration
              .serverMetadata()
          : {};

      const updateResult =
        await query(
          `
            UPDATE backend_identity_providers
            SET
              authorization_endpoint =
                COALESCE(
                  $3,
                  authorization_endpoint
                ),

              token_endpoint =
                COALESCE(
                  $4,
                  token_endpoint
                ),

              jwks_uri =
                COALESCE(
                  $5,
                  jwks_uri
                ),

              last_discovered_at =
                NOW(),

              metadata_json =
                metadata_json ||
                jsonb_build_object(
                  'discoveryReady',
                  true,
                  'discoveryIssuer',
                  $6,
                  'callbackUrl',
                  'https://backend.goodos.app/api/oidc/callback'
                ),

              updated_by =
                $7::uuid,

              updated_at =
                NOW()

            WHERE id = $1
              AND organization_id = $2

            RETURNING
              id,
              status,
              issuer_url
                AS "issuerUrl",
              authorization_endpoint
                AS "authorizationEndpoint",
              token_endpoint
                AS "tokenEndpoint",
              jwks_uri
                AS "jwksUri",
              last_discovered_at
                AS "lastDiscoveredAt"
          `,
          [
            provider.id,
            organizationId,
            cleanText(
              serverMetadata
                .authorization_endpoint,
              1000
            ),
            cleanText(
              serverMetadata
                .token_endpoint,
              1000
            ),
            cleanText(
              serverMetadata
                .jwks_uri,
              1000
            ),
            cleanText(
              serverMetadata.issuer,
              1000
            ) || provider.issuer_url,
            request.user.id,
          ]
        );

      response.json({
        success: true,
        provider:
          updateResult.rows[0],
        message:
          "OIDC discovery completed.",
      });
    } catch (error) {
      console.error(
        "OIDC discovery failed:",
        error
      );

      response
        .status(400)
        .json({
          success: false,
          code:
            "OIDC_DISCOVERY_FAILED",
          message:
            "OIDC discovery failed. Verify the issuer URL and provider availability.",
        });
    }
  }
);

router.patch(
  "/admin/providers/:providerId",
  async (
    request,
    response,
    next
  ) => {
    try {
      const organizationId =
        request.tenantContext
          .organizationId;

      const provider =
        await providerForOrganization(
          request.params.providerId,
          organizationId
        );

      if (
        !provider ||
        provider.provider_type !== "oidc"
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "OIDC provider was not found.",
          });
      }

      const requestedStatus =
        cleanText(
          request.body?.status,
          30
        ) || provider.status;

      if (
        ![
          "disabled",
          "active",
        ].includes(requestedStatus)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Provider status must be active or disabled.",
          });
      }

      const defaultRole =
        cleanText(
          request.body?.defaultRole,
          30
        ) || "user";

      if (
        ![
          "user",
          "viewer",
        ].includes(defaultRole)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "OIDC JIT provisioning may only assign user or viewer roles.",
          });
      }

      const domainResult =
        await query(
          `
            SELECT COUNT(*)::int
              AS count
            FROM backend_identity_domains
            WHERE provider_id = $1
              AND organization_id = $2
              AND status = 'active'
          `,
          [
            provider.id,
            organizationId,
          ]
        );

      const verifiedDomainCount =
        Number(
          domainResult.rows[0]
            ?.count || 0
        );

      const secretConfigured =
        providerSecretConfigured(
          provider
        );

      if (
        requestedStatus === "active" &&
        (
          !provider.last_discovered_at ||
          !provider.client_id ||
          !provider.issuer_url ||
          !secretConfigured ||
          verifiedDomainCount < 1
        )
      ) {
        return response
          .status(409)
          .json({
            success: false,
            code:
              "OIDC_PROVIDER_NOT_READY",
            message:
              "Provider activation requires successful discovery, a configured secret reference and at least one verified domain.",
            readiness: {
              discovery:
                Boolean(
                  provider
                    .last_discovered_at
                ),
              clientId:
                Boolean(
                  provider.client_id
                ),
              issuer:
                Boolean(
                  provider.issuer_url
                ),
              secretConfigured,
              verifiedDomainCount,
            },
          });
      }

      const jitEnabled =
        request.body?.jitEnabled === true;

      const trustIdpMfa =
        request.body
          ?.trustIdpMfa === true;

      const mfaAmrValues =
        Array.isArray(
          request.body
            ?.mfaAmrValues
        )
          ? request.body
              .mfaAmrValues
              .map(value =>
                cleanText(
                  value,
                  100
                )
              )
              .filter(Boolean)
              .slice(0, 25)
          : [];

      const mfaAcrValues =
        Array.isArray(
          request.body
            ?.mfaAcrValues
        )
          ? request.body
              .mfaAcrValues
              .map(value =>
                cleanText(
                  value,
                  250
                )
              )
              .filter(Boolean)
              .slice(0, 25)
          : [];

      const result = await query(
        `
          UPDATE backend_identity_providers
          SET
            status = $3,

            activated_at =
              CASE
                WHEN $3 = 'active'
                THEN COALESCE(
                  activated_at,
                  NOW()
                )
                ELSE activated_at
              END,

            metadata_json =
              metadata_json ||
              jsonb_build_object(
                'jitEnabled',
                $4::boolean,
                'defaultRole',
                $5,
                'trustIdpMfa',
                $6::boolean,
                'mfaAmrValues',
                $7::jsonb,
                'mfaAcrValues',
                $8::jsonb,
                'callbackUrl',
                'https://backend.goodos.app/api/oidc/callback',
                'phase15c1Ready',
                true
              ),

            updated_by =
              $9::uuid,

            updated_at =
              NOW()

          WHERE id = $1
            AND organization_id = $2

          RETURNING
            id,
            status,
            metadata_json
              AS "metadata",
            activated_at
              AS "activatedAt",
            updated_at
              AS "updatedAt"
        `,
        [
          provider.id,
          organizationId,
          requestedStatus,
          jitEnabled,
          defaultRole,
          trustIdpMfa,
          JSON.stringify(
            mfaAmrValues
          ),
          JSON.stringify(
            mfaAcrValues
          ),
          request.user.id,
        ]
      );

      response.json({
        success: true,
        provider:
          result.rows[0],
        callbackUrl:
          "https://backend.goodos.app/api/oidc/callback",
        message:
          requestedStatus === "active"
            ? "OIDC provider activated."
            : "OIDC provider disabled.",
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
