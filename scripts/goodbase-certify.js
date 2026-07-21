#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");

const root = path.resolve(__dirname, "..");
const commit = process.env.GOODBASE_RELEASE_COMMIT || process.env.GITHUB_SHA || "unknown";
const canonicalOrigin = process.env.GOODBASE_CANONICAL_ORIGIN || "https://base.goodos.app";
const legacyOrigin = process.env.GOODBASE_LEGACY_ORIGIN || "https://backend.goodos.app";
const reportOnly = process.argv.includes("--report-only");

async function http(name, url, accepted, inspect = () => true) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    const passed = accepted.includes(response.status) && inspect(response);
    return { name, passed, statusCode: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { name, passed: false, statusCode: null, latencyMs: Date.now() - started, errorCode: error.cause?.code || error.name };
  }
}

async function count(sql, parameters = []) {
  const result = await database.query(sql, parameters);
  return Number(result.rows[0]?.count || 0);
}

function phase(number, name, checks) {
  const passed = checks.every((check) => check.passed);
  return { phase: number, name, status: passed ? "certified" : "blocked", checks };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "sdks/manifest.json"), "utf8"));
  const sdkFiles = Object.values(manifest.official).map((file) => ({
    name: `sdk-source:${file}`,
    passed: fs.existsSync(path.join(root, file))
  }));

  const [baseReady, canonicalHeader, legacyRedirect, canonicalSdk, legacySdk] = await Promise.all([
    http("canonical-readiness", `${canonicalOrigin}/api/health/ready`, [200]),
    http("canonical-response-header", `${canonicalOrigin}/api/health/live`, [200], (response) => response.headers.get("x-goodbase-canonical-origin") === canonicalOrigin),
    http("legacy-308", `${legacyOrigin}/api/health/ready`, [308], (response) => response.headers.get("location") === `${canonicalOrigin}/api/health/ready`),
    http("canonical-sdk", `${canonicalOrigin}/sdk/goodbase.js`, [200]),
    http("legacy-sdk-deprecation", `${canonicalOrigin}/sdk/goodos.js`, [200], (response) => response.headers.get("deprecation") === "true" && Boolean(response.headers.get("sunset")))
  ]);

  const values = {
    readyControllers: await count("SELECT COUNT(*) FROM goodbase_controller_registrations WHERE status='ready'"),
    enabledAuthProviders: await count("SELECT COUNT(*) FROM goodbase_consumer_auth_providers WHERE status='enabled'"),
    readyMessagingProviders: await count("SELECT COUNT(*) FROM goodbase_messaging_providers WHERE status='ready'"),
    enforcedAttestationProviders: await count("SELECT COUNT(DISTINCT provider) FROM goodbase_attestation_policies WHERE mode='enforce'"),
    activeRecoveryPolicies: await count("SELECT COUNT(*) FROM goodbase_recovery_policies_v2 WHERE status='active' AND wal_archive_enabled=TRUE AND offsite_provider IS NOT NULL AND secondary_provider IS NOT NULL"),
    verifiedBackups: await count("SELECT COUNT(*) FROM goodbase_backup_artifacts_v2 WHERE status='verified'"),
    passedRestores: await count("SELECT COUNT(*) FROM goodbase_restore_exercises_v2 WHERE status='passed'"),
    streamingReplicas: await count("SELECT COUNT(DISTINCT region_id) FROM goodbase_replication_targets_v2 WHERE status IN('streaming','promoted')"),
    activeSdkFamilies: await count("SELECT COUNT(DISTINCT language) FROM goodbase_sdk_releases WHERE status='active' AND signed=TRUE AND checksum_sha256 IS NOT NULL AND source_commit IS NOT NULL"),
    passedSdkConformance: await count("SELECT COUNT(DISTINCT release_id) FROM goodbase_sdk_compatibility_runs WHERE status='passed'"),
    activeSyncCollections: await count("SELECT COUNT(*) FROM goodbase_sync_collections WHERE status='active'"),
    passedOfflineClients: await count("SELECT COUNT(DISTINCT release_id) FROM goodbase_sdk_compatibility_runs WHERE status='passed' AND COALESCE(results_json->>'offlineScenario','')='passed'"),
    readyRegions: await count("SELECT COUNT(DISTINCT region_id) FROM goodbase_regional_deployments WHERE status='ready' AND ready_instances>=min_instances"),
    readyRegionalServices: await count("SELECT COUNT(DISTINCT service_type) FROM goodbase_regional_deployments WHERE status='ready' AND ready_instances>=min_instances"),
    passedFailoverExercises: await count("SELECT COUNT(DISTINCT event_type) FROM goodbase_failover_events WHERE status='completed'"),
    readyCdnProviders: await count("SELECT COUNT(*) FROM goodbase_cdn_providers WHERE status='ready' AND cardinality(regions)>1"),
    readyStorageReplications: await count("SELECT COUNT(*) FROM goodbase_storage_replications WHERE status='ready' AND last_verified_at IS NOT NULL"),
    completedCdnOperations: await count("SELECT COUNT(DISTINCT operation_type) FROM goodbase_cdn_operations WHERE status='completed'")
  };

  const phases = [
    phase(39, "canonical production cutover", [baseReady, canonicalHeader, legacyRedirect, canonicalSdk, legacySdk]),
    phase(40, "external providers and controllers", [
      { name: "controllers", passed: values.readyControllers >= 8, observed: values.readyControllers, required: 8 },
      { name: "authentication-providers", passed: values.enabledAuthProviders >= 10, observed: values.enabledAuthProviders, required: 10 },
      { name: "messaging-providers", passed: values.readyMessagingProviders >= 3, observed: values.readyMessagingProviders, required: 3 },
      { name: "attestation-providers", passed: values.enforcedAttestationProviders >= 4, observed: values.enforcedAttestationProviders, required: 4 }
    ]),
    phase(41, "backup PITR and disaster recovery", [
      { name: "dual-offsite-wal-policy", passed: values.activeRecoveryPolicies > 0, observed: values.activeRecoveryPolicies, required: 1 },
      { name: "verified-encrypted-backup", passed: values.verifiedBackups > 0, observed: values.verifiedBackups, required: 1 },
      { name: "passed-isolated-restore", passed: values.passedRestores > 0, observed: values.passedRestores, required: 1 },
      { name: "streaming-replica", passed: values.streamingReplicas > 0, observed: values.streamingReplicas, required: 1 }
    ]),
    phase(42, "official SDK ecosystem", [
      ...sdkFiles,
      { name: "signed-published-sdk-families", passed: values.activeSdkFamilies >= 9, observed: values.activeSdkFamilies, required: 9 },
      { name: "passed-sdk-conformance", passed: values.passedSdkConformance >= 9, observed: values.passedSdkConformance, required: 9 }
    ]),
    phase(43, "offline synchronization clients", [
      { name: "active-sync-collection", passed: values.activeSyncCollections > 0, observed: values.activeSyncCollections, required: 1 },
      { name: "passed-real-client-scenarios", passed: values.passedOfflineClients >= 3, observed: values.passedOfflineClients, required: 3 },
      { name: "web-offline-runtime", passed: fs.existsSync(path.join(root, "src/public/sdk/goodbase-offline.js")) }
    ]),
    phase(44, "multi-region production", [
      { name: "production-regions", passed: values.readyRegions >= 2, observed: values.readyRegions, required: 2 },
      { name: "regional-service-families", passed: values.readyRegionalServices >= 5, observed: values.readyRegionalServices, required: 5 },
      { name: "passed-failover-exercises", passed: values.passedFailoverExercises >= 3, observed: values.passedFailoverExercises, required: 3 }
    ]),
    phase(45, "CDN and storage replication", [
      { name: "global-cdn-provider", passed: values.readyCdnProviders > 0, observed: values.readyCdnProviders, required: 1 },
      { name: "verified-storage-replication", passed: values.readyStorageReplications > 0, observed: values.readyStorageReplications, required: 1 },
      { name: "cdn-operation-coverage", passed: values.completedCdnOperations >= 7, observed: values.completedCdnOperations, required: 7 }
    ])
  ];

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseCommit: commit,
    canonicalOrigin,
    status: phases.every((item) => item.status === "certified") ? "certified" : "blocked",
    phases
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!reportOnly && report.status !== "certified") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "error", code: error.code || error.name, message: error.message })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await database.pool?.end?.().catch(() => {});
});
