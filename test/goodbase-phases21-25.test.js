"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("migrations/20260721_goodbase_phases21_25.sql");
const routes = read("src/routes/goodbase-production.routes.js");
const service = read("src/services/goodbase-production.service.js");
const jobs = read("src/services/job.service.js");
const sdk = read("src/public/sdk/goodos.js");
const offline = read("src/public/sdk/goodbase-offline.js");
const cli = read("bin/goodbase.js");
const appSource = read("src/app.js");

test("Phase 21 records commit-bound production checks and daily release evidence", () => {
  assert.match(migration, /goodbase_verification_runs/);
  assert.match(migration, /goodbase_verification_checks/);
  assert.match(service, /git_commit/);
  assert.match(service, /transaction-pool/);
  assert.match(service, /session-pool/);
  assert.match(service, /production-auth-boundary/);
  assert.match(jobs, /goodbase\.production\.verify/);
  assert.match(read("src/public/console.html"), /<title>Goodbase Console<\/title>/);
  assert.doesNotMatch(read("src/public/console.html"), /GoodOS Cloud/);
  assert.match(appSource, /rel=\"canonical\"/);
  assert.ok(appSource.indexOf('rel="canonical"') < appSource.indexOf('app.get("/console"'), "canonical middleware must run before public console routes");
});

test("Phase 22 executes encrypted off-site backups and isolated restore verification", () => {
  for (const table of ["goodbase_recovery_policies_v2","goodbase_backup_artifacts_v2","goodbase_restore_exercises_v2","goodbase_replication_targets_v2"]) {
    assert.match(migration, new RegExp(table));
  }
  const backup = read("scripts/goodbase-backup.sh");
  const restore = read("scripts/goodbase-restore-verify.sh");
  assert.match(backup, /pg_dump/);
  assert.match(backup, /aes-256-cbc/);
  assert.match(backup, /GOODBASE_BACKUP_SECONDARY_REMOTE/);
  assert.match(restore, /pg_restore --exit-on-error/);
  assert.match(restore, /pg_policies/);
  assert.match(read("deploy/systemd/goodbase-backup.timer"), /OnCalendar=/);
});

test("Phase 23 publishes governed official SDK foundations for all required platforms", () => {
  const manifest = JSON.parse(read("sdks/manifest.json"));
  assert.deepEqual(Object.keys(manifest.official).sort(), ["csharp","dart","javascript","kotlin","nextjs","node","python","react","swift"]);
  for (const file of Object.values(manifest.official)) assert.equal(fs.existsSync(path.join(root,file)), true, file);
  assert.match(migration, /goodbase_sdk_releases/);
  assert.match(migration, /goodbase_sdk_compatibility_runs/);
  assert.match(routes, /\/sdks\/releases/);
});

test("Phase 24 provides durable offline mutations, conflicts, cursors, and replay", () => {
  for (const table of ["goodbase_sync_collections","goodbase_sync_records","goodbase_sync_mutations","goodbase_sync_events","goodbase_sync_cursors"]) {
    assert.match(migration, new RegExp(table));
  }
  assert.match(routes, /FOR UPDATE/);
  assert.match(routes, /idempotencyKey/);
  assert.match(routes, /conflict_policy/);
  assert.match(routes, /sequence_id/);
  assert.match(offline, /indexedDB/);
  assert.match(offline, /syncChanges/);
  assert.match(sdk, /syncMutations/);
});

test("Phase 25 requires verified HTTPS controllers and signed idempotent operations", () => {
  assert.match(migration, /goodbase_controller_registrations/);
  assert.match(migration, /goodbase_controller_operations/);
  assert.match(routes, /Controllers must use HTTPS/);
  assert.match(service, /createHmac\("sha256"/);
  assert.match(service, /Idempotency-Key/);
  assert.match(routes, /status='ready'/);
  assert.match(jobs, /goodbase\.controllers\.dispatch/);
});

test("Phases 21-25 are tenant isolated, mounted, documented, and exposed through SDK and CLI", () => {
  assert.match(migration, /CREATE POLICY goodbase_tenant_isolation/);
  assert.match(migration, /CREATE POLICY goodbase_backend_service/);
  assert.match(read("src/routes/index.js"), /\/api\/goodbase\/v1\/production/);
  assert.match(read("src/public/developer/openapi.json"), /\/api\/goodbase\/v1\/production\/overview/);
  for (const method of ["productionOverview","runProductionVerification","recoveryStatus","officialSdkReleases","syncCollections","productionControllers"]) assert.match(sdk,new RegExp(method));
  assert.match(cli,/production status\|verify/);
  assert.match(cli,/recovery status\|backup\|restore/);
});
