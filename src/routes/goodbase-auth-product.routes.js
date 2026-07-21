"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const database = require("../config/database");
const env = require("../config/env");
const { queueEmail } = require("../services/notification.service");
const { getUserByEmail, issueSessionForUser } = require("../services/auth.service");

const router = express.Router();
const DEFAULT_TENANT = {
  organizationId: "org_goodos",
  projectId: "proj_goodos_platform",
  environmentId: "env_goodos_production"
};

const passwordlessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "AUTH_RATE_LIMITED", message: "Too many authentication requests. Try again later." }
});

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function requestFingerprint(request) {
  return {
    ipHash: hash(request.ip || "unknown"),
    userAgentHash: hash(request.get("user-agent") || "unknown")
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    maxAge: env.sessionDays * 24 * 60 * 60 * 1000,
    path: "/"
  };
}

async function recordEvent({ userId = null, eventType, outcome, provider = "native", request, detail = {} }) {
  const fingerprint = requestFingerprint(request);
  await database.query(
    `INSERT INTO goodbase_auth_events (
       organization_id,project_id,environment_id,user_id,event_type,outcome,provider,ip_hash,user_agent_hash,detail_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [DEFAULT_TENANT.organizationId, DEFAULT_TENANT.projectId, DEFAULT_TENANT.environmentId,
      userId, eventType, outcome, provider, fingerprint.ipHash, fingerprint.userAgentHash, JSON.stringify(detail)]
  );
}

router.post("/passwordless/start", passwordlessLimiter, async (request, response, next) => {
  const generic = { success: true, accepted: true, message: "If the account is eligible, a single-use sign-in message will be sent." };
  try {
    const email = normalizeEmail(request.body?.email);
    const type = request.body?.type === "magic_link" ? "magic_link" : "email_otp";
    if (!email) return response.status(202).json(generic);

    const channel = await database.query(
      `SELECT id,configuration_json FROM goodbase_auth_channels
       WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND channel_type=$4 AND status='enabled' LIMIT 1`,
      [DEFAULT_TENANT.organizationId, DEFAULT_TENANT.projectId, DEFAULT_TENANT.environmentId, type]
    );
    const user = await getUserByEmail(email);
    if (!channel.rows[0] || !user || user.status !== "active" || !user.email_verified) {
      await recordEvent({ userId: user?.id, eventType: `${type}.start`, outcome: "blocked", request });
      return response.status(202).json(generic);
    }

    const secret = type === "magic_link"
      ? crypto.randomBytes(32).toString("base64url")
      : String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const ttl = type === "magic_link" ? 900 : 600;
    const fingerprint = requestFingerprint(request);
    await database.query(
      `INSERT INTO goodbase_auth_challenges (
         organization_id,project_id,environment_id,user_id,challenge_type,destination_hash,
         secret_hash,expires_at,ip_hash,user_agent_hash,metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+make_interval(secs=>$8),$9,$10,$11::jsonb)`,
      [DEFAULT_TENANT.organizationId, DEFAULT_TENANT.projectId, DEFAULT_TENANT.environmentId,
        user.id, type, hash(email), hash(secret), ttl, fingerprint.ipHash, fingerprint.userAgentHash,
        JSON.stringify({ delivery: "email", singleUse: true })]
    );

    const verifyUrl = `https://goodos.app/?auth_type=${encodeURIComponent(type)}&auth_token=${encodeURIComponent(secret)}&email=${encodeURIComponent(email)}`;
    await queueEmail({
      templateKey: `auth.${type}`,
      toEmail: email,
      toName: user.display_name || user.first_name || email,
      subject: type === "magic_link" ? "Your GoodOS sign-in link" : "Your GoodOS sign-in code",
      bodyText: type === "magic_link"
        ? `Use this single-use link to sign in. It expires in 15 minutes:\n${verifyUrl}`
        : `Your single-use GoodOS sign-in code is ${secret}. It expires in 10 minutes.`,
      bodyHtml: type === "magic_link"
        ? `<p>Use this single-use link to sign in:</p><p><a href="${verifyUrl}">Sign in to GoodOS</a></p><p>This link expires in 15 minutes.</p>`
        : `<p>Your single-use GoodOS sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${secret}</p><p>This code expires in 10 minutes.</p>`,
      organizationId: DEFAULT_TENANT.organizationId,
      projectId: DEFAULT_TENANT.projectId,
      environmentId: DEFAULT_TENANT.environmentId
    });
    await recordEvent({ userId: user.id, eventType: `${type}.start`, outcome: "challenge", request });
    return response.status(202).json(generic);
  } catch (error) {
    return next(error);
  }
});

router.post("/passwordless/verify", passwordlessLimiter, async (request, response, next) => {
  try {
    const email = normalizeEmail(request.body?.email);
    const secret = String(request.body?.token || request.body?.code || "");
    const type = request.body?.type === "magic_link" ? "magic_link" : "email_otp";
    if (!email || secret.length < 6 || secret.length > 128) {
      return response.status(401).json({ success: false, code: "AUTH_CHALLENGE_INVALID", message: "The sign-in challenge is invalid or expired." });
    }

    const client = await database.pool.connect();
    let userId;
    try {
      await client.query("BEGIN");
      const challenge = await client.query(
        `SELECT id,user_id,attempts,max_attempts FROM goodbase_auth_challenges
         WHERE challenge_type=$1 AND destination_hash=$2 AND status='pending' AND expires_at>NOW()
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [type, hash(email)]
      );
      const row = challenge.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return response.status(401).json({ success: false, code: "AUTH_CHALLENGE_INVALID", message: "The sign-in challenge is invalid or expired." });
      }
      const matched = await client.query(`SELECT secret_hash=$2 AS matched FROM goodbase_auth_challenges WHERE id=$1`, [row.id, hash(secret)]);
      if (!matched.rows[0]?.matched) {
        await client.query(
          `UPDATE goodbase_auth_challenges SET attempts=attempts+1,
             status=CASE WHEN attempts+1>=max_attempts THEN 'locked' ELSE status END WHERE id=$1`,
          [row.id]
        );
        await client.query("COMMIT");
        await recordEvent({ userId: row.user_id, eventType: `${type}.verify`, outcome: "failure", request });
        return response.status(401).json({ success: false, code: "AUTH_CHALLENGE_INVALID", message: "The sign-in challenge is invalid or expired." });
      }
      await client.query(
        `UPDATE goodbase_auth_challenges SET status='consumed',verified_at=NOW(),consumed_at=NOW(),attempts=attempts+1 WHERE id=$1`,
        [row.id]
      );
      await client.query("COMMIT");
      userId = row.user_id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const userResult = await database.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    const session = await issueSessionForUser({
      user: userResult.rows[0],
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
      authMethod: type
    });
    response.cookie(env.authCookieName, session.token, cookieOptions());
    await recordEvent({ userId, eventType: `${type}.verify`, outcome: "success", request });
    return response.json({ success: true, ...session });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
