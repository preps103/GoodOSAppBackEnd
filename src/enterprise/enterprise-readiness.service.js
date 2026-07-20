"use strict";

const fs = require("fs");
const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");

function defaultQuery(...parameters) {
  return require("../config/database").query(...parameters);
}

const CONTROL_DEFINITIONS = Object.freeze([
  {
    id: "quality-release-gates",
    step: 1,
    title: "Automated testing and release gates",
    objective: "Every release is syntax checked, contract checked, tested, and recoverable.",
    files: [
      ".github/workflows/ci.yml",
      "scripts/validate-openapi.js",
      "scripts/enterprise-readiness.js",
      "test/enterprise-readiness.test.js",
      "scripts/release-gate.js",
    ],
    tables: ["backend_release_policies", "backend_releases", "backend_migration_ledger"],
  },
  {
    id: "api-architecture",
    step: 2,
    title: "API architecture",
    objective: "Versioned APIs have a machine-readable contract and stable developer assets.",
    files: [
      "docs/openapi.json",
      "src/public/developer/openapi.json",
      "src/routes/public-api.routes.js",
      "src/routes/api-gateway-v2-public.routes.js",
    ],
    tables: ["backend_api_gateway_policies", "backend_table_api_rules"],
  },
  {
    id: "identity-security",
    step: 3,
    title: "Enterprise identity and security",
    objective: "SSO, SCIM, MFA, sessions, permissions, and secrets follow least privilege.",
    files: [
      "src/routes/oidc.routes.js",
      "src/routes/scim.routes.js",
      "src/routes/identity-governance.routes.js",
      "src/middleware/phase2-security.js",
      "src/services/secret.service.js",
    ],
    tables: [
      "backend_identity_providers",
      "backend_scim_tokens",
      "backend_mfa_factors",
      "backend_permissions",
      "backend_secret_vaults",
    ],
  },
  {
    id: "reliability-scaling",
    step: 4,
    title: "Reliability and scaling",
    objective: "Health checks, workers, retries, locks, and deployment controls support safe scaling.",
    files: [
      "src/routes/health.routes.js",
      "src/workers/goodapp-worker-v3.js",
      "src/services/job.service.js",
      "src/routes/release-governance.routes.js",
    ],
    tables: [
      "backend_jobs",
      "backend_job_runs",
      "backend_queue_items",
      "backend_worker_heartbeats",
      "backend_worker_locks",
    ],
  },
  {
    id: "data-governance",
    step: 5,
    title: "Database and data governance",
    objective: "Tenant boundaries, retention, privacy requests, and environment controls are enforceable.",
    files: [
      "src/middleware/tenantContext.js",
      "src/routes/privacy-governance.routes.js",
      "src/routes/environment-governance.routes.js",
      "scripts/privacy-retention.js",
    ],
    tables: [
      "backend_organizations",
      "backend_projects",
      "backend_project_environments",
      "backend_data_governance_policies",
      "backend_data_subject_requests",
    ],
  },
  {
    id: "observability-operations",
    step: 6,
    title: "Observability and operations",
    objective: "Structured logs, metrics, dependency checks, SLOs, incidents, and alerts are live.",
    files: [
      "src/middleware/enterprise-observability.js",
      "src/enterprise/enterprise-foundation.service.js",
      "src/routes/operations.routes.js",
      "scripts/operations-check.js",
    ],
    tables: [
      "backend_metric_buckets",
      "backend_dependency_checks",
      "backend_slo_definitions",
      "backend_operational_events",
      "backend_incidents",
    ],
  },
  {
    id: "backup-disaster-recovery",
    step: 7,
    title: "Backups and disaster recovery",
    objective: "Backups are inventoried, checksummed, retained, and proven through restore verification.",
    files: [
      "scripts/create-db-backup.sh",
      "scripts/verify-db-restore.sh",
      "scripts/cleanup-db-backups.sh",
      "docs/enterprise-operations.md",
    ],
    tables: ["backend_backup_inventory", "backend_restore_verifications"],
  },
  {
    id: "billing-usage",
    step: 8,
    title: "Billing and usage",
    objective: "Metering, quotas, subscriptions, invoices, and plan entitlements are auditable.",
    files: ["src/routes/billing.routes.js", "src/services/billing.service.js", "src/services/usage.service.js"],
    tables: [
      "backend_meter_events",
      "backend_quota_counters",
      "backend_subscriptions",
      "backend_invoices",
      "backend_usage_daily",
    ],
  },
  {
    id: "compliance-controls",
    step: 9,
    title: "Compliance and enterprise controls",
    objective: "Audit evidence, approvals, retention, and privileged changes are reviewable.",
    files: [
      "src/services/audit.service.js",
      "src/routes/release-governance.routes.js",
      "src/routes/privacy-governance.routes.js",
      "docs/enterprise-operations.md",
    ],
    tables: [
      "audit_logs",
      "backend_auth_audit_events",
      "backend_change_requests",
      "backend_consent_records",
      "backend_legal_holds",
    ],
  },
]);

function unique(values) {
  return [...new Set(values)];
}

async function loadTableCoverage(queryFn, tableNames) {
  if (!tableNames.length) return new Map();

  const result = await queryFn(
    `
      SELECT
        requested.table_name AS "tableName",
        TO_REGCLASS('public.' || requested.table_name) IS NOT NULL AS present
      FROM UNNEST($1::text[]) AS requested(table_name)
      ORDER BY requested.table_name
    `,
    [tableNames]
  );

  return new Map(result.rows.map((row) => [row.tableName, Boolean(row.present)]));
}

function assessDefinition(definition, tableCoverage, repositoryRoot) {
  const fileEvidence = definition.files.map((relativePath) => ({
    name: relativePath,
    type: "file",
    present: fs.existsSync(path.resolve(repositoryRoot, relativePath)),
  }));

  const tableEvidence = definition.tables.map((tableName) => ({
    name: tableName,
    type: "table",
    present: tableCoverage.get(tableName) === true,
  }));

  const evidence = [...fileEvidence, ...tableEvidence];
  const present = evidence.filter((item) => item.present).length;
  const total = evidence.length;
  const score = total ? Math.round((present / total) * 100) : 100;

  return {
    id: definition.id,
    step: definition.step,
    title: definition.title,
    objective: definition.objective,
    status: score === 100 ? "ready" : score >= 60 ? "partial" : "needs_attention",
    score,
    evidence,
  };
}

async function assessEnterpriseReadiness({
  queryFn = defaultQuery,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const tableNames = unique(CONTROL_DEFINITIONS.flatMap((control) => control.tables));
  const tableCoverage = await loadTableCoverage(queryFn, tableNames);
  const controls = CONTROL_DEFINITIONS.map((definition) =>
    assessDefinition(definition, tableCoverage, repositoryRoot)
  );
  const score = Math.round(
    controls.reduce((sum, control) => sum + control.score, 0) / controls.length
  );

  return {
    status: controls.every((control) => control.status === "ready")
      ? "ready"
      : controls.some((control) => control.status === "needs_attention")
        ? "needs_attention"
        : "partial",
    score,
    checkedAt: new Date().toISOString(),
    counts: {
      total: controls.length,
      ready: controls.filter((control) => control.status === "ready").length,
      partial: controls.filter((control) => control.status === "partial").length,
      needsAttention: controls.filter((control) => control.status === "needs_attention").length,
    },
    controls,
  };
}

module.exports = {
  CONTROL_DEFINITIONS,
  assessDefinition,
  assessEnterpriseReadiness,
  loadTableCoverage,
};
