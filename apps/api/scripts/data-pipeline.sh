#!/usr/bin/env bash
# Orquestra o pipeline de dados free do Urano (single-operator).
# Uso (a partir de apps/api, com .env carregado):
#   bash scripts/data-pipeline.sh
#   bash scripts/data-pipeline.sh --quick     # sem backtests longos
#   bash scripts/data-pipeline.sh --full      # inclui backtest ações + FII
#
# Pré: bun install, docker postgres/redis up, .env com DATABASE_URL/REDIS_URL
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

MODE="${1:---quick}"
if [[ "$MODE" != "--quick" && "$MODE" != "--full" ]]; then
  MODE="--quick"
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[pipeline $(ts)] $*"; }

log "Urano data pipeline START mode=$MODE cwd=$ROOT"

log "1/7 migrate"
bun run db:migrate

YEAR="$(date -u +%Y)"
PREV=$((YEAR - 1))

log "2/7 CVM FII informe mensal ($PREV $YEAR)"
bun run worker:fii-cvm "$PREV" "$YEAR" || log "WARN fii-cvm falhou (rede/CVM) — seguindo"

log "3/7 link CNPJ ↔ ticker FII"
bun run worker:fii-link || log "WARN fii-link falhou — seguindo"

log "4/7 warm-cache scores (opcional)"
bun run warm-cache || log "WARN warm-cache falhou — seguindo"

if [[ "$MODE" == "--full" ]]; then
  log "5/7 backtest ações (longo, rede Yahoo)"
  bun run backtest || log "WARN backtest ações falhou"

  log "6/7 backtest FII total return"
  bun run backtest:fii || log "WARN backtest:fii falhou"

  log "7/7 freeze veredito a partir do DB (se houver runs)"
  bun run scripts/freeze-verdict.ts || log "WARN freeze-verdict skip"
else
  log "5-7 skip backtests (use --full)"
fi

log "OK pipeline finished mode=$MODE"
log "Próximo: bun run backup  |  health: curl -s localhost:3000/v1/healthcheck"
