#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${OBSERVABILITY_ENV_FILE:-/etc/goodbase/observability.env}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Missing observability environment file: $ENV_FILE" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/compose.yaml" config --quiet
docker run --rm -v "$ROOT_DIR/config/prometheus:/etc/prometheus:ro" prom/prometheus:v3.11.3 \
  promtool check config /etc/prometheus/prometheus.yml
docker run --rm -v "$ROOT_DIR/config/alertmanager:/etc/alertmanager:ro" prom/alertmanager:v0.32.1 \
  amtool check-config /etc/alertmanager/alertmanager.yml
docker run --rm -v "$ROOT_DIR/config/otel:/etc/otelcol-contrib:ro" otel/opentelemetry-collector-contrib:0.153.0 \
  validate --config=/etc/otelcol-contrib/collector.yaml
