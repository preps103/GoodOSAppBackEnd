"use strict";

const { metrics } = require("@opentelemetry/api");

const meter = metrics.getMeter("goodbase.application");
const requestDuration = meter.createHistogram("goodbase.http.server.duration", {
  description: "Goodbase HTTP request duration",
  unit: "ms",
});
const requestCount = meter.createCounter("goodbase.http.server.requests", {
  description: "Goodbase HTTP requests",
});
const workerTickCount = meter.createCounter("goodbase.worker.ticks", {
  description: "Goodbase worker ticks",
});
const workerTickDuration = meter.createHistogram("goodbase.worker.tick.duration", {
  description: "Goodbase worker tick duration",
  unit: "ms",
});
const workerEvents = meter.createCounter("goodbase.worker.events", {
  description: "Goodbase worker events processed",
});

function bounded(value, fallback = "unknown") {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(text) ? text : fallback;
}

function observeHttpRequest({ method, route, statusCode, durationMs, organizationId }) {
  const attributes = {
    "http.request.method": bounded(method),
    "http.route": bounded(route, "unmatched"),
    "http.response.status_code": Number(statusCode),
    "goodbase.tenant.id": bounded(organizationId, "unassigned"),
  };

  requestCount.add(1, attributes);
  requestDuration.record(Number(durationMs), attributes);
}

function observeWorkerTick({ status, durationMs, eventCount = 0 }) {
  const attributes = { "goodbase.worker.status": bounded(status) };
  workerTickCount.add(1, attributes);
  workerTickDuration.record(Number(durationMs), attributes);
  if (eventCount > 0) workerEvents.add(Number(eventCount), attributes);
}

module.exports = {
  observeHttpRequest,
  observeWorkerTick,
};
