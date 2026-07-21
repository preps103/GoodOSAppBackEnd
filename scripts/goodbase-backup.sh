#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

require() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
require pg_dump
require openssl
require sha256sum
require rclone

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${GOODBASE_BACKUP_ENCRYPTION_KEY_FILE:?GOODBASE_BACKUP_ENCRYPTION_KEY_FILE is required}"
: "${GOODBASE_BACKUP_PRIMARY_REMOTE:?GOODBASE_BACKUP_PRIMARY_REMOTE is required}"

test -r "$GOODBASE_BACKUP_ENCRYPTION_KEY_FILE" || { echo "Backup encryption key is unreadable." >&2; exit 1; }

backup_work_dir="$(mktemp -d /tmp/goodbase-backup.XXXXXX)"
cleanup() { rm -rf -- "$backup_work_dir"; }
trap cleanup EXIT

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
hostname_safe="$(hostname | tr -cd 'A-Za-z0-9._-')"
base_name="goodbase-${hostname_safe}-${timestamp}.dump"
plain_file="$backup_work_dir/$base_name"
encrypted_file="$plain_file.enc"
checksum_file="$encrypted_file.sha256"

pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$plain_file"
pg_restore --list "$plain_file" >/dev/null
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 \
  -in "$plain_file" -out "$encrypted_file" -pass "file:$GOODBASE_BACKUP_ENCRYPTION_KEY_FILE"
sha256sum "$encrypted_file" >"$checksum_file"

rclone copyto "$encrypted_file" "${GOODBASE_BACKUP_PRIMARY_REMOTE%/}/$(basename "$encrypted_file")" --checksum
rclone copyto "$checksum_file" "${GOODBASE_BACKUP_PRIMARY_REMOTE%/}/$(basename "$checksum_file")" --checksum

if [[ -n "${GOODBASE_BACKUP_SECONDARY_REMOTE:-}" ]]; then
  rclone copyto "$encrypted_file" "${GOODBASE_BACKUP_SECONDARY_REMOTE%/}/$(basename "$encrypted_file")" --checksum
  rclone copyto "$checksum_file" "${GOODBASE_BACKUP_SECONDARY_REMOTE%/}/$(basename "$checksum_file")" --checksum
fi

size_bytes="$(wc -c <"$encrypted_file" | tr -d ' ')"
checksum="$(cut -d' ' -f1 "$checksum_file")"
printf '{"success":true,"object":"%s","checksumSha256":"%s","sizeBytes":%s,"encrypted":true}\n' \
  "$(basename "$encrypted_file")" "$checksum" "$size_bytes"
