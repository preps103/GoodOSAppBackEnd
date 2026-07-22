"use strict";

const os = require("os");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_INSTANCE_ID,
} = require("@opentelemetry/semantic-conventions");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

let sdk = null;
let stopping = null;

function exporterUrl(baseUrl, signal) {
  const specific = process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (specific) return specific;
  return `${String(baseUrl).replace(/\/$/, "")}/v1/${signal}`;
}

function startTelemetry() {
  const baseUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!baseUrl || process.env.OTEL_SDK_DISABLED === "true") {
    return null;
  }

  const serviceName =
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    "goodbase-api";

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.GOODBASE_RELEASE_COMMIT || "unknown",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV || "development",
    [ATTR_SERVICE_INSTANCE_ID]: `${os.hostname()}:${process.pid}`,
    "goodbase.runtime.role": process.env.GOODBASE_RUNTIME_ROLE || "api",
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: exporterUrl(baseUrl, "traces"),
      timeoutMillis: 5000,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: exporterUrl(baseUrl, "metrics"),
          timeoutMillis: 5000,
        }),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000),
        exportTimeoutMillis: 5000,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: req =>
            req.url === "/health" || req.url === "/api/enterprise/health",
        },
        "@opentelemetry/instrumentation-pg": {
          enhancedDatabaseReporting: false,
        },
      }),
    ],
  });

  try {
    sdk.start();
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "telemetry.started",
        service: serviceName,
      })}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warning",
        event: "telemetry.start_failed",
        message: error.message,
      })}\n`
    );
    sdk = null;
  }

  return sdk;
}

async function shutdownTelemetry() {
  if (!sdk) return;
  if (!stopping) {
    stopping = sdk.shutdown().catch(error => {
      process.stderr.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warning",
          event: "telemetry.shutdown_failed",
          message: error.message,
        })}\n`
      );
    });
  }
  await stopping;
}

startTelemetry();

module.exports = {
  shutdownTelemetry,
};
