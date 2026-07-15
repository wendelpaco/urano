#!/usr/bin/env bash
# Postgres logical dump for urano-api.
# Prefer host pg_dump; fallback para docker exec no container urano-postgres.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/urano_${TIMESTAMP}.sql.gz"
PG_CONTAINER="${PG_CONTAINER:-urano-postgres}"
PG_USER="${POSTGRES_USER:-urano}"
PG_DB="${POSTGRES_DB:-urano_finbot}"

dump_host() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "[backup] Dumping via DATABASE_URL (host pg_dump) → ${OUT_FILE}"
    pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip >"$OUT_FILE"
  else
    echo "[backup] Dumping via PG* env (host=${PGHOST} db=${PGDATABASE}) → ${OUT_FILE}"
    pg_dump --no-owner --no-acl | gzip >"$OUT_FILE"
  fi
}

dump_docker() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    echo "[backup] ERROR: container $PG_CONTAINER não está rodando e pg_dump local indisponível" >&2
    exit 1
  fi
  echo "[backup] Dumping via docker $PG_CONTAINER → ${OUT_FILE}"
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --no-acl | gzip >"$OUT_FILE"
}

if command -v pg_dump >/dev/null 2>&1 && { [[ -n "${DATABASE_URL:-}" ]] || [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" ]]; }; then
  dump_host
else
  dump_docker
fi

SIZE="$(du -h "$OUT_FILE" | awk '{print $1}')"
echo "[backup] OK ${OUT_FILE} (${SIZE})"
