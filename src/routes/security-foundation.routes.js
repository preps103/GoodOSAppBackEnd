"use strict";

const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const speakeasy = require("speakeasy");

const database =
  require("../security/phase2-db");

const {
  authenticateRequest,
  audit
} = require(
  "../middleware/phase2-security"
);

const router = express.Router();

function keyBuffer() {
  const key = String(
    process.env.MFA_ENCRYPTION_KEY || ""
  );

  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error(
      "MFA_ENCRYPTION_KEY is not configured."
    );
  }

  return Buffer.from(key, "hex");
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    keyBuffer(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);

  return [
    iv.toString("base64url"),
    cipher
      .getAuthTag()
      .toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decrypt(value) {
  const [
    ivValue,
    tagValue,
    encryptedValue
  ] = String(value).split(".");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyBuffer(),
    Buffer.from(ivValue, "base64url")
  );

  decipher.setAuthTag(
    Buffer.from(tagValue, "base64url")
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(
        encryptedValue,
        "base64url"
      )
    ),
    decipher.final()
  ]).toString("utf8");
}

function recoveryCode() {
  const value = crypto
    .randomBytes(8)
    .toString("hex")
    .toUpperCase();

  return (
    value.slice(0, 8) +
    "-" +
    value.slice(8)
  );
}

function recoveryHash(value) {
  return crypto
    .createHmac("sha256", keyBuffer())
    .update(
      String(value)
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase()
    )
    .digest("hex");
}

function validTotp(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token: String(token || "")
      .replace(/\s/g, ""),
    window: 1
  });
}

router.get("/health", (req, res) => {
  const configured =
    /^[a-f0-9]{64}$/i.test(
      String(
        process.env.MFA_ENCRYPTION_KEY ||
        ""
      )
    );

  return res.json({
    success: true,
    status:
      configured ? "ready" : "degraded",
    phase: "security-foundation-v2",
    mfaEncryptionConfigured:
      configured,
    features: {
      originProtection: true,
      adminBoundary: true,
      totpMfa: true,
      recoveryCodes: true,
      sessionRevocation: true,
      loginLockout: true,
      passwordPolicy: true,
      apiKeyExpiration: true
    }
  });
});

router.use(authenticateRequest);

router.get("/overview", async (
  req,
  res,
  next
) => {
  try {
    const [
      factors,
      sessions,
      policies,
      keys
    ] = await Promise.all([
      database.query(
        `
          SELECT
            id,
            type,
            label,
            status,
            verified_at,
            last_used_at,
            created_at
          FROM backend_mfa_factors
          WHERE user_id = $1
          ORDER BY created_at DESC
        `,
        [req.phase2Auth.user_id]
      ),
      database.query(
        `
          SELECT
            COUNT(*)::integer AS total,
            COUNT(*) FILTER (
              WHERE revoked_at IS NULL
                AND expires_at > NOW()
            )::integer AS active,
            COUNT(*) FILTER (
              WHERE revoked_at IS NULL
                AND expires_at > NOW()
                AND mfa_verified = true
            )::integer AS mfa_verified
          FROM sessions
          WHERE user_id = $1
        `,
        [req.phase2Auth.user_id]
      ),
      database.query(
        `
          SELECT
            policy_key,
            policy_value,
            description,
            updated_at
          FROM security_policies
          ORDER BY policy_key
        `
      ),
      database.query(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE status = 'active'
                AND revoked_at IS NULL
            )::integer AS active,
            COUNT(*) FILTER (
              WHERE status = 'active'
                AND revoked_at IS NULL
                AND expires_at IS NULL
            )::integer AS without_expiration
          FROM backend_api_keys
        `
      )
    ]);

    return res.json({
      success: true,
      user: {
        id: req.phase2Auth.user_id,
        email: req.phase2Auth.email,
        role:
          req.phase2Auth.platform_role,
        mfaEnabled:
          req.phase2Auth.mfa_enabled,
        mfaRequired:
          req.phase2Auth.mfa_required,
        sessionMfaVerified:
          req.phase2Auth.mfa_verified
      },
      factors: factors.rows,
      sessions: sessions.rows[0],
      apiKeys: keys.rows[0],
      policies: policies.rows
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/sessions", async (
  req,
  res,
  next
) => {
  try {
    const result = await database.query(
      `
        SELECT
          id,
          ip_address,
          user_agent,
          device_label,
          auth_level,
          mfa_verified,
          risk_score,
          created_at,
          last_seen_at,
          expires_at,
          revoked_at,
          id = $2::uuid AS current
        FROM sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [
        req.phase2Auth.user_id,
        req.phase2Auth.session_id
      ]
    );

    return res.json({
      success: true,
      sessions: result.rows
    });
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/sessions/:sessionId",
  async (req, res, next) => {
    try {
      const sessionId = String(
        req.params.sessionId || ""
      );

      if (
        sessionId ===
        String(
          req.phase2Auth.session_id
        )
      ) {
        return res.status(409).json({
          success: false,
          code: "CURRENT_SESSION",
          message:
            "Use logout to revoke the current session."
        });
      }

      const result = await database.query(
        `
          UPDATE sessions
          SET revoked_at = NOW()
          WHERE id::text = $1
            AND user_id = $2
            AND revoked_at IS NULL
          RETURNING id
        `,
        [
          sessionId,
          req.phase2Auth.user_id
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Active session was not found."
        });
      }

      audit({
        userId:
          req.phase2Auth.user_id,
        action:
          "security.session.revoked",
        entityType: "session",
        entityId: sessionId
      });

      return res.json({
        success: true,
        revokedSessionId: sessionId
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post("/mfa/setup", async (
  req,
  res,
  next
) => {
  try {
    const existing =
      await database.query(
        `
          SELECT id
          FROM backend_mfa_factors
          WHERE user_id = $1
            AND status = 'active'
          LIMIT 1
        `,
        [req.phase2Auth.user_id]
      );

    if (existing.rows.length) {
      return res.status(409).json({
        success: false,
        code: "MFA_ALREADY_ACTIVE",
        message:
          "An active MFA factor already exists."
      });
    }

    await database.query(
      `
        DELETE FROM backend_mfa_factors
        WHERE user_id = $1
          AND status = 'pending'
      `,
      [req.phase2Auth.user_id]
    );

    const secret =
      speakeasy.generateSecret({
        length: 32,
        name:
          `GoodOS:${req.phase2Auth.email}`,
        issuer: "GoodOS"
      });

    const recoveryCodes =
      Array.from(
        { length: 10 },
        recoveryCode
      );

    const factorId =
      `mfa_${crypto.randomUUID()}`;

    await database.query(
      `
        INSERT INTO backend_mfa_factors (
          id,
          user_id,
          type,
          label,
          status,
          secret_hash,
          secret_prefix,
          secret_encrypted,
          recovery_codes_hash,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          'totp',
          'GoodOS Authenticator',
          'pending',
          $3,
          $4,
          $5,
          $6::jsonb,
          '{}'::jsonb,
          NOW(),
          NOW()
        )
      `,
      [
        factorId,
        req.phase2Auth.user_id,
        crypto
          .createHash("sha256")
          .update(secret.base32)
          .digest("hex"),
        secret.base32.slice(0, 6),
        encrypt(secret.base32),
        JSON.stringify(
          recoveryCodes.map(
            recoveryHash
          )
        )
      ]
    );

    const qrDataUrl =
      await QRCode.toDataURL(
        secret.otpauth_url,
        {
          width: 320,
          margin: 2
        }
      );

    audit({
      userId:
        req.phase2Auth.user_id,
      action:
        "security.mfa.setup_started",
      entityType: "mfa_factor",
      entityId: factorId
    });

    return res.status(201).json({
      success: true,
      factorId,
      otpauthUrl:
        secret.otpauth_url,
      qrDataUrl,
      recoveryCodes,
      warning:
        "Recovery codes are displayed only during setup."
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/mfa/verify", async (
  req,
  res,
  next
) => {
  try {
    const factorId = String(
      req.body?.factorId || ""
    );

    const token = String(
      req.body?.token || ""
    );

    const result = await database.query(
      `
        SELECT
          id,
          secret_encrypted
        FROM backend_mfa_factors
        WHERE id = $1
          AND user_id = $2
          AND status = 'pending'
        LIMIT 1
      `,
      [
        factorId,
        req.phase2Auth.user_id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message:
          "Pending MFA setup was not found."
      });
    }

    const factor = result.rows[0];

    if (
      !validTotp(
        decrypt(
          factor.secret_encrypted
        ),
        token
      )
    ) {
      return res.status(401).json({
        success: false,
        code: "INVALID_MFA_CODE",
        message:
          "The authenticator code is invalid."
      });
    }

    await database.transaction(
      async client => {
        await client.query(
          `
            UPDATE backend_mfa_factors
            SET
              status = 'active',
              verified_at = NOW(),
              last_used_at = NOW(),
              updated_at = NOW()
            WHERE id = $1
          `,
          [factor.id]
        );

        await client.query(
          `
            UPDATE users
            SET
              mfa_enabled = true,
              mfa_required = true,
              updated_at = NOW()
            WHERE id = $1
          `,
          [
            req.phase2Auth.user_id
          ]
        );

        await client.query(
          `
            UPDATE sessions
            SET
              mfa_verified = true,
              auth_level = 'mfa',
              last_seen_at = NOW()
            WHERE id = $1
          `,
          [
            req.phase2Auth.session_id
          ]
        );

        await client.query(
          `
            UPDATE sessions
            SET
              revoked_at = NOW(),
              metadata_json =
                COALESCE(
                  metadata_json,
                  '{}'::jsonb
                ) ||
                jsonb_build_object(
                  'revokedBy',
                  'mfa_enrollment',
                  'keptSessionId',
                  $2::text
                )
            WHERE user_id = $1
              AND id <> $2
              AND revoked_at IS NULL
          `,
          [
            req.phase2Auth.user_id,
            req.phase2Auth.session_id
          ]
        );
      }
    );

    audit({
      userId:
        req.phase2Auth.user_id,
      action: "security.mfa.enabled",
      entityType: "mfa_factor",
      entityId: factor.id
    });

    return res.json({
      success: true,
      mfaEnabled: true,
      currentSessionMfaVerified:
        true
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/mfa/verify-session",
  async (req, res, next) => {
    try {
      const result =
        await database.query(
          `
            SELECT
              id,
              secret_encrypted
            FROM backend_mfa_factors
            WHERE user_id = $1
              AND status = 'active'
            ORDER BY verified_at DESC
            LIMIT 1
          `,
          [
            req.phase2Auth.user_id
          ]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Active MFA factor was not found."
        });
      }

      const factor = result.rows[0];

      if (
        !validTotp(
          decrypt(
            factor.secret_encrypted
          ),
          req.body?.token
        )
      ) {
        return res.status(401).json({
          success: false,
          code: "INVALID_MFA_CODE",
          message:
            "The authenticator code is invalid."
        });
      }

      await database.query(
        `
          UPDATE sessions
          SET
            mfa_verified = true,
            auth_level = 'mfa',
            last_seen_at = NOW()
          WHERE id = $1
        `,
        [
          req.phase2Auth.session_id
        ]
      );

      await database.query(
        `
          UPDATE backend_mfa_factors
          SET
            last_used_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [factor.id]
      );

      return res.json({
        success: true,
        currentSessionMfaVerified:
          true
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post("/mfa/recovery", async (
  req,
  res,
  next
) => {
  try {
    const codeHash = recoveryHash(
      req.body?.recoveryCode || ""
    );

    const result = await database.query(
      `
        SELECT
          id,
          recovery_codes_hash
        FROM backend_mfa_factors
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY verified_at DESC
        LIMIT 1
      `,
      [req.phase2Auth.user_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message:
          "Active MFA factor was not found."
      });
    }

    const factor = result.rows[0];

    const hashes = Array.isArray(
      factor.recovery_codes_hash
    )
      ? factor.recovery_codes_hash
      : [];

    if (!hashes.includes(codeHash)) {
      return res.status(401).json({
        success: false,
        code:
          "INVALID_RECOVERY_CODE",
        message:
          "The recovery code is invalid."
      });
    }

    const remaining =
      hashes.filter(
        value => value !== codeHash
      );

    await database.transaction(
      async client => {
        await client.query(
          `
            UPDATE backend_mfa_factors
            SET
              recovery_codes_hash =
                $1::jsonb,
              last_used_at = NOW(),
              updated_at = NOW()
            WHERE id = $2
          `,
          [
            JSON.stringify(remaining),
            factor.id
          ]
        );

        await client.query(
          `
            UPDATE sessions
            SET
              mfa_verified = true,
              auth_level =
                'mfa-recovery',
              last_seen_at = NOW()
            WHERE id = $1
          `,
          [
            req.phase2Auth.session_id
          ]
        );
      }
    );

    audit({
      userId:
        req.phase2Auth.user_id,
      action:
        "security.mfa.recovery_used",
      entityType: "mfa_factor",
      entityId: factor.id,
      metadata: {
        remainingRecoveryCodes:
          remaining.length
      }
    });

    return res.json({
      success: true,
      currentSessionMfaVerified:
        true,
      remainingRecoveryCodes:
        remaining.length
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
