"use strict";

const { runtimeLifecycle } = require("./lifecycle");

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server?.close) return resolve();

    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

function closeRealtimeServer(realtimeServer) {
  return new Promise((resolve) => {
    if (!realtimeServer) return resolve();

    for (const client of realtimeServer.clients || []) {
      try {
        client.close(1012, "Service restarting");
      } catch {
        client.terminate?.();
      }
    }

    realtimeServer.close?.(() => resolve());
    if (!realtimeServer.close) resolve();
  });
}

function createShutdownController({
  server,
  realtimeServer,
  pool,
  flushMetrics = async () => {},
  lifecycle = runtimeLifecycle,
  logger = console,
  timeoutMs = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 8000),
  exit = (code) => process.exit(code),
} = {}) {
  let shutdownPromise = null;

  function shutdown(signal = "shutdown", exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;

    lifecycle.beginDrain(signal);
    logger.info?.(`Goodbase draining after ${signal}.`);

    shutdownPromise = (async () => {
      const deadline = setTimeout(() => {
        logger.error?.(`Graceful shutdown exceeded ${timeoutMs}ms; closing remaining connections.`);
        server?.closeAllConnections?.();
        exit(1);
      }, timeoutMs);
      deadline.unref?.();

      try {
        await Promise.allSettled([
          closeHttpServer(server),
          closeRealtimeServer(realtimeServer),
          Promise.resolve().then(() => flushMetrics()),
        ]);

        await pool?.end?.();
        clearTimeout(deadline);
        logger.info?.("Goodbase shutdown completed.");
        exit(exitCode);
      } catch (error) {
        clearTimeout(deadline);
        logger.error?.("Goodbase shutdown failed.", error);
        exit(1);
      }
    })();

    return shutdownPromise;
  }

  return { shutdown };
}

module.exports = {
  closeHttpServer,
  closeRealtimeServer,
  createShutdownController,
};
