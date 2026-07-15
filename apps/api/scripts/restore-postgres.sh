#!/usr/bin/env bash
# Restaura dump gerado por backup-postgres.sh
# Uso:
#   bash scripts/restore-postgres.sh backups/urano_YYYYMMDD....sql.gz
#   CONFIRM=yes bash scripts/restore-postgres.sh backups/urano_....sql.gz
set -euo pipefail

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Uso: $0 <arquivo.sql.gz>" >&2
  echo "Requer DATABASE_URL (ou PG*) apontando para o DB de destino." >&2
  exit 1
fi

if [[ -f "$(dirname "$0")/../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/../.env"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" && -z "${PGHOST:-}" ]]; then
  echo "ERROR: defina DATABASE_URL ou PGHOST+PGDATABASE" >&2
  exit 1
fi

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "ATENÇÃO: isto sobrescreve o banco de destino."
  echo "Re-execute com CONFIRM=yes $0 $DUMP"
  exit 2
fi

echo "[restore] Restaurando $DUMP …"
if [[ -n "${DATABASE_URL:-}" ]]; then
  gunzip -c "$DUMP" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
else
  gunzip -c "$DUMP" | psql -v ON_ERROR_STOP=1
fi
echo "[restore] OK"
