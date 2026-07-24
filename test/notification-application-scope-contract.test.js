"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("product notification routes require an application scope", () => {
  const routes = read("src/routes/notification-center.routes.js");

  for (const route of [
    '"/apps/:appId/overview"',
    '"/apps/:appId/:notificationId/read"',
    '"/apps/:appId/read-all"',
    '"/apps/:appId/:notificationId"',
    '"/apps/:appId/archive-read"',
  ]) {
    assert.ok(routes.includes(route), `${route} must remain available`);
  }

  assert.match(
    routes,
    /getApplicationOverviewForUser\([\s\S]*req\.params\.appId/
  );
  assert.match(
    routes,
    /updateReadStateForUser\([\s\S]*req\.params\.appId/
  );
  assert.match(
    routes,
    /archiveNotificationForUser\([\s\S]*req\.params\.appId/
  );
});

test("application-scoped mutations enforce app ownership in SQL", () => {
  const service = read("src/services/notification-center.service.js");

  assert.match(service, /async function requireAppAccess/);
  assert.match(service, /Application notification scope is required\./);
  assert.match(
    service,
    /async function updateReadStateForUser\([\s\S]*await requireAppAccess\([\s\S]*notificationAppIdSql/
  );
  assert.match(
    service,
    /async function archiveNotificationForUser\([\s\S]*await requireAppAccess\([\s\S]*notificationAppIdSql/
  );
});

test("integration guide reserves unscoped notifications for GoodOS", () => {
  const guide = read("docs/goodos-topbar-integration.md");

  assert.match(
    guide,
    /GET\s+\/api\/notifications\/apps\/:appId\/overview/
  );
  assert.match(
    guide,
    /Product code must not call the unscoped/
  );
  assert.match(
    guide,
    /GoodOS master Notification Center/
  );
});
