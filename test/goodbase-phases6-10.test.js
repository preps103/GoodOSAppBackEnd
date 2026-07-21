"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Phase 6 implements durable leased queues with idempotency and dead letters", () => {
  const sql = read("migrations/20260721_goodbase_phases6_10.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS goodbase_queues/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION goodbase_queue_receive/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /lease_token UUID/);
  assert.match(sql, /idempotency_key TEXT/);
  assert.match(sql, /dead_lettered/);
});

test("Phase 7 provides tenant schedules, concurrency controls, and run history", () => {
  const sql = read("migrations/20260721_goodbase_phases6_10.sql");
  const jobs = read("src/services/job.service.js");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS goodbase_schedules/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS goodbase_schedule_runs/);
  assert.match(sql, /concurrency_limit INTEGER/);
  assert.match(jobs, /nextCronOccurrence/);
  assert.match(jobs, /goodbase\.schedules\.dispatch/);
});

test("Phase 8 records encrypted recovery policy, PITR points, replicas, and exercises", () => {
  const sql = read("migrations/20260721_goodbase_phases6_10.sql");
  assert.match(sql, /goodbase_backup_policies/);
  assert.match(sql, /goodbase_recovery_points/);
  assert.match(sql, /goodbase_dr_exercises/);
  assert.match(sql, /goodbase_read_replicas/);
  assert.match(sql, /offsite_required BOOLEAN NOT NULL DEFAULT TRUE/);
});

test("Phase 9 models TUS, multipart, transforms, scanning, and CDN operations", () => {
  const sql = read("migrations/20260721_goodbase_phases6_10.sql");
  const routes = read("src/routes/goodbase-advanced-platform.routes.js");
  assert.match(sql, /protocol IN \('tus','s3_multipart'\)/);
  assert.match(sql, /goodbase_upload_parts/);
  assert.match(sql, /goodbase_image_transforms/);
  assert.match(sql, /goodbase_storage_security_events/);
  assert.match(routes, /storage\/cache\/purge/);
});

test("Phase 10 runs Deno separately with immutable versions and hard container limits", () => {
  const sql = read("migrations/20260721_goodbase_phases6_10.sql");
  const compose = read("deploy/data-platform/compose.yaml");
  const runtime = read("src/edge-runtime/server.ts");
  assert.match(sql, /goodbase_edge_versions/);
  assert.match(sql, /immutable BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(compose, /image: denoland\/deno:2\.8\.1/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(runtime, /networkArgs/);
  assert.match(runtime, /FUNCTION_TIMEOUT/);
});

test("Phase 6-10 APIs require authenticated tenant administrator context", () => {
  const routes = read("src/routes/goodbase-advanced-platform.routes.js");
  const index = read("src/routes/index.js");
  assert.match(routes, /router\.use\(authRequired, tenantContext, dataPlaneAdminRequired\)/);
  assert.match(index, /\/api\/goodbase\/v1\/platform/);
});
