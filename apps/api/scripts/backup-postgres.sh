#!/usr/bin/env bash
# Postgres logical dump for urano-api.
# Prefer DATABASE_URL; falls back to standard PG* libpq env vars.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/urano_${TIMESTAMP}.sql.gz"

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "[backup] Dumping via DATABASE_URL → ${OUT_FILE}"
  pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip >"$OUT_FILE"
elif [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" ]]; then
  # Optional: PGUSER, PGPASSWORD, PGPORT (defaults via libpq)
  echo "[backup] Dumping via PG* env (host=${PGHOST} db=${PGDATABASE}) → ${OUT_FILE}"
  pg_dump --no-owner --no-acl | gzip >"$OUT_FILE"
else
  echo "[backup] ERROR: set DATABASE_URL or PGHOST+PGDATABASE (and PGUSER/PGPASSWORD as needed)" >&2
  exit 1
fi

SIZE="$(du -h "$OUT_FILE" | awk '{print $1}')"
echo "[backup] OK ${OUT_FILE} (${SIZE})"
