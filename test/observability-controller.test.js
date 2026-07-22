"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("observability controller pins the complete production telemetry plane", () => {
  const compose = read("deploy/observability/compose.yaml");

  for (const image of [
    "opentelemetry-collector-contrib:0.153.0",
    "prom/prometheus:v3.11.3",
    "grafana/loki:3.7.2",
    "grafana/tempo:2.10.5",
    "grafana/grafana:13.1.0",
    "prom/alertmanager:v0.32.1",
    "prom/blackbox-exporter:v0.28.0",
  ]) {
    assert.match(compose, new RegExp(image.replaceAll(".", "\\.")));
  }

  assert.doesNotMatch(compose, /promtail/i);
  assert.match(compose, /127\.0\.0\.1:3300:3000/);
  assert.match(compose, /127\.0\.0\.1:4318:4318/);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /cpus:/);
});

test("telemetry retention, correlation, probes, and SLO alerts are configured", () => {
  const collector = read("deploy/observability/config/otel/collector.yaml");
  const loki = read("deploy/observability/config/loki/loki.yaml");
  const tempo = read("deploy/observability/config/tempo/tempo.yaml");
  const rules = read("deploy/observability/config/prometheus/rules.yml");
  const datasources = read("deploy/observability/config/grafana/provisioning/datasources/datasources.yml");

  assert.match(collector, /receivers: \[otlp, hostmetrics\]/);
  assert.match(collector, /receivers: \[otlp, filelog\]/);
  assert.match(collector, /goodbase-worker/);
  assert.match(loki, /retention_period: 168h/);
  assert.match(tempo, /block_retention: 168h/);
  assert.match(rules, /GoodbaseFastBurn/);
  assert.match(rules, /GoodbaseCertificateExpiresSoon/);
  assert.match(rules, /GoodbaseDnsResolutionFailure/);
  assert.match(datasources, /tracesToLogsV2/);
  assert.match(datasources, /matcherRegex:.*traceId/);
});

test("Grafana is published only through the canonical Goodbase subpath", () => {
  const nginx = read("deploy/nginx/goodbase-observability.location.conf");
  const compose = read("deploy/observability/compose.yaml");

  assert.match(nginx, /location \^~ \/observability\//);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3300/);
  assert.match(compose, /GF_SECURITY_COOKIE_SECURE: "true"/);
  assert.match(compose, /GF_AUTH_ANONYMOUS_ENABLED: "false"/);
});

test("Goodbase API and worker export telemetry without exposing secrets", () => {
  const bootstrap = read("src/telemetry/bootstrap.js");
  const middleware = read("src/middleware/enterprise-observability.js");
  const ecosystem = read("ecosystem.config.cjs");

  assert.match(bootstrap, /OTEL_EXPORTER_OTLP_ENDPOINT/);
  assert.match(bootstrap, /enhancedDatabaseReporting: false/);
  assert.match(middleware, /goodbase\.tenant\.id/);
  assert.match(ecosystem, /http:\/\/127\.0\.0\.1:4318/);
  assert.doesNotMatch(bootstrap, /DATABASE_URL|JWT_SECRET|SMTP_PASS/);
});
