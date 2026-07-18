"use strict";

const policyEngine = require("../services/policy-engine-v2.service");

function sourceIp(request) {
  const raw = String(
    request.ip || request.socket?.remoteAddress || ""
  ).trim();

  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (raw === "::1") return "127.0.0.1";
  return raw;
}

async function policyEngineV2Middleware(request, response, next) {
  try {
    const apiKey = request.goodosApiKey;
    if (!apiKey) {
      return response.status(500).json({
        success: false,
        code: "POLICY_CONTEXT_MISSING",
        message: "API gateway identity context is unavailable.",
        requestId: request.gatewayContext?.requestId || null,
      });
    }

    const path = String(request.originalUrl || request.url || "/").split("?")[0];

    const decision = await policyEngine.evaluatePolicy({
      organizationId: apiKey.organizationId || "org_goodos",
      projectId: apiKey.projectId || null,
      environmentId: apiKey.environmentId || null,
      targetType: "api_gateway",
      targetId: path,
      operation: request.method,
      actorType: "api_key",
      actorId: apiKey.id,
      apiKey,
      request: {
        method: request.method,
        path,
        sourceIp: sourceIp(request),
        headers: request.headers,
      },
      attributes: {
        serviceAccountId: apiKey.serviceAccountId || null,
        apiKeyType: apiKey.type,
        gatewayPolicyId: apiKey.policyId,
      },
      requestId: request.gatewayContext?.requestId || null,
      simulated: false,
      logEvaluation: true,
    });

    request.policyDecision = decision;
    if (request.gatewayContext) {
      request.gatewayContext.policyDecision = decision;
    }

    response.set("X-GoodOS-Policy-Decision", decision.decision);
    response.set("X-GoodOS-Policy-Engine", decision.engineVersion);
    if (decision.policyId) {
      response.set("X-GoodOS-Policy-ID", decision.policyId);
    }

    if (!decision.allowed) {
      return response.status(403).json({
        success: false,
        code: "POLICY_DENIED",
        message: decision.reason || "Request denied by GoodOS policy.",
        policyId: decision.policyId,
        requestId: request.gatewayContext?.requestId || null,
      });
    }

    return next();
  } catch (error) {
    console.error("Policy Engine V2 enforcement failed:", error);

    return response.status(500).json({
      success: false,
      code: "POLICY_ENGINE_FAILED",
      message: "Policy evaluation failed.",
      requestId: request.gatewayContext?.requestId || null,
    });
  }
}

module.exports = policyEngineV2Middleware;
