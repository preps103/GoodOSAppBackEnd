const jobService = require("../services/job.service");

const workerId = process.env.GOODAPP_WORKER_ID || `goodapp-worker-${process.pid}`;
const intervalMs = Math.max(Number(process.env.GOODAPP_WORKER_INTERVAL_MS || 60000), 15000);

let running = false;
let shuttingDown = false;

async function tick(reason = "interval") {
  if (running || shuttingDown) return;

  running = true;

  try {
    await jobService.heartbeat(workerId, "online", {
      reason,
      intervalMs,
      timestamp: new Date().toISOString(),
    });

    const result = await jobService.runDueJobs({
      workerId,
      limit: 10,
      source: "goodapp-worker",
    });

    if (result.dueCount > 0) {
      console.log("[goodapp-worker] due jobs processed", JSON.stringify(result));
    }
  } catch (error) {
    console.error("[goodapp-worker] tick failed:", error);
  } finally {
    running = false;
  }
}

async function shutdown(signal) {
  shuttingDown = true;

  try {
    await jobService.heartbeat(workerId, "stopping", {
      signal,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[goodapp-worker] shutdown heartbeat failed:", error.message);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("[goodapp-worker] starting", JSON.stringify({ workerId, intervalMs, pid: process.pid }));

tick("startup");
setInterval(() => tick("interval"), intervalMs);
