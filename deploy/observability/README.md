# Goodbase Observability Controller

Production telemetry plane for Goodbase. It is deliberately bounded for the current single production host: all backend ports bind only to loopback, containers have CPU and memory ceilings, Prometheus retains 15 days/8 GB, and Loki and Tempo retain seven days.

## Components

- OpenTelemetry Collector: OTLP ingestion, host metrics, and durable log checkpoints.
- Prometheus and Alertmanager: metrics, recording rules, SLO burn rates, and alert state.
- Loki: correlated application, Nginx, and PostgreSQL logs.
- Tempo: distributed traces.
- Grafana: provisioned data sources and Goodbase production dashboards.
- Blackbox Exporter: HTTPS, certificate-expiry, and DNS probes.

## Security model

Only Grafana (`127.0.0.1:3300`), OTLP (`127.0.0.1:4317/4318`), Prometheus (`127.0.0.1:9090`), and Alertmanager (`127.0.0.1:9093`) are bound on the host, and none are publicly reachable directly. Grafana is served through the authenticated Goodbase Nginx path. No secrets belong in this directory; production values live in `/etc/goodbase/observability.env` with mode `0600`.

Alertmanager is initially provisioned with an internal receiver so alerts are retained and visible without silently using an unapproved external delivery service. Connect the existing Goodbase notification service after a dedicated signed webhook is deployed and tested.

## Validation

Run `./scripts/validate.sh` before every deployment. Production deployment is managed by `goodbase-observability.service` and uses `docker compose up -d --remove-orphans`.
