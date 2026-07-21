#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const database = require("../src/config/database");
const { preserveEvidence, validCommit } = require("./lib/goodbase-evidence");

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

async function evidenceCount(type) {
  return count("SELECT COUNT(*) FROM goodbase_release_evidence WHERE evidence_type=$1 AND release_commit=$2 AND status='passed'", [type, commit]);
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
    readyControllers: await count("SELECT COUNT(DISTINCT controller_type) FROM goodbase_controller_registrations WHERE status='ready'"),
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
    completedCdnOperations: await count("SELECT COUNT(DISTINCT operation_type) FROM goodbase_cdn_operations WHERE status='completed'"),
    readyDistributionProviders: await count("SELECT COUNT(DISTINCT provider_type) FROM goodbase_distribution_providers WHERE status='ready' AND last_health_at IS NOT NULL"),
    passedDeviceProviders: await count("SELECT COUNT(DISTINCT provider_id) FROM goodbase_device_test_runs WHERE status='passed' AND cardinality(artifacts_json)>0"),
    productionTelemetryFamilies: await count("SELECT ((CASE WHEN EXISTS(SELECT 1 FROM goodbase_analytics_events WHERE received_at>NOW()-INTERVAL '24 hours') THEN 1 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM goodbase_crash_occurrences WHERE received_at>NOW()-INTERVAL '24 hours') THEN 1 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM goodbase_performance_traces WHERE received_at>NOW()-INTERVAL '24 hours') THEN 1 ELSE 0 END))::int AS count"),
    completedSymbolication: await count("SELECT COUNT(*) FROM goodbase_symbolication_jobs WHERE status='completed'"),
    readyHostingProjects: await count("SELECT COUNT(*) FROM goodbase_hosting_projects WHERE status='ready' AND controller_id IS NOT NULL"),
    readyHostingReleases: await count("SELECT COUNT(*) FROM goodbase_hosting_releases WHERE status='ready' AND artifact_checksum IS NOT NULL"),
    readyCommercialProviders: await count("SELECT COUNT(DISTINCT provider_type) FROM goodbase_commercial_providers WHERE status='ready' AND last_health_at IS NOT NULL"),
    verifiedComplianceFamilies: await count("SELECT COUNT(DISTINCT control_family) FROM goodbase_compliance_evidence WHERE status='verified' AND (expires_at IS NULL OR expires_at>NOW())"),
    securityEvidence: await evidenceCount("security"), loadEvidence: await evidenceCount("load"), chaosEvidence: await evidenceCount("chaos"), ciEvidence: await evidenceCount("ci")
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

  const requirements = [
    phase(1,"deployed and certified release",[...phases[0].checks,{name:"security-gate-evidence",passed:values.securityEvidence>0,observed:values.securityEvidence,required:1},{name:"load-test-evidence",passed:values.loadEvidence>0,observed:values.loadEvidence,required:1},{name:"non-production-chaos-evidence",passed:values.chaosEvidence>0,observed:values.chaosEvidence,required:1}]),
    phase(2,"real production controllers",[{name:"ready-controller-families",passed:values.readyControllers>=10,observed:values.readyControllers,required:10}]),
    phase(3,"backup restore PITR and failover proof",phases[2].checks),
    phase(4,"published official SDKs",phases[3].checks),
    phase(5,"real offline-client validation",phases[4].checks),
    phase(6,"second production region",phases[5].checks),
    phase(7,"CDN and image delivery",phases[6].checks),
    phase(8,"distribution and real-device providers",[{name:"ready-distribution-provider-families",passed:values.readyDistributionProviders>=4,observed:values.readyDistributionProviders,required:4},{name:"device-providers-with-artifacts",passed:values.passedDeviceProviders>=2,observed:values.passedDeviceProviders,required:2}]),
    phase(9,"crash symbolication and performance collection",[{name:"live-telemetry-families",passed:values.productionTelemetryFamilies>=3,observed:values.productionTelemetryFamilies,required:3},{name:"completed-symbolication",passed:values.completedSymbolication>0,observed:values.completedSymbolication,required:1}]),
    phase(10,"generalized application hosting",[{name:"ready-hosting-project",passed:values.readyHostingProjects>0,observed:values.readyHostingProjects,required:1},{name:"verified-hosting-release",passed:values.readyHostingReleases>0,observed:values.readyHostingReleases,required:1}]),
    phase(11,"externally visible CI and release assurance",[{name:"commit-bound-ci-evidence",passed:values.ciEvidence>0,observed:values.ciEvidence,required:1}]),
    phase(12,"commercial and compliance proof",[{name:"commercial-provider-families",passed:values.readyCommercialProviders>=4,observed:values.readyCommercialProviders,required:4},{name:"verified-compliance-families",passed:values.verifiedComplianceFamilies>=8,observed:values.verifiedComplianceFamilies,required:8}])
  ];

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseCommit: commit,
    canonicalOrigin,
    status: requirements.every((item) => item.status === "certified") ? "certified" : "blocked",
    phases,
    requirements
  };
  if (validCommit(commit)) report.evidence = await preserveEvidence({type:"certification",commit,status:report.status==="certified"?"passed":"blocked",report,database});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!reportOnly && report.status !== "certified") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "error", code: error.code || error.name, message: error.message })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await database.pool?.end?.().catch(() => {});
});
