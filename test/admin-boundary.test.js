"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("both legacy and versioned admin paths require the administrator boundary", () => {
  const app = read("src/app.js");

  assert.match(app, /app\.use\(\s*"\/api\/admin",\s*goodosPhase2Security\.adminBoundary/);
  assert.match(app, /app\.use\(\s*"\/admin",\s*goodosPhase2Security\.adminBoundary/);
});

test("database consoles are mounted only behind protected admin prefixes", () => {
  const routes = read("src/routes/index.js");

  for (const mount of [
    "/admin/table-editor",
    "/api/admin/table-editor",
    "/admin/sql-editor",
    "/api/admin/sql-editor",
    "/admin/database-management",
    "/api/admin/database-management",
  ]) {
    assert.ok(routes.includes(`router.use("${mount}"`), `${mount} must remain mounted`);
  }
});

test("database administrative routers do not mount their own public prefixes", () => {
  for (const routeFile of [
    "src/routes/table-editor.routes.js",
    "src/routes/sql-editor.routes.js",
    "src/routes/database-management.routes.js",
  ]) {
    const source = read(routeFile);
    assert.doesNotMatch(source, /app\.use\(/);
    assert.doesNotMatch(source, /router\.use\(\s*["']\/(?:api\/)?admin/);
  }
});
