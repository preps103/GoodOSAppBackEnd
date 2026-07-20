const jwt = require("jsonwebtoken");
const env = require("../config/env");

const DATA_TOKEN_TTL = "5m";

function mintDataPlaneToken(request) {
  const user = request.user || {};
  const auth = request.auth || {};

  if (!user.id || !auth.sessionId) {
    const error = new Error("A current GoodOS session is required.");
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
      tokenUse: "data_plane"
    },
    env.jwtSecret,
    {
      expiresIn: DATA_TOKEN_TTL,
      issuer: "https://backend.goodos.app"
    }
  );
}

module.exports = {
  mintDataPlaneToken,
  DATA_TOKEN_TTL
};
