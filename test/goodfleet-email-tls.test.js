const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const service = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "notification.service.js"),
  "utf8"
);

test("GoodOS Base email transport uses the configured TLS server name", () => {
  assert.match(service, /secretOrEnv\("SMTP_TLS_SERVERNAME"\)/);
  assert.match(service, /servername: config\.servername/);
  assert.match(service, /rejectUnauthorized: true/);
});

test("GoodFleet email outcomes synchronize back to customer delivery history", () => {
  assert.match(service, /syncFleetEmailDelivery/);
  assert.match(service, /fleet_customer_notification_deliveries/);
  assert.match(service, /fleet_customer_notifications/);
  assert.match(service, /EMAIL_DELIVERY_FAILED/);
});
