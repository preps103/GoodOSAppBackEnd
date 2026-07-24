const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("GoodOS Base email transport uses the configured TLS server name", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "notification.service.js"),
    "utf8"
  );

  assert.match(service, /secretOrEnv\("SMTP_TLS_SERVERNAME"\)/);
  assert.match(service, /servername: config\.servername/);
  assert.match(service, /rejectUnauthorized: true/);
});
