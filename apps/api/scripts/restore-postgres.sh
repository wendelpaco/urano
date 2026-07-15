#!/usr/bin/env bash
# Restaura dump gerado por backup-postgres.sh
# Uso:
#   bash scripts/restore-postgres.sh backups/urano_YYYYMMDD....sql.gz
#   CONFIRM=yes bash scripts/restore-postgres.sh backups/urano_....sql.gz
#   CONFIRM=yes RESTORE_DB=urano_restore_test bash scripts/restore-postgres.sh ...
#     → restaura em DB throwaway (recomendado para ritual de teste)
set -euo pipefail

cd "$(dirname "$0")/.."
DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Uso: $0 <arquivo.sql.gz>" >&2
  echo "Requer DATABASE_URL (ou PG*) ou container docker urano-postgres." >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "ATENÇÃO: isto sobrescreve o banco de destino."
  echo "Re-execute com CONFIRM=yes $0 $DUMP"
  echo "Para teste seguro: CONFIRM=yes RESTORE_DB=urano_restore_test $0 $DUMP"
  exit 2
fi

PG_CONTAINER="${PG_CONTAINER:-urano-postgres}"
PG_USER="${POSTGRES_USER:-urano}"
TARGET_DB="${RESTORE_DB:-${POSTGRES_DB:-urano_finbot}}"

echo "[restore] Restaurando $DUMP → db=$TARGET_DB …"

if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" ]] && [[ -z "${RESTORE_DB:-}" ]]; then
  gunzip -c "$DUMP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
elif docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  if [[ -n "${RESTORE_DB:-}" ]]; then
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS ${RESTORE_DB};" \
      -c "CREATE DATABASE ${RESTORE_DB} OWNER ${PG_USER};"
  fi
  gunzip -c "$DUMP" | docker exec -i "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1
  if [[ -n "${RESTORE_DB:-}" && "${KEEP_RESTORE_DB:-}" != "yes" ]]; then
    echo "[restore] drop throwaway ${RESTORE_DB}"
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS ${RESTORE_DB};"
  fi
else
  echo "[restore] ERROR: sem psql local e container $PG_CONTAINER offline" >&2
  exit 1
fi

echo "[restore] OK"
