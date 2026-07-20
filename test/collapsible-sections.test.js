"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("backend console loads the long-table and mobile layout assets", () => {
  const consoleHtml = read("src/public/console.html");
  const routes = read("src/routes/index.js");

  assert.match(consoleHtml, /href="\/backend-collapsible-sections\.css"/);
  assert.match(consoleHtml, /src="\/backend-collapsible-sections\.js"/);
  assert.match(routes, /router\.get\("\/backend-collapsible-sections\.css"/);
  assert.match(routes, /router\.get\("\/backend-collapsible-sections\.js"/);
});

test("long tables receive a capped scroll region and accessible collapse control", () => {
  const client = read("src/public/backend-collapsible-sections.js");
  const styles = read("src/public/backend-collapsible-sections.css");

  assert.match(client, /MINIMUM_ROWS = 7/);
  assert.match(client, /COLLAPSED_ROW_LIMIT = 5/);
  assert.match(client, /goodos-long-table-preview-hidden/);
  assert.match(client, /Show first 5 rows/);
  assert.match(client, /Show all rows/);
  assert.match(client, /localStorage\.getItem\(key\) !== "open"/);
  assert.match(client, /aria-expanded/);
  assert.match(client, /aria-controls/);
  assert.match(client, /localStorage/);
  assert.match(client, /MutationObserver/);
  assert.match(styles, /--goodos-table-region-height: 460px/);
  assert.match(styles, /max-height: min\(var\(--goodos-table-region-height\)/);
  assert.match(styles, /overflow: auto !important/);
  assert.match(styles, /data-collapsed="true"/);
  assert.match(styles, /\.goodos-long-table-preview-hidden/);
  assert.doesNotMatch(styles, /\.goodos-long-table-shell\[data-collapsed="true"\]\s*\{\s*display:\s*none/);
});

test("tablet and mobile styles preserve short tables and usable navigation", () => {
  const styles = read("src/public/backend-collapsible-sections.css");
  const client = read("src/public/backend-collapsible-sections.js");

  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.match(styles, /@media \(max-width: 540px\)/);
  assert.match(styles, /--goodos-table-region-height: 340px/);
  assert.match(styles, /min-height: 46px/);
  assert.match(client, /goodos-mobile-nav-toggle/);
  assert.match(client, /matchMedia\("\(max-width: 820px\)"\)/);
});
