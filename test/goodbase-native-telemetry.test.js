"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname,"..");
const read = file => fs.readFileSync(path.join(root,file),"utf8");
const symbols = require("../src/services/goodbase-symbolication.service");

test("native symbols validate supported production formats",()=>{
  assert.deepEqual([...symbols.symbolTypes],["sourcemap","dsym","proguard","ndk","flutter","unity"]);
  const mapping="com.example.CrashActivity -> a.b:\n    void crash() -> a\n";
  const validated=symbols.validateSymbol("proguard",Buffer.from(mapping));
  assert.equal(validated.tool,"goodbase-retrace");
  const retraced=symbols.retraceProguard("at a.b.a(CrashActivity.java:12)",mapping);
  assert.equal(retraced.symbolicated,true);
  assert.match(retraced.stack,/com\.example\.CrashActivity\.a/);
  assert.throws(()=>symbols.validateSymbol("unknown",Buffer.from("invalid")),/Unsupported symbol type/);
});

test("Breakpad and Flutter text symbols resolve native addresses",()=>{
  const result=symbols.textSymbolicate("frame 0x00100a", "FUNC 001000 20 0 goodbase_crash\n");
  assert.equal(result.symbolicated,true);
  assert.match(result.stack,/goodbase_crash\+0xa/);
});

test("native telemetry migration enforces tenancy, retention, privacy, and issue intelligence",()=>{
  const migration=read("migrations/20260722_goodbase_native_telemetry.sql");
  for(const type of ["sourcemap","dsym","proguard","ndk","flutter","unity"])assert.match(migration,new RegExp(`'${type}'`));
  for(const table of ["goodbase_crash_issue_variants","goodbase_telemetry_retention_policies","goodbase_telemetry_privacy_requests","goodbase_telemetry_retention_runs","goodbase_telemetry_alert_events"])assert.match(migration,new RegExp(table));
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/goodbase_tenant_isolation/);
  assert.match(migration,/immutable_security_days/);
});

test("release, lifecycle, stability and symbol routes are contracted",()=>{
  const experience=read("src/routes/goodbase-experience.routes.js");
  const product=read("src/routes/goodbase-product.routes.js");
  const contract=JSON.parse(read("docs/openapi.json"));
  assert.match(experience,/telemetry\/releases/);
  assert.match(experience,/symbolUpload\.fields/);
  assert.match(experience,/mfaRequired/);
  assert.match(product,/telemetry\/sessions/);
  assert.match(product,/telemetry\/stability/);
  assert.match(product,/telemetry\/privacy\/requests/);
  for(const route of ["/api/goodbase/v1/product/telemetry/sessions","/api/goodbase/v1/product/telemetry/stability","/api/goodbase/v1/product/telemetry/privacy/requests","/api/goodbase/v1/experience/telemetry/releases","/api/goodbase/v1/experience/telemetry/symbol-files"])assert.ok(contract.paths[route],route);
});

test("telemetry privacy is legal-hold aware and fails closed for external stores",()=>{
  const privacy=read("src/services/goodbase-telemetry-privacy.service.js");
  assert.match(privacy,/backend_legal_holds/);
  assert.match(privacy,/GOODBASE_TELEMETRY_PRIVACY_CONTROLLER_URL/);
  assert.match(privacy,/X-Goodbase-Signature/);
  assert.match(privacy,/status='blocked'/);
  assert.match(privacy,/prometheus/);
  assert.match(privacy,/loki/);
  assert.match(privacy,/tempo/);
});

test("plan retention runs nightly, records evidence, and preserves legal holds",()=>{
  const runner=read("scripts/goodbase-telemetry-retention.js");
  const timer=read("deploy/systemd/goodbase-telemetry-retention.timer");
  assert.match(runner,/goodbase_telemetry_retention_policies/);
  assert.match(runner,/backend_legal_holds/);
  assert.match(runner,/goodbase_telemetry_retention_runs/);
  assert.match(runner,/immutableSecurityDays/);
  assert.match(timer,/OnCalendar/);
  assert.match(timer,/Persistent=true/);
});

test("official clients expose session lifecycle and CI symbol upload without embedded credentials",()=>{
  for(const file of ["sdk/goodos.js","src/public/sdk/goodos.js","sdks/swift/Sources/Goodbase/GoodbaseClient.swift","sdks/kotlin/src/main/kotlin/app/goodos/goodbase/GoodbaseClient.kt","sdks/dart/lib/goodbase.dart"])assert.match(read(file),/recordSession/);
  const uploader=read("scripts/goodbase-upload-symbols.js");
  assert.match(uploader,/GOODBASE_ACCESS_TOKEN/);
  assert.match(uploader,/FormData/);
  assert.doesNotMatch(uploader,/Bearer\s+[A-Za-z0-9_-]{16,}/);
});
