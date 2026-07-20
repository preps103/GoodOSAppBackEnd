const app = require("./app");
const env = require("./config/env");
const database = require("./config/database");
const { attachRealtimeWebSocketServer } = require("./realtime/hub");
const { flushMetrics } = require("./enterprise/enterprise-foundation.service");
const { createShutdownController } = require("./runtime/graceful-shutdown");

const server = app.listen(env.port, "127.0.0.1", () => {
  console.log(`${env.serviceName} running on http://127.0.0.1:${env.port}`);
});

const realtimeServer = attachRealtimeWebSocketServer(server);
const shutdownController = createShutdownController({
  server,
  realtimeServer,
  pool: database.pool,
  flushMetrics,
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void shutdownController.shutdown(signal, 0);
  });
}

module.exports = server;
