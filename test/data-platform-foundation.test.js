const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("data-plane migration creates restricted roles, session checks, RLS, and an opt-in API schema", () => {
  const migration = read("migrations/20260720_postgrest_data_plane.sql");

  assert.match(migration, /CREATE ROLE goodos_anon NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(migration, /CREATE ROLE goodos_authenticated NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION goodos_auth\.check_session/);
  assert.match(migration, /ALTER TABLE public_goodos_demo_items ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /security_invoker = true/);
  assert.match(migration, /REVOKE ALL ON goodos_api\.demo_items FROM goodos_anon/);
});

test("PostgREST deployment is pinned and runs with a restricted container profile", () => {
  const compose = read("deploy/data-platform/compose.yaml");

  assert.match(compose, /postgrest\/postgrest:v14\.12/);
  assert.match(compose, /PGRST_DB_SCHEMAS: goodos_api/);
  assert.match(compose, /PGRST_DB_PRE_REQUEST: goodos_auth\.check_session/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.doesNotMatch(compose, /replace-me/);
});

test("data-plane gateway mints a short-lived session-bound database token", () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-data-platform-secret-that-is-long-enough";
  const { mintDataPlaneToken } = require("../src/services/data-plane-token.service");

  const token = mintDataPlaneToken({
    user: {
      id: "621d30ee-bbf5-43a0-958e-f8efff4c7c7c",
      email: "owner@example.test",
      platformRole: "owner"
    },
    auth: {
      sessionId: "cf5d6a85-9478-444a-a1fd-a3b035893007",
      authLevel: "password",
      mfaVerified: false
    }
  });
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  assert.equal(payload.role, "goodos_authenticated");
  assert.equal(payload.sid, "cf5d6a85-9478-444a-a1fd-a3b035893007");
  assert.equal(payload.tokenUse, "data_plane");
  assert.ok(payload.exp - payload.iat <= 300);
});

test("gateway exposes the automatic REST and component health routes", () => {
  const routes = read("src/routes/index.js");
  const gateway = read("src/routes/data-plane.routes.js");

  assert.match(routes, /"\/rest\/v1"/);
  assert.match(routes, /"\/api\/data-platform"/);
  assert.match(gateway, /mintDataPlaneToken/);
  assert.match(gateway, /X-GoodOS-Data-Plane/);
  assert.match(gateway, /controlRouter\.get\("\/health"/);
});
