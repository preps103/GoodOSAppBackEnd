const express = require("express");
const http = require("http");
const jwt = require("jsonwebtoken");
const database = require("../config/database");
const env = require("../config/env");
const authRequired = require("../middleware/authRequired");
const { publicUser } = require("../services/auth.service");
const {
  mintDataPlaneToken,
  DATA_TOKEN_TTL
} = require("../services/data-plane-token.service");

const controlRouter = express.Router();
const restRouter = express.Router();
const POSTGREST_HOST = process.env.GOODOS_POSTGREST_HOST || "127.0.0.1";
const POSTGREST_PORT = Number(process.env.GOODOS_POSTGREST_PORT || 8300);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-range",
  "range-unit",
  "preference-applied",
  "location",
  "link",
  "etag",
  "last-modified",
  "cache-control"
]);

function postgrestRequest({ method = "GET", path = "/", headers = {}, body, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: POSTGREST_HOST,
        port: POSTGREST_PORT,
        method,
        path,
        headers,
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("GoodOS Data API timed out."));
    });
    request.on("error", reject);
    if (body?.length) request.write(body);
    request.end();
  });
}

async function componentHealth() {
  const startedAt = Date.now();
  try {
    const response = await postgrestRequest({ path: "/", timeoutMs: 3000 });
    const healthy = response.statusCode >= 200 && response.statusCode < 500;
    await database.query(
      `
        UPDATE backend_data_plane_components
        SET
          status = CASE WHEN $2 THEN 'active' ELSE 'degraded' END,
          health_status = CASE WHEN $2 THEN 'healthy' ELSE 'unhealthy' END,
          last_health_check_at = NOW(),
          metadata_json = metadata_json || jsonb_build_object('latencyMs', $3::int),
          updated_at = NOW()
        WHERE component = 'postgrest'
      `,
      [response.statusCode, healthy, Date.now() - startedAt]
    ).catch(() => null);
    return {
      healthy,
      statusCode: response.statusCode,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    await database.query(
      `
        UPDATE backend_data_plane_components
        SET status = 'degraded', health_status = 'unhealthy', last_health_check_at = NOW(), updated_at = NOW()
        WHERE component = 'postgrest'
      `
    ).catch(() => null);
    return {
      healthy: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      message: "Automatic REST data plane is unavailable."
    };
  }
}

controlRouter.get("/health", async (request, response) => {
  const postgrest = await componentHealth();
  return response.status(postgrest.healthy ? 200 : 503).json({
    success: postgrest.healthy,
    service: "GoodOS Data Platform",
    status: postgrest.healthy ? "operational" : "degraded",
    components: {
      automaticRest: postgrest
    }
  });
});

controlRouter.post("/token", authRequired, (request, response) => {
  try {
    return response.json({
      success: true,
      token: mintDataPlaneToken(request),
      tokenType: "Bearer",
      expiresIn: DATA_TOKEN_TTL,
      endpoint: "https://backend.goodos.app/rest/v1"
    });
  } catch (error) {
    return response.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to issue a data-plane token."
    });
  }
});

async function dataPlaneAuth(request, response, next) {
  const authorization = String(request.get("authorization") || "");
  const rawToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!rawToken) return authRequired(request, response, next);

  try {
    const decoded = jwt.verify(rawToken, env.jwtSecret);
    if (decoded.tokenUse !== "data_plane") {
      return authRequired(request, response, next);
    }

    const result = await database.query(
      `
        SELECT
          session.id AS session_id,
          session.auth_level AS session_auth_level,
          session.mfa_verified AS session_mfa_verified,
          session.risk_score AS session_risk_score,
          account.*
        FROM sessions AS session
        JOIN users AS account ON account.id = session.user_id
        WHERE session.id = $1::uuid
          AND session.user_id = $2::uuid
          AND session.revoked_at IS NULL
          AND session.expires_at > NOW()
          AND account.status = 'active'
        LIMIT 1
      `,
      [decoded.sid, decoded.sub]
    );
    const sessionUser = result.rows[0];

    if (!sessionUser) {
      return response.status(401).json({ success: false, message: "Data token session expired or revoked." });
    }
    if (sessionUser.mfa_required && !sessionUser.session_mfa_verified) {
      return response.status(403).json({ success: false, message: "Complete the account's required MFA step before data access." });
    }

    request.user = publicUser(sessionUser);
    request.auth = {
      token: rawToken,
      decoded,
      source: "data_plane",
      sessionId: sessionUser.session_id,
      authLevel: sessionUser.session_auth_level || "password",
      mfaVerified: Boolean(sessionUser.session_mfa_verified),
      riskScore: Number(sessionUser.session_risk_score || 0)
    };
    return next();
  } catch (error) {
    return response.status(401).json({ success: false, message: "Invalid or expired data token." });
  }
}

restRouter.use(dataPlaneAuth);

restRouter.use(async (request, response) => {
  try {
    const token = mintDataPlaneToken(request);
    let body = null;

    if (!["GET", "HEAD", "DELETE"].includes(request.method) && request.body !== undefined) {
      body = Buffer.from(JSON.stringify(request.body));
    }

    const headers = {
      authorization: `Bearer ${token}`,
      accept: request.get("accept") || "application/json",
      "accept-profile": request.get("accept-profile") || "goodos_api",
      "content-profile": request.get("content-profile") || "goodos_api",
      prefer: request.get("prefer") || "return=representation",
      "user-agent": request.get("user-agent") || "GoodOS-Data-Gateway/1.0",
      "x-request-id": request.id || request.get("x-request-id") || ""
    };

    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }
    if (request.get("range")) headers.range = request.get("range");
    if (request.get("range-unit")) headers["range-unit"] = request.get("range-unit");

    const upstream = await postgrestRequest({
      method: request.method,
      path: request.url || "/",
      headers,
      body,
      timeoutMs: 30000
    });

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (FORWARDED_RESPONSE_HEADERS.has(name) && value !== undefined) {
        response.set(name, value);
      }
    }
    response.set("X-GoodOS-Data-Plane", "postgrest-14.12");
    return response.status(upstream.statusCode).send(upstream.body);
  } catch (error) {
    return response.status(502).json({
      success: false,
      message: "GoodOS Data API is temporarily unavailable."
    });
  }
});

module.exports = {
  controlRouter,
  restRouter,
  __test: {
    postgrestRequest,
    dataPlaneAuth
  }
};
