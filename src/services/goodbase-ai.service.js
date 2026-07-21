"use strict";

const crypto = require("node:crypto");
const database = require("../config/database");
const { validateAttestationToken } = require("./goodbase-growth.service");

function clean(value, maximum = 1000) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function secret(reference) {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(String(reference || ""))) return null;
  return process.env[reference] || null;
}
function httpsUrl(value, suffix = "") {
  const url = new URL(suffix, String(value || "").replace(/\/+$/, "") + "/");
  if (url.protocol !== "https:") throw Object.assign(new Error("AI providers must use HTTPS."), { statusCode: 400 });
  return url;
}
function boundedJson(value, maximum = 131072) {
  const encoded = JSON.stringify(value ?? {});
  if (Buffer.byteLength(encoded) > maximum) throw Object.assign(new Error("AI request exceeds the allowed size."), { statusCode: 413 });
  return JSON.parse(encoded);
}
function render(template, values) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = key.split(".").reduce((current, part) => current && current[part], values);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  });
}
async function probeProvider(provider) {
  const credential = secret(provider.secret_ref);
  if (!credential) throw Object.assign(new Error("AI provider credential is not configured."), { code: "GOODBASE_AI_SECRET_MISSING" });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(httpsUrl(provider.base_url, "models"), { headers: { Accept: "application/json", Authorization: `Bearer ${credential}` }, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.data)) throw new Error(`AI provider health returned HTTP ${response.status}.`);
    const health = { verified: true, modelCount: payload.data.length, statusCode: response.status };
    await database.query(`UPDATE goodbase_ai_providers SET status='ready',last_health_at=NOW(),health_json=$2::jsonb,updated_at=NOW() WHERE id=$1`, [provider.id, JSON.stringify(health)]);
    return health;
  } catch (error) {
    await database.query(`UPDATE goodbase_ai_providers SET status='degraded',last_health_at=NOW(),health_json=$2::jsonb,updated_at=NOW() WHERE id=$1`, [provider.id, JSON.stringify({ verified: false, errorCode: error.code || error.name })]);
    throw error;
  } finally { clearTimeout(timeout); }
}
async function requirePolicy(scope, appId) {
  const result = await database.query(`SELECT * FROM goodbase_ai_policies WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND app_id=$4 AND status='active' ORDER BY updated_at DESC LIMIT 1`, [scope.organizationId, scope.projectId, scope.environmentId, appId]);
  if (!result.rows[0]) throw Object.assign(new Error("No active AI policy exists for this application."), { statusCode: 403, code: "GOODBASE_AI_POLICY_REQUIRED" });
  return result.rows[0];
}
async function requireModel(scope, alias, allowed) {
  if (allowed.length && !allowed.includes(alias)) throw Object.assign(new Error("The requested model is not allowed by policy."), { statusCode: 403 });
  const result = await database.query(`SELECT model.*,provider.base_url,provider.secret_ref,provider.provider_type FROM goodbase_ai_models model JOIN goodbase_ai_providers provider ON provider.id=model.provider_id WHERE model.organization_id=$1 AND model.project_id=$2 AND model.environment_id=$3 AND model.alias=$4 AND model.status='active' AND provider.status='ready' ORDER BY model.routing_weight DESC LIMIT 1`, [scope.organizationId, scope.projectId, scope.environmentId, alias]);
  if (!result.rows[0]) throw Object.assign(new Error("No verified provider is ready for the requested model."), { statusCode: 503, code: "GOODBASE_AI_PROVIDER_UNAVAILABLE" });
  return result.rows[0];
}
async function enforceQuota(scope, userId, policy) {
  const result = await database.query(`SELECT COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '1 minute')::int AS recent_requests,COALESCE(SUM(input_tokens+output_tokens) FILTER(WHERE created_at>=CURRENT_DATE),0)::bigint AS daily_tokens FROM goodbase_ai_runs WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND user_id=$4`, [scope.organizationId, scope.projectId, scope.environmentId, userId]);
  if (result.rows[0].recent_requests >= policy.requests_per_minute || Number(result.rows[0].daily_tokens) >= Number(policy.tokens_per_day)) {
    throw Object.assign(new Error("AI quota exceeded."), { statusCode: 429, code: "GOODBASE_AI_QUOTA_EXCEEDED" });
  }
}
async function generate({ scope, userId, attestationToken, idempotencyKey, body }) {
  const appId = clean(body.appId, 100); const modelAlias = clean(body.model, 120); const input = boundedJson(body.input, 65536);
  if (!appId || !modelAlias || !idempotencyKey) throw Object.assign(new Error("appId, model, and Idempotency-Key are required."), { statusCode: 400 });
  const duplicate = await database.query(`SELECT id,status,response_json,error_code,created_at,completed_at FROM goodbase_ai_runs WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND user_id=$4 AND idempotency_key=$5`, [scope.organizationId, scope.projectId, scope.environmentId, userId, idempotencyKey]);
  if (duplicate.rows[0]) return { duplicate: true, run: duplicate.rows[0] };
  const policy = await requirePolicy(scope, appId);
  if (policy.require_attestation) {
    if (!attestationToken) throw Object.assign(new Error("A valid app attestation token is required."), { statusCode: 401, code: "ATTESTATION_REQUIRED" });
    await validateAttestationToken(attestationToken, { appId });
  }
  await enforceQuota(scope, userId, policy);
  const model = await requireModel(scope, modelAlias, policy.allowed_model_aliases || []);
  if (model.provider_type !== "openai_compatible") throw Object.assign(new Error("The selected AI provider adapter is not active."), { statusCode: 503 });
  const requestedTools = Array.isArray(body.tools) ? body.tools.slice(0, 32) : [];
  const allowedTools = policy.allowed_tools || [];
  if (requestedTools.some((tool) => !allowedTools.includes(clean(tool?.function?.name, 100)))) throw Object.assign(new Error("AI request includes a tool that is not allowed by policy."), { statusCode: 403 });
  let template = null;
  if (body.promptTemplateId) {
    const found = await database.query(`SELECT * FROM goodbase_ai_prompt_templates WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4 AND status='active'`, [body.promptTemplateId, scope.organizationId, scope.projectId, scope.environmentId]);
    template = found.rows[0]; if (!template) throw Object.assign(new Error("Active prompt template not found."), { statusCode: 404 });
  }
  const messages = [];
  if (template?.system_template) messages.push({ role: "system", content: render(template.system_template, input) });
  messages.push({ role: "user", content: template ? render(template.user_template, input) : clean(body.prompt, 60000) });
  const blockedTerms = Array.isArray(policy.safety_json?.blockedTerms) ? policy.safety_json.blockedTerms.map((item) => clean(item, 100).toLowerCase()).filter(Boolean) : [];
  if (blockedTerms.some((term) => messages.some((message) => message.content.toLowerCase().includes(term)))) throw Object.assign(new Error("AI request was blocked by the configured safety policy."), { statusCode: 400, code: "GOODBASE_AI_SAFETY_BLOCKED" });
  const estimatedInputTokens = Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4);
  if (estimatedInputTokens > policy.max_input_tokens) throw Object.assign(new Error("AI input exceeds policy token limits."), { statusCode: 413 });
  const requestPayload = { model: model.provider_model, messages, max_tokens: Math.min(Number(body.maxOutputTokens) || policy.max_output_tokens, policy.max_output_tokens), temperature: Math.min(Math.max(Number(body.temperature) || 0, 0), 2), tools: requestedTools.length ? requestedTools : undefined };
  if (body.outputSchema && typeof body.outputSchema === "object") requestPayload.response_format = { type: "json_schema", json_schema: { name: "goodbase_response", strict: true, schema: boundedJson(body.outputSchema, 32768) } };
  const credential = secret(model.secret_ref);
  if (!credential) throw Object.assign(new Error("AI provider credential is missing."), { statusCode: 503, code: "GOODBASE_AI_SECRET_MISSING" });
  const run = await database.query(`INSERT INTO goodbase_ai_runs(organization_id,project_id,environment_id,app_id,user_id,conversation_id,policy_id,model_id,prompt_template_id,idempotency_key,status,input_hash,request_json,input_tokens,safety_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',$11,$12::jsonb,$13,$14::jsonb) RETURNING *`, [scope.organizationId, scope.projectId, scope.environmentId, appId, userId, body.conversationId || null, policy.id, model.id, template?.id || null, idempotencyKey, sha256(JSON.stringify({ messages, model: modelAlias })), JSON.stringify({ model: modelAlias, maxOutputTokens: requestPayload.max_tokens, hasTools: requestedTools.length > 0, structured: Boolean(body.outputSchema) }), estimatedInputTokens, JSON.stringify({ blockedTermsChecked: blockedTerms.length })]);
  const started = Date.now(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(httpsUrl(model.base_url, "chat/completions"), { method: "POST", signal: controller.signal, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${credential}`, "Idempotency-Key": idempotencyKey }, body: JSON.stringify(requestPayload) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("AI provider request failed."), { code: `PROVIDER_HTTP_${response.status}` });
    const safeResponse = { id: payload.id || null, model: modelAlias, choices: Array.isArray(payload.choices) ? payload.choices.slice(0, 8) : [], usage: payload.usage || {} };
    const inputTokens = Number(payload.usage?.prompt_tokens) || estimatedInputTokens; const outputTokens = Number(payload.usage?.completion_tokens) || 0;
    const completed = await database.query(`UPDATE goodbase_ai_runs SET status='succeeded',response_json=$2::jsonb,input_tokens=$3,output_tokens=$4,latency_ms=$5,cost_microunits=$6,completed_at=NOW() WHERE id=$1 RETURNING id,status,response_json,input_tokens,output_tokens,latency_ms,cost_microunits,completed_at`, [run.rows[0].id, JSON.stringify(safeResponse), inputTokens, outputTokens, Date.now() - started, Math.round((inputTokens * Number(model.input_cost_per_million || 0) + outputTokens * Number(model.output_cost_per_million || 0)))]);
    return { duplicate: false, run: completed.rows[0] };
  } catch (error) {
    await database.query(`UPDATE goodbase_ai_runs SET status='failed',error_code=$2,latency_ms=$3,completed_at=NOW() WHERE id=$1`, [run.rows[0].id, clean(error.code || error.name, 120), Date.now() - started]);
    throw error;
  } finally { clearTimeout(timeout); }
}

module.exports = { boundedJson, generate, probeProvider, sha256 };
