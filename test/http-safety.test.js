"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  publicMessageFor,
  statusCodeFor,
} = require("../src/middleware/errorHandler");

const root = path.resolve(__dirname, "..");

test("unexpected server errors are not disclosed to API clients", () => {
  const failure = new Error("password authentication failed for database secret_name");
  assert.equal(statusCodeFor(failure), 500);
  assert.equal(publicMessageFor(failure, 500), "Internal server error");
});

test("intentional client errors retain their actionable message", () => {
  const failure = Object.assign(new Error("Uploaded file is too large."), { statusCode: 413 });
  assert.equal(statusCodeFor(failure), 413);
  assert.equal(publicMessageFor(failure, 413), "Uploaded file is too large.");
});

test("HTTP server configures finite request and connection limits", () => {
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  const env = fs.readFileSync(path.join(root, "src/config/env.js"), "utf8");

  for (const setting of [
    "requestTimeout",
    "headersTimeout",
    "keepAliveTimeout",
    "maxRequestsPerSocket",
    "maxHeadersCount",
  ]) {
    assert.ok(server.includes(`server.${setting}`), `${setting} must be configured`);
  }
  assert.match(env, /REQUEST_TIMEOUT_MS/);
  assert.match(env, /HEADERS_TIMEOUT_MS/);
});
