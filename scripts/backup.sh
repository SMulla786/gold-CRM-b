#!/usr/bin/env bash
# Nightly Postgres backup for Just Udhari, with N-day rotation (default 14).
#
# Env:
#   DATABASE_URL   required — same connection string the app uses
#   BACKUP_DIR     where dumps go (default /var/backups/justudhari)
#   RETENTION_DAYS how many days of dumps to keep (default 14)
#
# Cron (daily 02:00):
#   0 2 * * * DATABASE_URL='postgres://…' BACKUP_DIR=/var/backups/justudhari \
#     /opt/justudhari/backend/scripts/backup.sh >> /var/log/ju-backup.log 2>&1
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/justudhari}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/ju-$(date +%Y%m%d-%H%M%S).dump"

# -Fc = compressed custom format, restored with pg_restore. set -e makes any failure exit non-zero
# so cron emails the error; the size check guards against a silently empty dump.
pg_dump "$DATABASE_URL" -Fc -f "$out"
test -s "$out"

# prune dumps older than the retention window
find "$BACKUP_DIR" -name 'ju-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete
echo "backup ok: $out ($(du -h "$out" | cut -f1)); pruned dumps older than ${RETENTION_DAYS}d"
