"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const product = require("../src/services/goodbase-product.service");

test("product metadata scrubber removes credentials recursively", () => {
  const output = product.boundedJson({ safe: "yes", password: "no", nested: { authorization: "no", value: 3 } });
  assert.deepEqual(output, { safe: "yes", nested: { value: 3 } });
});

test("experiment subject hashes are stable and app-scoped", () => {
  const first = product.subjectHash({ appId: "app_one", userId: "user_one" });
  assert.equal(first, product.subjectHash({ appId: "app_one", userId: "user_one" }));
  assert.notEqual(first, product.subjectHash({ appId: "app_two", userId: "user_one" }));
});

test("phase migration enforces tenant isolation and avoids schema-wide grants", () => {
  const sql = fs.readFileSync(path.join(root, "migrations/20260721_goodbase_phases31_38.sql"), "utf8");
  for (let phase = 31; phase <= 38; phase += 1) assert.match(sql, new RegExp(`Phase ${phase}:`));
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /goodbase_tenant_isolation/);
  assert.doesNotMatch(sql, /GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES/);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'misconfigured'/);
});

test("product APIs are mounted and privileged paths enforce MFA", () => {
  const routes = fs.readFileSync(path.join(root, "src/routes/goodbase-product.routes.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "src/routes/index.js"), "utf8");
  assert.match(index, /goodbaseProductRoutes\.publicRouter/);
  assert.match(index, /goodbaseProductRoutes\.authenticatedRouter/);
  assert.match(routes, /dataPlaneAdminRequired/);
  assert.match(routes, /GOODBASE_PRIVILEGED_MFA_REQUIRED/);
  assert.match(routes, /status='misconfigured' until signed verification|signed verification succeeds/);
});

test("the scheduler runs the oldest due work before using priority as a tie breaker", () => {
  const jobs = fs.readFileSync(path.join(root, "src/services/job.service.js"), "utf8");
  assert.match(jobs, /ORDER BY next_run_at ASC, priority ASC/);
  assert.doesNotMatch(jobs, /ORDER BY priority ASC, next_run_at ASC/);
});

test("SDKs expose product telemetry and configuration calls", () => {
  for (const file of ["src/public/sdk/goodos.js", "sdk/goodos.js", "sdks/dart/lib/goodbase.dart", "sdks/kotlin/src/main/kotlin/app/goodos/goodbase/GoodbaseClient.kt", "sdks/swift/Sources/Goodbase/GoodbaseClient.swift"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /analytics\/events|track\(/, file);
    assert.match(source, /telemetry\/crashes|captureCrash/, file);
    assert.match(source, /product\/config|remoteConfig/, file);
  }
});
