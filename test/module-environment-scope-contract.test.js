const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relativePath) =>
  fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("module scope migration backfills and enforces application and function-run environments", () => {
  const migration = read("migrations/20260724_module_environment_scope_100.sql");

  assert.match(migration, /UPDATE apps[\s\S]*environment_id = COALESCE\(environment_id, 'env_goodos_production'\)/);
  assert.match(migration, /UPDATE backend_edge_function_runs AS runs[\s\S]*functions\.environment_id/);
  assert.match(migration, /ALTER TABLE apps[\s\S]*ALTER COLUMN environment_id SET NOT NULL/);
  assert.match(migration, /ALTER TABLE backend_edge_function_runs[\s\S]*ALTER COLUMN environment_id SET NOT NULL/);
});

test("application and function-run creation paths always persist environment scope", () => {
  const adminRoutes = read("src/routes/admin.routes.js");
  const publicRoutes = read("src/routes/public-api.routes.js");

  assert.match(
    adminRoutes,
    /INSERT INTO apps \([\s\S]*organization_id,[\s\S]*project_id,[\s\S]*environment_id/
  );
  assert.match(
    adminRoutes,
    /INSERT INTO backend_edge_function_runs \([\s\S]*fn\.organization_id,[\s\S]*fn\.project_id,[\s\S]*fn\.environment_id/
  );
  assert.match(
    publicRoutes,
    /INSERT INTO backend_edge_function_runs \([\s\S]*fn\.organization_id,[\s\S]*fn\.project_id,[\s\S]*fn\.environment_id/
  );
});
