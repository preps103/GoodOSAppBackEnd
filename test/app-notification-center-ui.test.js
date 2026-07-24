const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app-notification-center.js"), "utf8");
const consoleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "public", "console.html"), "utf8");

test("GoodBase notification center is strictly application scoped", () => {
  assert.match(source, /const appId = "goodbase"/);
  assert.match(source, /appId === "all"/);
  assert.match(source, /\/api\/notifications\/apps\//);
  assert.doesNotMatch(source, /appId = "all"/);
});

test("GoodBase notification center exposes the complete user workflow", () => {
  for (const text of ["Search notifications", "All status", "All categories", "All severity", "Mark all read", "Archive read", "Mark unread", "Archive", "Preferences", "Previous", "Next"]) {
    assert.match(source, new RegExp(text));
  }
  assert.match(consoleHtml, /goodbase:notifications/);
  assert.match(consoleHtml, /app-notification-center\.js/);
});
