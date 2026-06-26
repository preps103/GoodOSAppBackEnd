const jwt = require("jsonwebtoken");

const env = require("../config/env");
const { error } = require("../utils/response");
const {
  validateSessionToken,
  getUserApps,
  publicUser
} = require("../services/auth.service");

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("Bearer ")) {
    return {
      token: authHeader.replace("Bearer ", "").trim(),
      source: "bearer"
    };
  }

  if (req.cookies && req.cookies[env.authCookieName]) {
    return {
      token: req.cookies[env.authCookieName],
      source: "cookie"
    };
  }

  return {
    token: null,
    source: null
  };
}

async function authRequired(req, res, next) {
  try {
    const { token, source } = getTokenFromRequest(req);

    if (!token) {
      return error(res, "Authorization token required", 401);
    }

    let decoded;

    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch (err) {
      return error(res, "Invalid or expired token", 401);
    }

    const sessionUser = await validateSessionToken(token);

    if (!sessionUser) {
      return error(res, "Session expired or revoked", 401);
    }

    req.auth = {
      token,
      decoded,
      source,
      sessionId: sessionUser.session_id
    };

    req.user = publicUser(sessionUser);
    req.apps = await getUserApps(sessionUser.id);

    return next();
  } catch (err) {
    console.error("Auth middleware failed:", err);
    return error(res, "Authentication failed", 500);
  }
}

module.exports = authRequired;
