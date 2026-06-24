#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/team-project-manager.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DB_PATH="${DB_PATH:-/var/lib/team-project-manager/app.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/team-project-manager}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database file not found at $DB_PATH; skipping backup."
  exit 0
fi

stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
tmp_path="$BACKUP_DIR/app.sqlite.$stamp.tmp"
backup_path="$BACKUP_DIR/app.sqlite.$stamp"

cp "$DB_PATH" "$tmp_path"
chmod 600 "$tmp_path"
mv "$tmp_path" "$backup_path"
find "$BACKUP_DIR" -type f -name "app.sqlite.*" -mtime +"$RETENTION_DAYS" -delete

echo "Backed up $DB_PATH to $backup_path."
