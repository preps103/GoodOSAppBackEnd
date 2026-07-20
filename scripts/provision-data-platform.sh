#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${GOODOS_APP_DIR:-/var/www/GoodAppBackEnd}"
ENV_DIR="${GOODOS_DATA_PLATFORM_ENV_DIR:-/etc/goodos}"
ENV_FILE="$ENV_DIR/data-platform.env"
MIGRATION="$APP_DIR/migrations/20260720_postgrest_data_plane.sql"
SERVICE_FILE="$APP_DIR/deploy/systemd/goodos-data-platform.service"
COMPOSE_DIR="$APP_DIR/deploy/data-platform"
DB_NAME="goodos_backend"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR=Run this provisioning script as root."
  exit 1
fi

if [ ! -f "$MIGRATION" ] || [ ! -f "$SERVICE_FILE" ]; then
  echo "ERROR=Data-platform release files are missing."
  exit 1
fi

JWT_SECRET_VALUE="$(cd "$APP_DIR" && node -e 'require("dotenv").config(); if (!process.env.JWT_SECRET) process.exit(2); process.stdout.write(process.env.JWT_SECRET)')"

if [ -z "$JWT_SECRET_VALUE" ] || [[ "$JWT_SECRET_VALUE" == *$'\n'* ]]; then
  echo "ERROR=JWT_SECRET is missing or invalid."
  exit 1
fi

DB_PASSWORD=""
if [ -f "$ENV_FILE" ]; then
  DB_PASSWORD="$(sed -n 's/^PGRST_DB_PASSWORD=//p' "$ENV_FILE" | head -n 1 | tr -d '\r')"
fi
if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(openssl rand -hex 32)"
fi

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$MIGRATION"

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -v role_password="$DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE goodos_postgrest_authenticator LOGIN NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'role_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'goodos_postgrest_authenticator'
) \gexec

SELECT format(
  'ALTER ROLE goodos_postgrest_authenticator WITH LOGIN NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'role_password'
) \gexec

GRANT goodos_anon TO goodos_postgrest_authenticator;
GRANT goodos_authenticated TO goodos_postgrest_authenticator;
GRANT CONNECT ON DATABASE goodos_backend TO goodos_postgrest_authenticator;
SQL

install -d -o root -g root -m 0750 "$ENV_DIR"
umask 077
{
  printf 'PGRST_DB_URI=postgres://goodos_postgrest_authenticator:%s@127.0.0.1:5432/goodos_backend\n' "$DB_PASSWORD"
  printf 'PGRST_DB_PASSWORD=%s\n' "$DB_PASSWORD"
  printf 'GOODOS_JWT_SECRET=%s\n' "$JWT_SECRET_VALUE"
  printf 'REALTIME_DB_NAME=_goodos_realtime\n'
  printf 'REALTIME_DB_USER=goodos_realtime\n'
  printf 'REALTIME_DB_PASSWORD=not-provisioned\n'
  printf 'REALTIME_API_JWT_SECRET=not-provisioned\n'
  printf 'REALTIME_SECRET_KEY_BASE=not-provisioned\n'
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"

install -o root -g root -m 0644 "$SERVICE_FILE" /etc/systemd/system/goodos-data-platform.service
systemctl daemon-reload

cd "$COMPOSE_DIR"
docker compose --env-file "$ENV_FILE" pull postgrest
systemctl enable --now goodos-data-platform.service

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 http://127.0.0.1:8300/ >/dev/null; then
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
      "UPDATE backend_data_plane_components SET status='active', health_status='healthy', last_health_check_at=NOW(), updated_at=NOW() WHERE component='postgrest';" >/dev/null
    echo "STATUS=ready"
    echo "COMPONENT=postgrest"
    echo "ENDPOINT=http://127.0.0.1:8300"
    exit 0
  fi
  sleep 2
done

echo "ERROR=PostgREST did not become healthy."
docker compose --env-file "$ENV_FILE" logs --tail 80 postgrest
exit 1
