"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("backend console loads the themed ADA control", () => {
  const consoleHtml = read("src/public/console.html");
  const routes = read("src/routes/index.js");
  assert.match(consoleHtml, /href="\/backend-ada\.css"/);
  assert.match(consoleHtml, /src="\/backend-ada\.js"/);
  assert.match(routes, /router\.get\("\/backend-ada\.css"/);
  assert.match(routes, /router\.get\("\/backend-ada\.js"/);
  assert.match(
    routes,
    /router\.get\("\/backend-ada\.js"[\s\S]*?Cross-Origin-Resource-Policy", "cross-origin"[\s\S]*?\n}\);/,
  );
  assert.match(
    routes,
    /router\.get\("\/backend-ada\.css"[\s\S]*?Cross-Origin-Resource-Policy", "cross-origin"[\s\S]*?\n}\);/,
  );
});

test("ADA control preserves the GoodOS accessibility contract", () => {
  const client = read("src/public/backend-ada.js");
  const styles = read("src/public/backend-ada.css");

  assert.match(client, /goodos-accessibility-settings-v1/);
  for (const setting of [
    "textScale",
    "highContrast",
    "grayscale",
    "reduceAnimations",
    "highlightLinks",
    "focusIndicators",
  ]) {
    assert.ok(client.includes(setting), `${setting} must remain available`);
  }
  assert.match(client, /aria-haspopup="dialog"/);
  assert.match(client, /setOpen\(panel\.hidden, false\)/);
  assert.match(client, /event\.key === "Escape"/);
  assert.match(styles, /html\.ada-reduce-motion/);
  assert.match(styles, /html\.ada-focus-indicators/);
  assert.match(styles, /button\[aria-label="Accessibility Options"\]:not\(\.backend-ada-trigger\)/);
  assert.match(styles, /button\[aria-label="Open accessibility menu"\]:not\(\.backend-ada-trigger\)/);
});

test("ADA launcher and panel use the universal GoodOS dimensions", () => {
  const styles = read("src/public/backend-ada.css");

  for (const requiredRule of [
    "right: 24px",
    "bottom: 24px",
    "z-index: 50",
    "width: 90px",
    "min-width: 90px",
    "max-width: 90px",
    "height: 46px",
    "min-height: 46px",
    "max-height: 46px",
    "padding: 12px 16px",
    "gap: 8px",
    "font-size: 12px",
    "font-weight: 700",
    "line-height: 16px",
    "letter-spacing: 0.05em",
    "border-radius: 9999px",
    "bottom: 96px",
    "z-index: 100",
    "width: 400px",
    "height: 750px",
    "max-height: 85vh",
    "border-radius: 24px",
  ]) {
    assert.ok(styles.includes(requiredRule), `${requiredRule} must remain standardized`);
  }
});

test("PostgREST exposes its local-only admin readiness endpoint", () => {
  const compose = read("deploy/data-platform/compose.yaml");
  assert.match(compose, /PGRST_ADMIN_SERVER_PORT: "8301"/);
  assert.match(compose, /network_mode: host/);
});
