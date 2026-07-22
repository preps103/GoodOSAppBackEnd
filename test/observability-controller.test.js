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
    "node:22.17.0-alpine",
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
  assert.match(read("deploy/observability/config/grafana/dashboards/goodbase-overview.json"), /goodbase_tenant_id/);
  assert.match(read("deploy/observability/config/alertmanager/alertmanager.yml"), /http:\/\/alert-relay:8080\/v1\/alerts/);
  assert.match(rules, /GoodbaseAlertDeliveryFailures/);
});

test("outbound alerts use signed relay delivery, durable routing, and no mail credentials", () => {
  const relay = read("deploy/observability/alert-relay/server.js");
  const service = read("src/services/goodbase-alert-delivery.service.js");
  const routes = read("src/routes/goodbase-alert-delivery.routes.js");
  const migration = read("migrations/20260722_goodbase_alert_delivery.sql");
  const compose = read("deploy/observability/compose.yaml");

  assert.match(relay, /createHmac\("sha256"/);
  assert.match(relay, /JSON\.stringify\(JSON\.parse\(body\)\)/);
  assert.match(relay, /stats\.retries/);
  assert.match(relay, /\/metrics/);
  assert.match(service, /GOODBASE_ALERT_WEBHOOK_SECRET_FILE/);
  assert.match(service, /deduplication_key/);
  assert.match(service, /isQuietHours/);
  assert.match(service, /escalation_step/);
  assert.match(routes, /GOODBASE_ALERT_REPLAY_DETECTED/);
  assert.match(routes, /alerts\/test/);
  assert.match(migration, /goodbase_alert_delivery_attempts/);
  assert.match(migration, /goodbase_on_call_policies/);
  assert.match(compose, /\/etc\/goodbase\/alert-webhook\.secret/);
  for (const forbidden of ["SMTP_PASS", "gmail.com", "MAIL_PASSWORD"]) {
    assert.doesNotMatch(relay + compose, new RegExp(forbidden, "i"));
  }
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
  assert.match(read("src/services/goodbase-product.service.js"), /observeBrowserPerformance/);
  assert.match(ecosystem, /http:\/\/127\.0\.0\.1:4318/);
  assert.doesNotMatch(bootstrap, /DATABASE_URL|JWT_SECRET|SMTP_PASS/);
});

test("browser telemetry and JavaScript source maps feed production observability", () => {
  const product = read("src/services/goodbase-product.service.js");
  const symbols = read("src/services/goodbase-symbolication.service.js");
  const routes = read("src/routes/goodbase-experience.routes.js");

  assert.match(product, /observeBrowserPerformance/);
  assert.match(product, /symbolicateStack/);
  assert.match(symbols, /SourceMapConsumer\.with/);
  assert.match(symbols, /goodbase_symbol_files/);
  assert.match(symbols, /20 \* 1024 \* 1024/);
  assert.match(routes, /telemetry\/symbol-files/);
  assert.match(routes, /mfaRequired,symbolUpload/);
});
