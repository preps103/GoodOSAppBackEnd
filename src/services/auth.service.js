const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const env = require("../config/env");
const { query } = require("../config/database");

function publicUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    platformRole: row.platform_role,
    status: row.status,
    emailVerified: row.email_verified,
    mfaEnabled: Boolean(row.mfa_enabled),
    mfaRequired: Boolean(row.mfa_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function getUserByEmail(email) {
  const result = await query(
    `
    SELECT *
    FROM users
    WHERE LOWER(email) = LOWER($1)
    LIMIT 1
    `,
    [email]
  );

  return result.rows[0] || null;
}

async function getUserById(userId) {
  const result = await query(
    `
    SELECT *
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getUserApps(userId) {
  const result = await query(
    `
    SELECT
      a.id,
      a.name,
      a.domain,
      a.status AS "appStatus",
      a.description,
      am.role,
      am.status AS "membershipStatus"
    FROM app_memberships am
    JOIN apps a ON a.id = am.app_id
    WHERE am.user_id = $1
    ORDER BY a.name ASC
    `,
    [userId]
  );

  return result.rows;
}

async function createSession({ userId, token, ipAddress, userAgent }) {
  const tokenHash = hashToken(token);

  const result = await query(
    `
    INSERT INTO sessions (
      user_id,
      token_hash,
      ip_address,
      user_agent,
      expires_at
    )
    VALUES (
      $1,
      $2,
      NULLIF($3, '')::inet,
      $4,
      NOW() + ($5 || ' days')::interval
    )
    RETURNING id, expires_at;
    `,
    [userId, tokenHash, ipAddress || null, userAgent || null, env.sessionDays]
  );

  return result.rows[0];
}

async function validateSessionToken(token) {
  const tokenHash = hashToken(token);

  const result = await query(
    `
    SELECT
      s.id AS session_id,
      s.expires_at,
      u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > NOW()
      AND u.status = 'active'
    LIMIT 1
    `,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function revokeSessionById(sessionId) {
  const result = await query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE id = $1
      AND revoked_at IS NULL
    RETURNING id, user_id, revoked_at;
    `,
    [sessionId]
  );

  return result.rows[0] || null;
}

async function revokeAllUserSessions(userId) {
  const result = await query(
    `
    UPDATE sessions
    SET revoked_at = NOW()
    WHERE user_id = $1
      AND revoked_at IS NULL
    RETURNING id, revoked_at;
    `,
    [userId]
  );

  return result.rows;
}

async function listUserSessions(userId) {
  const result = await query(
    `
    SELECT
      id,
      ip_address::text AS "ipAddress",
      user_agent AS "userAgent",
      expires_at AS "expiresAt",
      revoked_at AS "revokedAt",
      created_at AS "createdAt",
      CASE
        WHEN revoked_at IS NOT NULL THEN 'revoked'
        WHEN expires_at <= NOW() THEN 'expired'
        ELSE 'active'
      END AS status
    FROM sessions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 25;
    `,
    [userId]
  );

  return result.rows;
}

async function login({ email, password, ipAddress, userAgent }) {
  if (!email || !password) {
    const err = new Error("Email and password are required.");
    err.statusCode = 400;
    throw err;
  }

  const user = await getUserByEmail(email);

  if (!user || !user.password_hash) {
    const err = new Error("Invalid email or password.");
    err.statusCode = 401;
    throw err;
  }

  if (!user.email_verified) {
    const err = new Error(
      "Verify your email before signing in."
    );
    err.statusCode = 403;
    throw err;
  }

  if (user.status !== "active") {
    const err = new Error("Account is not active.");
    err.statusCode = 403;
    throw err;
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches) {
    const err = new Error("Invalid email or password.");
    err.statusCode = 401;
    throw err;
  }

  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      platformRole: user.platform_role
    },
    env.jwtSecret,
    {
      expiresIn: env.jwtExpiresIn
    }
  );

  const session = await createSession({
    userId: user.id,
    token,
    ipAddress,
    userAgent
  });

  await query(
    `
    UPDATE users
    SET last_login_at = NOW()
    WHERE id = $1
    `,
    [user.id]
  );

  const apps = await getUserApps(user.id);

  return {
    token,
    session: {
      id: session.id,
      expiresAt: session.expires_at
    },
    user: publicUser(user),
    apps
  };
}

module.exports = {
  login,
  getUserById,
  getUserApps,
  validateSessionToken,
  revokeSessionById,
  revokeAllUserSessions,
  listUserSessions,
  publicUser
};
