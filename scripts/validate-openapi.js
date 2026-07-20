"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "docs/openapi.json");
const publicPath = path.join(root, "src/public/developer/openapi.json");

function load(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const source = load(sourcePath);
const published = load(publicPath);

assert.match(String(source.openapi || ""), /^3\./, "OpenAPI 3.x is required");
assert.ok(source.info?.title, "API title is required");
assert.ok(source.info?.version, "API version is required");
assert.ok(Object.keys(source.paths || {}).length > 0, "At least one API path is required");
assert.deepStrictEqual(published, source, "Published OpenAPI document is out of sync");

for (const [route, operations] of Object.entries(source.paths)) {
  assert.ok(route.startsWith("/"), `Invalid API path: ${route}`);
  assert.ok(Object.keys(operations || {}).length > 0, `No operation defined for ${route}`);
}

console.log(`OpenAPI contract valid: ${Object.keys(source.paths).length} paths`);
