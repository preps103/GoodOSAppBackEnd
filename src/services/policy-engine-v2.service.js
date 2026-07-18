"use strict";

const crypto = require("crypto");
const { query } = require("../config/database");

const ENGINE_VERSION = "v2";

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function text(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function arrayValue(value) {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }
  return value === undefined || value === null || value === ""
    ? []
    : [text(value)].filter(Boolean);
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ruleChecksum(rule) {
  return checksum({
    ruleSetId: rule.ruleSetId ?? rule.rule_set_id ?? null,
    name: rule.name,
    targetType: rule.targetType ?? rule.target_type,
    targetId: rule.targetId ?? rule.target_id,
    operation: rule.operation,
    effect: rule.effect,
    priority: Number(rule.priority ?? 100),
    conditionJson: rule.conditionJson ?? rule.condition_json ?? {},
    matchMode: rule.matchMode ?? rule.match_mode ?? "all",
    rolloutPercentage: Number(
      rule.rolloutPercentage ?? rule.rollout_percentage ?? 100
    ),
    startsAt: rule.startsAt ?? rule.starts_at ?? null,
    endsAt: rule.endsAt ?? rule.ends_at ?? null,
  });
}

function hasScope(apiKey, requiredScope) {
  const scopes = arrayValue(apiKey?.scopes);
  const type = lower(apiKey?.type);

  if (["full_access", "admin", "owner"].includes(type)) return true;
  if (scopes.includes("*") || scopes.includes(requiredScope)) return true;

  const family = text(requiredScope).split(":")[0];
  return Boolean(
    family &&
      (scopes.includes(`${family}:*`) ||
        (requiredScope.startsWith("read:") && scopes.includes("read:*")))
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardMatch(pattern, value) {
  const expected = text(pattern || "*");
  const actual = text(value);
  if (expected === "*") return true;

  const expression = expected.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${expression}$`, "i").test(actual);
}

function normalizeIp(value) {
  const ip = text(value);
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}

function ipv4ToInteger(value) {
  const parts = String(value || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }

  return (
    (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
  );
}

function ipMatchesRule(sourceIp, rule) {
  const source = normalizeIp(sourceIp);
  const expected = normalizeIp(rule);

  if (!expected) return false;
  if (expected === "*" || expected === source) return true;

  const [network, prefixText] = expected.split("/");
  if (prefixText === undefined) return false;

  const sourceInteger = ipv4ToInteger(source);
  const networkInteger = ipv4ToInteger(network);
  const prefix = Number.parseInt(prefixText, 10);

  if (
    sourceInteger === null ||
    networkInteger === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (sourceInteger & mask) === (networkInteger & mask);
}

function deterministicPercentage(seed) {
  return (
    (Number.parseInt(
      crypto.createHash("sha256").update(String(seed || "")).digest("hex").slice(0, 8),
      16
    ) %
      100) +
    1
  );
}

function headerValue(headers, name) {
  const target = lower(name);
  for (const [key, value] of Object.entries(headers || {})) {
    if (lower(key) === target) return text(value);
  }
  return "";
}

function valueMatches(expected, actual) {
  if (Array.isArray(expected)) {
    return expected.some((item) => valueMatches(item, actual));
  }

  if (expected && typeof expected === "object") {
    if (Object.prototype.hasOwnProperty.call(expected, "equals")) {
      return text(actual) === text(expected.equals);
    }
    if (Object.prototype.hasOwnProperty.call(expected, "notEquals")) {
      return text(actual) !== text(expected.notEquals);
    }
    if (Array.isArray(expected.in)) {
      return expected.in.some((item) => text(item) === text(actual));
    }
    if (Array.isArray(expected.notIn)) {
      return !expected.notIn.some((item) => text(item) === text(actual));
    }
    if (expected.matches) {
      return wildcardMatch(expected.matches, actual);
    }
  }

  return text(expected) === text(actual);
}

function conditionChecks(condition, context) {
  const checks = [];
  const apiKey = context.apiKey || {};
  const request = context.request || {};
  const attributes = context.attributes || {};

  const requiredScopes = arrayValue(
    condition.requiredScopes ?? condition.required_scopes
  );
  if (requiredScopes.length) {
    checks.push({
      name: "requiredScopes",
      passed: requiredScopes.every((scope) => hasScope(apiKey, scope)),
      expected: requiredScopes,
      actual: arrayValue(apiKey.scopes),
    });
  }

  const anyScopes = arrayValue(condition.anyScopes ?? condition.any_scopes);
  if (anyScopes.length) {
    checks.push({
      name: "anyScopes",
      passed: anyScopes.some((scope) => hasScope(apiKey, scope)),
      expected: anyScopes,
      actual: arrayValue(apiKey.scopes),
    });
  }

  const deniedScopes = arrayValue(
    condition.deniedScopes ?? condition.denied_scopes
  );
  if (deniedScopes.length) {
    checks.push({
      name: "deniedScopes",
      passed: !deniedScopes.some((scope) => hasScope(apiKey, scope)),
      expected: deniedScopes,
      actual: arrayValue(apiKey.scopes),
    });
  }

  const apiKeyIds = arrayValue(condition.apiKeyIds ?? condition.api_key_ids);
  if (apiKeyIds.length) {
    checks.push({
      name: "apiKeyIds",
      passed: apiKeyIds.includes(text(apiKey.id)),
      expected: apiKeyIds,
      actual: apiKey.id || null,
    });
  }

  const serviceAccountIds = arrayValue(
    condition.serviceAccountIds ?? condition.service_account_ids
  );
  if (serviceAccountIds.length) {
    checks.push({
      name: "serviceAccountIds",
      passed: serviceAccountIds.includes(text(apiKey.serviceAccountId)),
      expected: serviceAccountIds,
      actual: apiKey.serviceAccountId || null,
    });
  }

  const methods = arrayValue(condition.methods).map(lower);
  if (methods.length) {
    checks.push({
      name: "methods",
      passed: methods.includes(lower(request.method)),
      expected: methods,
      actual: lower(request.method),
    });
  }

  const paths = arrayValue(condition.paths);
  if (paths.length) {
    checks.push({
      name: "paths",
      passed: paths.some((pattern) => wildcardMatch(pattern, request.path)),
      expected: paths,
      actual: request.path || null,
    });
  }

  const sourceIps = arrayValue(
    condition.sourceIps ??
      condition.source_ips ??
      condition.sourceCidrs ??
      condition.source_cidrs
  );
  if (sourceIps.length) {
    checks.push({
      name: "sourceIps",
      passed: sourceIps.some((rule) => ipMatchesRule(request.sourceIp, rule)),
      expected: sourceIps,
      actual: request.sourceIp || null,
    });
  }

  const requiredHeaders =
    condition.requiredHeaders ?? condition.required_headers ?? {};
  if (
    requiredHeaders &&
    typeof requiredHeaders === "object" &&
    !Array.isArray(requiredHeaders)
  ) {
    for (const [name, expected] of Object.entries(requiredHeaders)) {
      const actual = headerValue(request.headers, name);
      checks.push({
        name: `header:${name}`,
        passed: valueMatches(expected, actual),
        expected,
        actual,
      });
    }
  }

  const requiredAttributes =
    condition.attributes ??
    condition.requiredAttributes ??
    condition.required_attributes ??
    {};
  if (
    requiredAttributes &&
    typeof requiredAttributes === "object" &&
    !Array.isArray(requiredAttributes)
  ) {
    for (const [name, expected] of Object.entries(requiredAttributes)) {
      const actual = attributes[name];
      checks.push({
        name: `attribute:${name}`,
        passed: valueMatches(expected, actual),
        expected,
        actual: actual ?? null,
      });
    }
  }

  return checks;
}

function ruleMatches({ rule, context, rolloutSeed }) {
  if (!wildcardMatch(rule.targetId, context.targetId)) {
    return { matched: false, targetMatched: false, checks: [] };
  }

  const rolloutPercentage = Math.min(
    Math.max(Number(rule.rolloutPercentage ?? 100), 0),
    100
  );
  const rolloutValue = deterministicPercentage(`${rolloutSeed}:${rule.id}`);
  if (rolloutValue > rolloutPercentage) {
    return {
      matched: false,
      targetMatched: true,
      rolloutMatched: false,
      rolloutValue,
      rolloutPercentage,
      checks: [],
    };
  }

  const condition =
    rule.conditionJson && typeof rule.conditionJson === "object"
      ? rule.conditionJson
      : {};
  const checks = conditionChecks(condition, context);
  const matchMode = lower(rule.matchMode) === "any" ? "any" : "all";
  const conditionsMatched =
    checks.length === 0
      ? true
      : matchMode === "any"
        ? checks.some((check) => check.passed)
        : checks.every((check) => check.passed);

  return {
    matched: conditionsMatched,
    targetMatched: true,
    rolloutMatched: true,
    rolloutValue,
    rolloutPercentage,
    matchMode,
    checks,
  };
}

async function loadSettings(organizationId) {
  const result = await query(
    `
      SELECT
        organization_id AS "organizationId",
        status,
        evaluation_mode AS "evaluationMode",
        default_effect AS "defaultEffect",
        fail_mode AS "failMode",
        trace_enabled AS "traceEnabled"
      FROM backend_policy_engine_settings
      WHERE organization_id = $1
      LIMIT 1
    `,
    [organizationId]
  );

  return (
    result.rows[0] || {
      organizationId,
      status: "active",
      evaluationMode: "enforce",
      defaultEffect: "allow",
      failMode: "allow",
      traceEnabled: true,
    }
  );
}

async function loadRules({ organizationId, targetType, operation }) {
  const result = await query(
    `
      SELECT
        rule.id,
        rule.name,
        rule.description,
        rule.rule_set_id AS "ruleSetId",
        rule.target_type AS "targetType",
        rule.target_id AS "targetId",
        rule.operation,
        rule.effect,
        rule.priority,
        rule.condition_json AS "conditionJson",
        rule.message,
        rule.status,
        rule.match_mode AS "matchMode",
        rule.rollout_percentage AS "rolloutPercentage",
        rule.version,
        rule.checksum,
        rule.starts_at AS "startsAt",
        rule.ends_at AS "endsAt",
        rule_set.name AS "ruleSetName",
        rule_set.status AS "ruleSetStatus",
        rule_set.evaluation_mode AS "ruleSetEvaluationMode"
      FROM backend_policy_rules AS rule
      LEFT JOIN backend_policy_rule_sets AS rule_set
        ON rule_set.id = rule.rule_set_id
      WHERE rule.status = 'active'
        AND (rule.organization_id IS NULL OR rule.organization_id = $1)
        AND (rule.target_type = '*' OR lower(rule.target_type) = lower($2))
        AND (rule.operation = '*' OR lower(rule.operation) = lower($3))
        AND (rule.starts_at IS NULL OR rule.starts_at <= NOW())
        AND (rule.ends_at IS NULL OR rule.ends_at > NOW())
        AND (rule.rule_set_id IS NULL OR rule_set.status = 'active')
      ORDER BY
        rule.priority ASC,
        CASE WHEN lower(rule.effect) = 'deny' THEN 0 ELSE 1 END ASC,
        rule.created_at ASC
    `,
    [organizationId, targetType, operation]
  );

  return result.rows;
}

async function recordEvaluation({
  decision,
  organizationId,
  projectId,
  environmentId,
  targetType,
  targetId,
  operation,
  actorType,
  actorId,
  apiKey,
  requestId,
  trace,
  simulated,
}) {
  await query(
    `
      INSERT INTO backend_policy_evaluations (
        id, policy_id, decision, reason, target_type, target_id, operation,
        actor_type, actor_id, api_key_id, organization_id, project_id,
        environment_id, context_json, request_id, rule_set_id,
        matched_policy_ids, trace_json, duration_ms, simulated, engine_version
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14::jsonb, $15, $16,
        $17::text[], $18::jsonb, $19, $20, $21
      )
    `,
    [
      identifier("poleval"),
      decision.policyId || null,
      decision.decision,
      decision.reason,
      targetType,
      targetId,
      operation,
      actorType,
      actorId,
      apiKey?.id || null,
      organizationId,
      projectId || null,
      environmentId || null,
      JSON.stringify({
        apiKey: apiKey?.id
          ? {
              id: apiKey.id,
              type: apiKey.type,
              scopes: apiKey.scopes || [],
              serviceAccountId: apiKey.serviceAccountId || null,
            }
          : null,
      }),
      requestId || null,
      decision.ruleSetId || null,
      decision.matchedPolicyIds,
      JSON.stringify(trace),
      decision.durationMs,
      Boolean(simulated),
      ENGINE_VERSION,
    ]
  );
}

async function evaluatePolicy(input = {}) {
  const startedAt = Date.now();
  const organizationId = text(
    input.organizationId || input.apiKey?.organizationId || "org_goodos"
  );
  const targetType = text(input.targetType || "*");
  const targetId = text(input.targetId || "*");
  const operation = text(input.operation || "*");
  const actorType = text(input.actorType || "api_key");
  const actorId = text(input.actorId || input.apiKey?.id || "") || null;
  const requestId = text(input.requestId || "") || null;
  const simulated = Boolean(input.simulated);
  const shouldLog = input.logEvaluation !== false;

  const settings = await loadSettings(organizationId);

  if (settings.status !== "active" || settings.evaluationMode === "disabled") {
    return {
      allowed: true,
      decision: "allow",
      evaluatedDecision: "allow",
      monitorMode: false,
      policyId: null,
      policyName: null,
      ruleSetId: null,
      ruleSetName: null,
      reason: "Policy engine is disabled.",
      engineVersion: ENGINE_VERSION,
      evaluationMode: settings.evaluationMode,
      defaultEffect: settings.defaultEffect,
      matchedPolicyIds: [],
      trace: [],
      durationMs: Date.now() - startedAt,
      simulated,
    };
  }

  const rules = await loadRules({ organizationId, targetType, operation });
  const context = {
    ...input,
    organizationId,
    targetType,
    targetId,
    operation,
    apiKey: input.apiKey || {},
    request: input.request || {},
    attributes: input.attributes || {},
  };

  const rolloutSeed =
    requestId || actorId || `${targetType}:${targetId}:${operation}`;
  const trace = [];
  const matchedRules = [];

  for (const rule of rules) {
    const match = ruleMatches({ rule, context, rolloutSeed });
    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleSetId: rule.ruleSetId,
      targetId: rule.targetId,
      effect: rule.effect,
      priority: rule.priority,
      ...match,
    });
    if (match.matched) matchedRules.push(rule);
  }

  const selected = matchedRules[0] || null;
  const rawDecision = selected
    ? lower(selected.effect)
    : lower(settings.defaultEffect || "allow");
  const normalizedDecision = ["allow", "deny"].includes(rawDecision)
    ? rawDecision
    : "deny";

  const monitorMode =
    settings.evaluationMode === "monitor" ||
    selected?.ruleSetEvaluationMode === "monitor";
  const enforcedDecision =
    monitorMode && normalizedDecision === "deny" ? "allow" : normalizedDecision;

  const decision = {
    allowed: enforcedDecision === "allow",
    decision: enforcedDecision,
    evaluatedDecision: normalizedDecision,
    monitorMode,
    policyId: selected?.id || null,
    policyName: selected?.name || null,
    ruleSetId: selected?.ruleSetId || null,
    ruleSetName: selected?.ruleSetName || null,
    reason: selected
      ? selected.message || `${selected.name}: ${normalizedDecision}`
      : `No matching policy. Default effect: ${settings.defaultEffect}.`,
    engineVersion: ENGINE_VERSION,
    evaluationMode: settings.evaluationMode,
    defaultEffect: settings.defaultEffect,
    matchedPolicyIds: matchedRules.map((rule) => rule.id),
    trace: settings.traceEnabled ? trace : [],
    durationMs: Date.now() - startedAt,
    simulated,
  };

  if (shouldLog) {
    await recordEvaluation({
      decision,
      organizationId,
      projectId: input.projectId || input.apiKey?.projectId,
      environmentId: input.environmentId || input.apiKey?.environmentId,
      targetType,
      targetId,
      operation,
      actorType,
      actorId,
      apiKey: input.apiKey,
      requestId,
      trace: decision.trace,
      simulated,
    });
  }

  return decision;
}

async function publishRuleRevision({ ruleId, userId, changeNote = null }) {
  const result = await query(
    `
      SELECT
        id, name, description, rule_set_id AS "ruleSetId",
        target_type AS "targetType", target_id AS "targetId",
        operation, effect, priority, condition_json AS "conditionJson",
        message, match_mode AS "matchMode",
        rollout_percentage AS "rolloutPercentage",
        starts_at AS "startsAt", ends_at AS "endsAt", version
      FROM backend_policy_rules
      WHERE id = $1
      LIMIT 1
    `,
    [ruleId]
  );

  const rule = result.rows[0];
  if (!rule) {
    const error = new Error("Policy rule was not found.");
    error.statusCode = 404;
    throw error;
  }

  const calculatedChecksum = ruleChecksum(rule);
  const snapshot = {
    ...rule,
    checksum: calculatedChecksum,
    publishedAt: new Date().toISOString(),
    publishedBy: userId || null,
  };

  await query(
    `
      INSERT INTO backend_policy_rule_revisions (
        id, rule_id, rule_set_id, version, checksum,
        snapshot_json, change_note, published_by
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::uuid)
      ON CONFLICT (rule_id, version) DO NOTHING
    `,
    [
      identifier("polrev"),
      rule.id,
      rule.ruleSetId || null,
      Number(rule.version || 1),
      calculatedChecksum,
      JSON.stringify(snapshot),
      changeNote || null,
      userId || null,
    ]
  );

  const updateResult = await query(
    `
      UPDATE backend_policy_rules
      SET
        status = 'active',
        checksum = $2,
        published_by = $3::uuid,
        published_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id, name, status, version, checksum,
        rule_set_id AS "ruleSetId",
        published_at AS "publishedAt"
    `,
    [rule.id, calculatedChecksum, userId || null]
  );

  return updateResult.rows[0];
}

module.exports = {
  ENGINE_VERSION,
  checksum,
  ruleChecksum,
  evaluatePolicy,
  publishRuleRevision,
};
