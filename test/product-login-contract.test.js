const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const css = fs.readFileSync(path.join(__dirname, "..", "src/public/backend-login.css"), "utf8");
const routes = fs.readFileSync(path.join(__dirname, "..", "src/routes/index.js"), "utf8");
const docs = fs.readFileSync(path.join(__dirname, "..", "docs/product-login-contract.md"), "utf8");

test("shared product login stylesheet exposes the required structure", () => {
  for (const hook of ["data-goodbase-login", "data-goodbase-login-brand", "data-goodbase-login-auth", "data-goodbase-login-provider", "data-goodbase-login-fields", "data-goodbase-login-submit"]) assert.match(css, new RegExp(hook));
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /prefers-reduced-motion/);
});
test("product login stylesheet is cross-origin reusable", () => {
  assert.match(routes, /router\.get\("\/backend-login\.css"/);
  assert.match(routes, /Cross-Origin-Resource-Policy/);
});
test("contract requires every provider and excludes direct GoodOS", () => {
  for (const name of ["Google", "Apple", "Microsoft", "GoodOS SSO", "forgot-password", "create-account"]) assert.match(docs, new RegExp(name, "i"));
  assert.match(docs, /GoodOS uses its own hub-specific login/);
});
