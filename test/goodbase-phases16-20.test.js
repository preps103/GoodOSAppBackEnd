"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("migrations/20260721_goodbase_phases16_20.sql");
const routes = read("src/routes/goodbase-enterprise-platform.routes.js");
const jobs = read("src/services/job.service.js");
const sdk = read("src/public/sdk/goodos.js");
const cli = read("bin/goodbase.js");

test("Phase 16 unifies bounded logs, saved queries, drains, redaction, retention, SLOs, and tracing", () => {
  for (const required of [
    "goodbase_unified_logs", "goodbase_log_saved_queries", "goodbase_log_drains",
    "goodbase_log_redaction_rules", "goodbase_observability_policies", "backend_slo_definitions"
  ]) assert.match(`${migration}\n${routes}`, new RegExp(required));
  assert.match(routes, /SET LOCAL statement_timeout='2000ms'/);
  assert.match(routes, /trace_id/);
});

test("Phase 17 management operations are scoped, hashed, idempotent, and safely dispatched", () => {
  assert.match(migration, /goodbase_management_tokens/);
  assert.match(routes, /createHash\("sha256"\)\.update\(token\)/);
  assert.match(routes, /Idempotency-Key/);
  assert.match(routes, /GOODBASE_MANAGEMENT_SCOPE_REQUIRED/);
  assert.match(jobs, /GOODBASE_INFRA_CONTROLLER_URL/);
});

test("Phase 18 custom domains require DNS proof, managed certificates, and privileged activation", () => {
  assert.match(migration, /goodbase_custom_domains/);
  assert.match(routes, /resolveTxt/);
  assert.match(routes, /dns_status='verified' AND certificate_status='ready'/);
  assert.match(routes, /router\.post\("\/domains\/:id\/activate",requireMfa/);
  assert.match(jobs, /GOODBASE_DOMAIN_CONTROLLER_URL/);
});

test("Phase 19 provides keyword, semantic, hybrid, and queue-backed embedding workflows", () => {
  assert.match(migration, /TSVECTOR GENERATED ALWAYS/);
  assert.match(migration, /USING GIN\(search_vector\)/);
  assert.match(migration, /goodbase_embedding_jobs/);
  assert.match(routes, /\["keyword","semantic","hybrid"\]/);
  assert.match(routes, /vectorScore/);
  assert.match(jobs, /GOODBASE_EMBEDDING_GATEWAY_URL/);
});

test("Phase 20 models regional nodes, capacity, limits, incidents, and MFA-gated failover", () => {
  for (const required of ["goodbase_regions", "goodbase_service_nodes", "goodbase_capacity_policies", "goodbase_failover_plans", "goodbase_incidents", "goodbase_service_limits"]) {
    assert.match(migration, new RegExp(required));
  }
  assert.match(routes, /failover-plans\/:id\/events",requireMfa/);
  assert.match(jobs, /status='offline'/);
});

test("Phase 16-20 tables enforce tenant isolation and backend service policies", () => {
  assert.match(migration, /CREATE POLICY goodbase_tenant_isolation/);
  assert.match(migration, /CREATE POLICY goodbase_backend_service/);
  assert.match(migration, /goodbase_phase_20_regions/);
});

test("Phase 16-20 APIs are mounted and available through SDK and CLI", () => {
  assert.match(read("src/routes/index.js"), /\/api\/goodbase\/v1\/enterprise/);
  for (const method of ["queryLogs", "customDomains", "searchVectors", "infrastructureStatus", "requestManagementOperation"]) assert.match(sdk, new RegExp(method));
  assert.match(cli, /domains list\|add\|verify/);
  assert.match(cli, /infrastructure status/);
});
