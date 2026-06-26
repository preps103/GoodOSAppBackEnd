const express = require("express");
const rateLimit = require("express-rate-limit");

const env = require("../config/env");
const { success, error } = require("../utils/response");
const {
  login,
  revokeSessionById,
  revokeAllUserSessions,
  listUserSessions
} = require("../services/auth.service");
const { logAudit } = require("../services/audit.service");
const authRequired = require("../middleware/authRequired");

const router = express.Router();

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    path: "/",
    maxAge: env.sessionDays * 24 * 60 * 60 * 1000
  };
}

function clearAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: env.authCookieSecure,
    sameSite: env.authCookieSameSite,
    domain: env.authCookieDomain,
    path: "/"
  };
}

function setAuthCookie(res, token) {
  res.cookie(env.authCookieName, token, authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(env.authCookieName, clearAuthCookieOptions());
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later."
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const result = await login({
      email: req.body.email,
      password: req.body.password,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"]
    });

    setAuthCookie(res, result.token);

    await logAudit({
      userId: result.user.id,
      action: "auth.login",
      entityType: "session",
      entityId: result.session.id,
      ipAddress: req.ip,
      metadata: {
        email: result.user.email,
        userAgent: req.headers["user-agent"] || null,
        authCookie: true
      }
    });

    return success(res, {
      message: "Login successful",
      token: result.token,
      session: result.session,
      user: result.user,
      apps: result.apps
    });
  } catch (err) {
    console.error("Login failed:", err.message);

    await logAudit({
      userId: null,
      action: "auth.login_failed",
      entityType: "auth",
      entityId: null,
      ipAddress: req.ip,
      metadata: {
        email: req.body.email || null,
        reason: err.message || "Login failed",
        userAgent: req.headers["user-agent"] || null
      }
    }).catch((auditErr) => {
      console.error("Failed login audit failed:", auditErr.message);
    });

    return error(res, err.message || "Login failed", err.statusCode || 500);
  }
});

router.get("/me", authRequired, async (req, res) => {
  return success(res, {
    user: req.user,
    apps: req.apps,
    authSource: req.auth.source
  });
});

router.get("/sessions", authRequired, async (req, res) => {
  try {
    const sessions = await listUserSessions(req.user.id);

    return success(res, {
      count: sessions.length,
      sessions
    });
  } catch (err) {
    console.error("Session list failed:", err);
    return error(res, "Failed to load sessions", 500);
  }
});

router.post("/logout", authRequired, async (req, res) => {
  try {
    const revokedSession = await revokeSessionById(req.auth.sessionId);
    clearAuthCookie(res);

    await logAudit({
      userId: req.user.id,
      action: "auth.logout",
      entityType: "session",
      entityId: req.auth.sessionId,
      ipAddress: req.ip,
      metadata: {
        revoked: Boolean(revokedSession),
        authSource: req.auth.source
      }
    });

    return success(res, {
      message: "Logout successful",
      revoked: Boolean(revokedSession)
    });
  } catch (err) {
    console.error("Logout failed:", err);
    return error(res, "Logout failed", 500);
  }
});

router.post("/logout-all", authRequired, async (req, res) => {
  try {
    const revokedSessions = await revokeAllUserSessions(req.user.id);
    clearAuthCookie(res);

    await logAudit({
      userId: req.user.id,
      action: "auth.logout_all",
      entityType: "user",
      entityId: req.user.id,
      ipAddress: req.ip,
      metadata: {
        revokedSessions: revokedSessions.length,
        authSource: req.auth.source
      }
    });

    return success(res, {
      message: "All sessions logged out",
      revokedSessions: revokedSessions.length
    });
  } catch (err) {
    console.error("Logout all failed:", err);
    return error(res, "Logout all failed", 500);
  }
});

module.exports = router;
