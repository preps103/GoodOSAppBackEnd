const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const DATA_TOKEN_TTL = "5m";
const SERVICE_DATA_TOKEN_TTL = "2m";
const DATA_TOKEN_AUDIENCE = "goodbase-rest";
const PUBLIC_BASE_URL = String(
  process.env.GOODBASE_PUBLIC_URL ||
  "https://base.goodos.app"
).replace(/\/+$/, "");

function mintDataPlaneToken(request) {
  const user = request.user || {};
  const auth = request.auth || {};

  if (!user.id || !auth.sessionId) {
    const error = new Error("A current Goodbase session is required.");
    error.statusCode = 401;
    throw error;
  }

  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      platformRole:
        user.platformRole ||
        user.platform_role ||
        "member",
      role: "goodos_authenticated",
      sid: auth.sessionId,
      aal: auth.authLevel || "password",
      mfaVerified: Boolean(auth.mfaVerified),
      organizationId: request.goodbaseTenantContext?.organizationId || null,
      projectId: request.goodbaseTenantContext?.projectId || null,
      environmentId: request.goodbaseTenantContext?.environmentId || null,
      tokenUse: "data_plane",
      jti: crypto.randomUUID()
    },
    env.jwtSecret,
    {
      expiresIn: DATA_TOKEN_TTL,
      issuer: PUBLIC_BASE_URL,
      audience: DATA_TOKEN_AUDIENCE
    }
  );
}

function mintServiceDataPlaneToken(request) {
  const user = request.user || {};
  const auth = request.auth || {};
  if (!user.id || !auth.sessionId || !request.goodbaseTenantContext) {
    const error = new Error("A scoped administrator session is required.");
    error.statusCode = 401;
    throw error;
  }
  return jwt.sign(
    {
      sub: user.id,
      sid: auth.sessionId,
      role: "goodos_authenticated",
      platformRole: user.platformRole || "admin",
      organizationId: request.goodbaseTenantContext.organizationId,
      projectId: request.goodbaseTenantContext.projectId,
      environmentId: request.goodbaseTenantContext.environmentId,
      tokenUse: "data_plane_service",
      service: true,
      jti: crypto.randomUUID()
    },
    env.jwtSecret,
    {
      expiresIn: SERVICE_DATA_TOKEN_TTL,
      issuer: PUBLIC_BASE_URL,
      audience: DATA_TOKEN_AUDIENCE
    }
  );
}

module.exports = {
  mintDataPlaneToken,
  mintServiceDataPlaneToken,
  DATA_TOKEN_TTL,
  SERVICE_DATA_TOKEN_TTL,
  DATA_TOKEN_AUDIENCE,
  PUBLIC_BASE_URL
};
