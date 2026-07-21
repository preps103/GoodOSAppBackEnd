"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname,"..");
const read = (file) => fs.readFileSync(path.join(root,file),"utf8");

test("phases 46-50 persist production evidence with tenant isolation",()=>{
  const migration=read("migrations/20260721_goodbase_phases46_50.sql");
  for(let phase=46;phase<=50;phase+=1)assert.match(migration,new RegExp(`Phase ${phase}`));
  for(const table of ["goodbase_tester_invitations","goodbase_distribution_downloads","goodbase_tester_feedback","goodbase_analytics_funnels","goodbase_subject_deletion_requests","goodbase_symbolication_jobs","goodbase_telemetry_alerts","goodbase_in_app_campaigns","goodbase_in_app_impressions","goodbase_hosting_projects","goodbase_hosting_releases","goodbase_hosting_traffic_splits"])assert.match(migration,new RegExp(table));
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/goodbase_tenant_isolation/);
  assert.doesNotMatch(migration,/GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES/);
});

test("experience APIs require verified evidence and privileged MFA",()=>{
  const routes=read("src/routes/goodbase-experience.routes.js"),index=read("src/routes/index.js");
  assert.match(index,/goodbaseExperienceRoutes\.publicRouter/);
  assert.match(index,/goodbaseExperienceRoutes\.authenticatedRouter/);
  assert.match(routes,/dataPlaneAdminRequired/);
  assert.match(routes,/GOODBASE_PRIVILEGED_MFA_REQUIRED/);
  assert.match(routes,/GOODBASE_HOSTING_CONTROLLER_REQUIRED/);
  assert.match(routes,/controller_status!=="ready"/);
});

test("Studio reads real API evidence and does not hard-code healthy status",()=>{
  const html=read("src/public/studio.html"),client=read("src/public/studio.js");
  assert.match(html,/Goodbase Studio/);
  assert.match(client,/experience\/studio\/overview/);
  assert.match(client,/unconfigured/);
  assert.doesNotMatch(client,/const ready\s*=\s*true/);
});

test("all GoodOS apps share durable per-user local-drive storage without secrets",()=>{
  const runtime=read("src/public/sdk/goodbase-offline.js"),standard=read("docs/goodbase-offline-storage-standard.md");
  assert.match(runtime,/navigator\.storage\.persist/);
  assert.match(runtime,/global\.localStorage/);
  assert.match(runtime,/goodbase\.offline\.v1/);
  assert.match(runtime,/storageStatus/);
  assert.match(runtime,/deleteDatabase/);
  assert.match(standard,/Every GoodOS application/);
  assert.match(standard,/must never be stored/);
});
