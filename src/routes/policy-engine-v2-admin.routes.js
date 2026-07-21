"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { query } = require("../config/database");
const { logAudit } = require("../services/audit.service");
const policyEngine = require("../services/policy-engine-v2.service");

const router = express.Router();

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanText(value, maximum = 255) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function integerValue(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

async function adminRequired(request, response, next) {
  try {
    const result = await query(
      `
        SELECT
          account.platform_role,
          membership.role AS organization_role
        FROM users AS account
        JOIN backend_organization_memberships AS membership
          ON membership.user_id = account.id
        WHERE account.id = $1::uuid
          AND account.status = 'active'
          AND membership.organization_id = $2
          AND membership.status = 'active'
        LIMIT 1
      `,
      [request.user.id, request.tenantContext.organizationId]
    );

    const identity = result.rows[0];
    const permitted =
      identity &&
      (["owner", "admin"].includes(identity.platform_role) ||
        ["owner", "admin"].includes(identity.organization_role));

    if (!permitted) {
      return response.status(403).json({
        success: false,
        code: "POLICY_ENGINE_ADMIN_REQUIRED",
        message: "Owner or administrator access is required.",
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function audit({ request, action, entityType, entityId, metadata = {} }) {
  return logAudit({
    userId: request.user.id,
    appId: "goodos",
    action,
    entityType,
    entityId,
    ipAddress: request.ip,
    metadata: {
      organizationId: request.tenantContext.organizationId,
      ...metadata,
    },
  });
}

router.get("/health", async (request, response) => {
  try {
    const result = await query(`
      SELECT
        to_regclass('public.backend_policy_rules') IS NOT NULL AS rules,
        to_regclass('public.backend_policy_evaluations') IS NOT NULL AS evaluations,
        to_regclass('public.backend_policy_rule_sets') IS NOT NULL AS rule_sets,
        to_regclass('public.backend_policy_rule_revisions') IS NOT NULL AS revisions,
        to_regclass('public.backend_policy_engine_settings') IS NOT NULL AS settings
    `);

    const components = result.rows[0] || {};
    const ready = Object.values(components).every(Boolean);

    return response.status(ready ? 200 : 503).json({
      success: ready,
      service: "GoodOS Central Rules Engine V2",
      status: ready ? "ready" : "incomplete",
      engineVersion: policyEngine.ENGINE_VERSION,
      components,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return response.status(500).json({
      success: false,
      status: "failed",
      message: error.message,
    });
  }
});

router.use(authRequired, tenantContext, adminRequired);

router.get("/overview", async (request, response, next) => {
  try {
    const organizationId = request.tenantContext.organizationId;
    const [settingsResult, countsResult, decisionsResult] = await Promise.all([
      query(
        `
          SELECT
            organization_id AS "organizationId",
            status,
            evaluation_mode AS "evaluationMode",
            default_effect AS "defaultEffect",
            fail_mode AS "failMode",
            trace_enabled AS "traceEnabled",
            updated_at AS "updatedAt"
          FROM backend_policy_engine_settings
          WHERE organization_id = $1
          LIMIT 1
        `,
        [organizationId]
      ),
      query(
        `
          SELECT
            (SELECT COUNT(*)::int FROM backend_policy_rule_sets
             WHERE organization_id = $1 AND status = 'active') AS active_rule_sets,
            (SELECT COUNT(*)::int FROM backend_policy_rules
             WHERE organization_id = $1 AND status = 'active') AS active_rules,
            (SELECT COUNT(*)::int FROM backend_policy_rule_revisions
             WHERE rule_id IN (
               SELECT id FROM backend_policy_rules WHERE organization_id = $1
             )) AS revisions,
            (SELECT COUNT(*)::int FROM backend_policy_evaluations
             WHERE organization_id = $1
               AND created_at >= NOW() - INTERVAL '24 hours') AS evaluations_24h
        `,
        [organizationId]
      ),
      query(
        `
          SELECT decision, COUNT(*)::int AS count
          FROM backend_policy_evaluations
          WHERE organization_id = $1
            AND created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY decision
          ORDER BY decision
        `,
        [organizationId]
      ),
    ]);

    return response.json({
      success: true,
      engineVersion: policyEngine.ENGINE_VERSION,
      settings: settingsResult.rows[0] || null,
      stats: countsResult.rows[0] || {},
      decisions: decisionsResult.rows,
      managementBaseUrl:
        "https://base.goodos.app/api/policy-engine-v2",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/rule-sets", async (request, response, next) => {
  try {
    const result = await query(
      `
        SELECT
          rule_set.id,
          rule_set.name,
          rule_set.description,
          rule_set.status,
          rule_set.evaluation_mode AS "evaluationMode",
          rule_set.version,
          rule_set.published_at AS "publishedAt",
          rule_set.created_at AS "createdAt",
          rule_set.updated_at AS "updatedAt",
          COUNT(rule.id)::int AS "ruleCount"
        FROM backend_policy_rule_sets AS rule_set
        LEFT JOIN backend_policy_rules AS rule
          ON rule.rule_set_id = rule_set.id
        WHERE rule_set.organization_id = $1
        GROUP BY rule_set.id
        ORDER BY rule_set.created_at
      `,
      [request.tenantContext.organizationId]
    );

    return response.json({ success: true, ruleSets: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/rules", async (request, response, next) => {
  try {
    const result = await query(
      `
        SELECT
          rule.id,
          rule.name,
          rule.description,
          rule.rule_set_id AS "ruleSetId",
          rule_set.name AS "ruleSetName",
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
          rule.published_at AS "publishedAt",
          rule.created_at AS "createdAt",
          rule.updated_at AS "updatedAt"
        FROM backend_policy_rules AS rule
        LEFT JOIN backend_policy_rule_sets AS rule_set
          ON rule_set.id = rule.rule_set_id
        WHERE rule.organization_id = $1
        ORDER BY rule.priority, rule.created_at
      `,
      [request.tenantContext.organizationId]
    );

    return response.json({ success: true, rules: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/rules", async (request, response, next) => {
  try {
    const name = cleanText(request.body?.name, 180);
    const targetType = cleanText(request.body?.targetType, 120);
    const targetId = cleanText(request.body?.targetId || "*", 500);
    const operation = cleanText(request.body?.operation || "*", 80);
    const effect = cleanText(request.body?.effect || "deny", 20).toLowerCase();
    const matchMode = cleanText(
      request.body?.matchMode || "all",
      20
    ).toLowerCase();

    if (name.length < 3 || !targetType) {
      return response.status(400).json({
        success: false,
        message: "Rule name and targetType are required.",
      });
    }

    if (!["allow", "deny"].includes(effect)) {
      return response.status(400).json({
        success: false,
        message: "Rule effect must be allow or deny.",
      });
    }

    if (!["all", "any"].includes(matchMode)) {
      return response.status(400).json({
        success: false,
        message: "matchMode must be all or any.",
      });
    }

    const ruleSetId = cleanText(
      request.body?.ruleSetId || "ruleset_phase17_gateway_v2",
      180
    );

    const ruleSetResult = await query(
      `
        SELECT id
        FROM backend_policy_rule_sets
        WHERE id = $1
          AND organization_id = $2
          AND status IN ('draft', 'active')
        LIMIT 1
      `,
      [ruleSetId, request.tenantContext.organizationId]
    );

    if (ruleSetResult.rowCount === 0) {
      return response.status(400).json({
        success: false,
        message: "The selected rule set was not found.",
      });
    }

    const id = identifier("pol");
    const conditionJson = objectValue(request.body?.conditionJson);
    const ruleData = {
      ruleSetId,
      name,
      targetType,
      targetId,
      operation,
      effect,
      priority: integerValue(request.body?.priority, 100, 1, 100000),
      conditionJson,
      matchMode,
      rolloutPercentage: integerValue(
        request.body?.rolloutPercentage,
        100,
        0,
        100
      ),
      startsAt: request.body?.startsAt || null,
      endsAt: request.body?.endsAt || null,
    };
    const calculatedChecksum = policyEngine.ruleChecksum(ruleData);

    const result = await query(
      `
        INSERT INTO backend_policy_rules (
          id, name, description, rule_set_id, target_type, target_id,
          operation, effect, priority, condition_json, message, status,
          match_mode, rollout_percentage, version, checksum, starts_at,
          ends_at, organization_id, project_id, environment_id,
          metadata_json, created_by
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10::jsonb, $11, 'draft',
          $12, $13, 1, $14, $15,
          $16, $17, $18, $19,
          $20::jsonb, $21::uuid
        )
        RETURNING
          id, name, status, version, checksum,
          rule_set_id AS "ruleSetId",
          target_type AS "targetType",
          target_id AS "targetId",
          operation, effect, priority,
          condition_json AS "conditionJson"
      `,
      [
        id,
        name,
        cleanText(request.body?.description, 1000) || null,
        ruleSetId,
        targetType,
        targetId,
        operation,
        effect,
        ruleData.priority,
        JSON.stringify(conditionJson),
        cleanText(request.body?.message, 1000) || null,
        matchMode,
        ruleData.rolloutPercentage,
        calculatedChecksum,
        ruleData.startsAt,
        ruleData.endsAt,
        request.tenantContext.organizationId,
        request.tenantContext.projectId,
        request.tenantContext.environmentId,
        JSON.stringify({ source: "phase17-rules-engine-v2" }),
        request.user.id,
      ]
    );

    await audit({
      request,
      action: "policy.rule.created",
      entityType: "policy_rule",
      entityId: id,
      metadata: { ruleSetId, targetType, targetId, operation, effect },
    });

    return response.status(201).json({ success: true, rule: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch("/rules/:ruleId", async (request, response, next) => {
  try {
    const currentResult = await query(
      `
        SELECT *
        FROM backend_policy_rules
        WHERE id = $1 AND organization_id = $2
        LIMIT 1
      `,
      [request.params.ruleId, request.tenantContext.organizationId]
    );

    const current = currentResult.rows[0];
    if (!current) {
      return response.status(404).json({
        success: false,
        message: "Policy rule was not found.",
      });
    }

    const ruleData = {
      ruleSetId: request.body?.ruleSetId ?? current.rule_set_id,
      name:
        request.body?.name === undefined
          ? current.name
          : cleanText(request.body.name, 180),
      targetType:
        request.body?.targetType === undefined
          ? current.target_type
          : cleanText(request.body.targetType, 120),
      targetId:
        request.body?.targetId === undefined
          ? current.target_id
          : cleanText(request.body.targetId, 500),
      operation:
        request.body?.operation === undefined
          ? current.operation
          : cleanText(request.body.operation, 80),
      effect:
        request.body?.effect === undefined
          ? current.effect
          : cleanText(request.body.effect, 20).toLowerCase(),
      priority:
        request.body?.priority === undefined
          ? current.priority
          : integerValue(request.body.priority, current.priority, 1, 100000),
      conditionJson:
        request.body?.conditionJson === undefined
          ? current.condition_json
          : objectValue(request.body.conditionJson),
      matchMode:
        request.body?.matchMode === undefined
          ? current.match_mode
          : cleanText(request.body.matchMode, 20).toLowerCase(),
      rolloutPercentage:
        request.body?.rolloutPercentage === undefined
          ? current.rollout_percentage
          : integerValue(
              request.body.rolloutPercentage,
              current.rollout_percentage,
              0,
              100
            ),
      startsAt:
        request.body?.startsAt === undefined
          ? current.starts_at
          : request.body.startsAt,
      endsAt:
        request.body?.endsAt === undefined
          ? current.ends_at
          : request.body.endsAt,
    };

    if (!["allow", "deny"].includes(ruleData.effect)) {
      return response.status(400).json({
        success: false,
        message: "Rule effect must be allow or deny.",
      });
    }

    if (!["all", "any"].includes(ruleData.matchMode)) {
      return response.status(400).json({
        success: false,
        message: "matchMode must be all or any.",
      });
    }

    const calculatedChecksum = policyEngine.ruleChecksum(ruleData);

    const result = await query(
      `
        UPDATE backend_policy_rules
        SET
          name = $3,
          description = $4,
          rule_set_id = $5,
          target_type = $6,
          target_id = $7,
          operation = $8,
          effect = $9,
          priority = $10,
          condition_json = $11::jsonb,
          message = $12,
          status = 'draft',
          match_mode = $13,
          rollout_percentage = $14,
          starts_at = $15,
          ends_at = $16,
          version = version + 1,
          checksum = $17,
          updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING
          id, name, status, version, checksum,
          rule_set_id AS "ruleSetId",
          target_type AS "targetType",
          target_id AS "targetId",
          operation, effect, priority,
          condition_json AS "conditionJson"
      `,
      [
        request.params.ruleId,
        request.tenantContext.organizationId,
        ruleData.name,
        request.body?.description === undefined
          ? current.description
          : cleanText(request.body.description, 1000) || null,
        ruleData.ruleSetId,
        ruleData.targetType,
        ruleData.targetId,
        ruleData.operation,
        ruleData.effect,
        ruleData.priority,
        JSON.stringify(ruleData.conditionJson),
        request.body?.message === undefined
          ? current.message
          : cleanText(request.body.message, 1000) || null,
        ruleData.matchMode,
        ruleData.rolloutPercentage,
        ruleData.startsAt,
        ruleData.endsAt,
        calculatedChecksum,
      ]
    );

    await audit({
      request,
      action: "policy.rule.updated",
      entityType: "policy_rule",
      entityId: request.params.ruleId,
      metadata: { version: result.rows[0].version },
    });

    return response.json({
      success: true,
      rule: result.rows[0],
      message: "Policy rule saved as a draft and requires publishing.",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/rules/:ruleId/publish", async (request, response, next) => {
  try {
    const rule = await policyEngine.publishRuleRevision({
      ruleId: request.params.ruleId,
      userId: request.user.id,
      changeNote: cleanText(request.body?.changeNote, 1000) || null,
    });

    await audit({
      request,
      action: "policy.rule.published",
      entityType: "policy_rule",
      entityId: request.params.ruleId,
      metadata: { version: rule.version, checksum: rule.checksum },
    });

    return response.json({
      success: true,
      rule,
      message: "Policy rule published and active.",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/rules/:ruleId/disable", async (request, response, next) => {
  try {
    const result = await query(
      `
        UPDATE backend_policy_rules
        SET status = 'disabled', updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING id, name, status, version
      `,
      [request.params.ruleId, request.tenantContext.organizationId]
    );

    if (result.rowCount === 0) {
      return response.status(404).json({
        success: false,
        message: "Policy rule was not found.",
      });
    }

    await audit({
      request,
      action: "policy.rule.disabled",
      entityType: "policy_rule",
      entityId: request.params.ruleId,
    });

    return response.json({ success: true, rule: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.post("/simulate", async (request, response, next) => {
  try {
    const simulation = await policyEngine.evaluatePolicy({
      organizationId: request.tenantContext.organizationId,
      projectId: request.tenantContext.projectId,
      environmentId: request.tenantContext.environmentId,
      targetType: cleanText(request.body?.targetType || "api_gateway", 120),
      targetId: cleanText(request.body?.targetId || "*", 500),
      operation: cleanText(request.body?.operation || "*", 80),
      actorType: cleanText(request.body?.actorType || "simulation", 80),
      actorId: cleanText(request.body?.actorId || request.user.id, 180),
      apiKey: objectValue(request.body?.apiKey),
      request: objectValue(request.body?.request),
      attributes: objectValue(request.body?.attributes),
      requestId: identifier("simreq"),
      simulated: true,
      logEvaluation: true,
    });

    return response.json({ success: true, simulation });
  } catch (error) {
    return next(error);
  }
});

router.get("/evaluations", async (request, response, next) => {
  try {
    const limit = integerValue(request.query.limit, 100, 1, 500);
    const result = await query(
      `
        SELECT
          evaluation.id,
          evaluation.request_id AS "requestId",
          evaluation.policy_id AS "policyId",
          rule.name AS "policyName",
          evaluation.rule_set_id AS "ruleSetId",
          evaluation.decision,
          evaluation.reason,
          evaluation.target_type AS "targetType",
          evaluation.target_id AS "targetId",
          evaluation.operation,
          evaluation.actor_type AS "actorType",
          evaluation.actor_id AS "actorId",
          evaluation.api_key_id AS "apiKeyId",
          evaluation.matched_policy_ids AS "matchedPolicyIds",
          evaluation.trace_json AS "trace",
          evaluation.duration_ms AS "durationMs",
          evaluation.simulated,
          evaluation.engine_version AS "engineVersion",
          evaluation.created_at AS "createdAt"
        FROM backend_policy_evaluations AS evaluation
        LEFT JOIN backend_policy_rules AS rule
          ON rule.id = evaluation.policy_id
        WHERE evaluation.organization_id = $1
        ORDER BY evaluation.created_at DESC
        LIMIT $2
      `,
      [request.tenantContext.organizationId, limit]
    );

    return response.json({ success: true, evaluations: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.put("/settings", async (request, response, next) => {
  try {
    const evaluationMode = cleanText(
      request.body?.evaluationMode || "enforce",
      30
    ).toLowerCase();
    const defaultEffect = cleanText(
      request.body?.defaultEffect || "allow",
      20
    ).toLowerCase();
    const failMode = cleanText(
      request.body?.failMode || "allow",
      20
    ).toLowerCase();

    if (!["enforce", "monitor", "disabled"].includes(evaluationMode)) {
      return response.status(400).json({
        success: false,
        message: "evaluationMode must be enforce, monitor, or disabled.",
      });
    }

    if (
      !["allow", "deny"].includes(defaultEffect) ||
      !["allow", "deny"].includes(failMode)
    ) {
      return response.status(400).json({
        success: false,
        message: "defaultEffect and failMode must be allow or deny.",
      });
    }

    const result = await query(
      `
        INSERT INTO backend_policy_engine_settings (
          organization_id, status, evaluation_mode, default_effect,
          fail_mode, trace_enabled, updated_by, metadata_json
        )
        VALUES ($1, 'active', $2, $3, $4, $5, $6::uuid, $7::jsonb)
        ON CONFLICT (organization_id)
        DO UPDATE SET
          status = 'active',
          evaluation_mode = EXCLUDED.evaluation_mode,
          default_effect = EXCLUDED.default_effect,
          fail_mode = EXCLUDED.fail_mode,
          trace_enabled = EXCLUDED.trace_enabled,
          updated_by = EXCLUDED.updated_by,
          metadata_json =
            COALESCE(backend_policy_engine_settings.metadata_json, '{}'::jsonb)
            || EXCLUDED.metadata_json,
          updated_at = NOW()
        RETURNING
          organization_id AS "organizationId",
          status,
          evaluation_mode AS "evaluationMode",
          default_effect AS "defaultEffect",
          fail_mode AS "failMode",
          trace_enabled AS "traceEnabled",
          updated_at AS "updatedAt"
      `,
      [
        request.tenantContext.organizationId,
        evaluationMode,
        defaultEffect,
        failMode,
        request.body?.traceEnabled !== false,
        request.user.id,
        JSON.stringify({ source: "phase17-rules-engine-v2" }),
      ]
    );

    await audit({
      request,
      action: "policy.settings.updated",
      entityType: "policy_engine_settings",
      entityId: request.tenantContext.organizationId,
      metadata: { evaluationMode, defaultEffect, failMode },
    });

    return response.json({ success: true, settings: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.use((error, request, response, next) => {
  console.error("Policy Engine V2 request failed:", error);

  return response.status(error.statusCode || 500).json({
    success: false,
    code: error.code || "POLICY_ENGINE_REQUEST_FAILED",
    message: error.message || "Policy Engine request failed.",
  });
});

module.exports = router;
