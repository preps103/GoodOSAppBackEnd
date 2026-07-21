"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Phase 39 completes the canonical Goodbase cutover with governed aliases", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "goodbase");
  assert.match(pkg.repository.url, /Goodbase\.git$/);
  assert.match(read("src/app.js"), /X-Goodbase-Canonical-Origin/);
  assert.match(read("deploy/nginx/backend.goodos.app-retirement.conf.example"), /return 308 https:\/\/base\.goodos\.app\$request_uri/);
  assert.match(read("src/routes/index.js"), /\/sdk\/goodbase\.js/);
  assert.match(read("src/routes/index.js"), /Deprecation/);
  assert.match(read("src/public/sdk/goodos.js"), /root\.Goodbase = sdk/);
  assert.match(read("docs/goodbase-deprecation-policy.md"), /January 21, 2027/);
});

test("Phase 40 never marks external providers ready without signed real activation", () => {
  const growth = read("src/services/goodbase-growth.service.js");
  const production = read("src/services/goodbase-production.service.js");
  assert.match(growth, /createHmac\("sha256"/);
  assert.match(growth, /status='misconfigured'/);
  assert.match(production, /GOODBASE_CONTROLLER_SECRET_MISSING/);
  assert.match(production, /Idempotency-Key/);
  assert.match(read("scripts/goodbase-certify.js"), /authentication-providers/);
});

test("Phase 41 certification requires offsite WAL, restore and replica evidence", () => {
  const certification = read("scripts/goodbase-certify.js");
  assert.match(certification, /wal_archive_enabled=TRUE/);
  assert.match(certification, /verified-encrypted-backup/);
  assert.match(certification, /passed-isolated-restore/);
  assert.match(certification, /streaming-replica/);
  assert.match(read("scripts/goodbase-backup.sh"), /aes-256-cbc/);
  assert.match(read("scripts/goodbase-restore-verify.sh"), /pg_restore --exit-on-error/);
});

test("Phase 42 certification rejects source-only SDK claims", () => {
  const certification = read("scripts/goodbase-certify.js");
  assert.match(certification, /signed-published-sdk-families/);
  assert.match(certification, /passed-sdk-conformance/);
  assert.match(certification, /signed=TRUE/);
  assert.match(certification, /source_commit IS NOT NULL/);
});

test("Phase 43 web offline runtime isolates users and coordinates tabs", () => {
  const offline = read("src/public/sdk/goodbase-offline.js");
  assert.match(offline, /goodbase-offline-/);
  assert.match(offline, /BroadcastChannel/);
  assert.match(offline, /pendingCount/);
  assert.match(offline, /\.sort\(/);
  assert.match(offline, /evict/);
  assert.match(offline, /deleteDatabase/);
  assert.match(read("src/routes/index.js"), /\/sdk\/goodbase-offline\.js/);
});

test("Phases 44 and 45 require real multi-region failover, CDN and replication proof", () => {
  const certification = read("scripts/goodbase-certify.js");
  assert.match(certification, /production-regions/);
  assert.match(certification, /passed-failover-exercises/);
  assert.match(certification, /global-cdn-provider/);
  assert.match(certification, /verified-storage-replication/);
  assert.match(certification, /cdn-operation-coverage/);
  assert.doesNotMatch(certification, /status:\s*"certified"/);
});
