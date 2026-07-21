#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
for command_name in createdb dropdb pg_restore psql openssl sha256sum rclone; do require "$command_name"; done

: "${GOODBASE_RESTORE_SOURCE:?GOODBASE_RESTORE_SOURCE is required}"
: "${GOODBASE_BACKUP_ENCRYPTION_KEY_FILE:?GOODBASE_BACKUP_ENCRYPTION_KEY_FILE is required}"
: "${GOODBASE_RESTORE_ADMIN_URL:?GOODBASE_RESTORE_ADMIN_URL is required}"

restore_work_dir="$(mktemp -d /tmp/goodbase-restore.XXXXXX)"
verification_db="goodbase_verify_$(date -u +%Y%m%d%H%M%S)_$RANDOM"
cleanup() {
  dropdb --if-exists --force --maintenance-db="$GOODBASE_RESTORE_ADMIN_URL" "$verification_db" >/dev/null 2>&1 || true
  rm -rf -- "$restore_work_dir"
}
trap cleanup EXIT

encrypted_file="$restore_work_dir/backup.dump.enc"
checksum_file="$encrypted_file.sha256"
plain_file="$restore_work_dir/backup.dump"
rclone copyto "$GOODBASE_RESTORE_SOURCE" "$encrypted_file"
rclone copyto "${GOODBASE_RESTORE_SOURCE}.sha256" "$checksum_file"
expected_checksum="$(cut -d' ' -f1 "$checksum_file")"
actual_checksum="$(sha256sum "$encrypted_file" | cut -d' ' -f1)"
test "$expected_checksum" = "$actual_checksum" || { echo "Backup checksum verification failed." >&2; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -in "$encrypted_file" -out "$plain_file" -pass "file:$GOODBASE_BACKUP_ENCRYPTION_KEY_FILE"

createdb --maintenance-db="$GOODBASE_RESTORE_ADMIN_URL" "$verification_db"
pg_restore --exit-on-error --no-owner --no-acl --dbname="${GOODBASE_RESTORE_ADMIN_URL%/*}/$verification_db" "$plain_file"

verification_url="${GOODBASE_RESTORE_ADMIN_URL%/*}/$verification_db"
psql "$verification_url" -v ON_ERROR_STOP=1 -Atqc "
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM users) > 0 AND
    (SELECT COUNT(*) FROM projects) > 0 AND
    (SELECT COUNT(*) FROM pg_policies) > 0
  THEN 'verified' ELSE 'incomplete' END;
" | grep -qx verified

printf '{"success":true,"database":"%s","integrity":"verified"}\n' "$verification_db"
