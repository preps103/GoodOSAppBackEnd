"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("GoodSwapz stores user-owned listings and ownership review state", () => {
  const migration = read("migrations/20260723_goodswapz_application.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS goodswapz_listings/);
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ownership_verification_code TEXT NOT NULL UNIQUE/);
  assert.match(migration, /'goodswapz', 'GoodSwapz', 'swapz\.goodos\.app'/);
});

test("GoodSwapz seller APIs are authenticated, origin-bound, and ownership-scoped", () => {
  const route = read("src/routes/goodswapz.routes.js");
  const index = read("src/routes/index.js");
  assert.match(index, /router\.use\("\/api\/swapz\/v1", goodswapzRoutes\)/);
  assert.match(route, /router\.use\(authRequired\)/);
  assert.match(route, /GOODSWAPZ_ORIGIN_DENIED/);
  assert.match(route, /X-Requested-With/);
  assert.match(route, /listing\.user_id=\$1/);
  assert.match(route, /WHERE id=\$1 AND user_id=\$2/);
  assert.match(route, /input\.acceptsSellerTerms !== true/);
  assert.doesNotMatch(route, /req\.body\?\.userId/);
});
