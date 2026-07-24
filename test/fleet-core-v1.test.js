"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("Fleet API is authenticated, tenant scoped, and mounted at a versioned path", () => {
  const routes = read("src/routes/fleet.routes.js");
  const index = read("src/routes/index.js");
  assert.match(routes, /router\.use\(authRequired, tenantContext\)/);
  assert.match(routes, /request\.tenantContext\.organizationId/);
  assert.match(index, /router\.use\("\/api\/fleet\/v1", fleetRoutes\)/);
});

test("Fleet booking creation serializes by tenant and vehicle", () => {
  const routes = read("src/routes/fleet.routes.js");
  assert.match(routes, /pg_advisory_xact_lock/);
  assert.match(routes, /FOR UPDATE/);
  assert.match(routes, /VEHICLE_NOT_AVAILABLE/);
});

test("Fleet schema enforces tenant uniqueness, compliance, and buffered booking exclusion", () => {
  const migration = read("migrations/20260722_goodfleet_core_v1.sql");
  assert.match(migration, /UNIQUE \(organization_id, vin\)/);
  assert.match(migration, /UNIQUE \(organization_id, license_plate\)/);
  assert.match(migration, /tstzrange\(pickup_at - interval '2 hours', return_at \+ interval '2 hours'/);
  assert.match(migration, /EXCLUDE USING gist/);
  assert.match(migration, /fleet_audit_events/);
});
