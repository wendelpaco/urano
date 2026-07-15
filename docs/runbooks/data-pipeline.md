# Runbook — pipeline de dados (free)

Objetivo: deixar o ciclo **reexecutável e comprovável** (maturidade pós-MVP).

## Pré-requisitos

```bash
cd apps/api
# .env com DATABASE_URL, REDIS_URL, POSTGRES_PASSWORD, REDIS_PASSWORD
docker compose --env-file .env up -d
bun install   # na raiz do monorepo
```

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bash scripts/data-pipeline.sh` | migrate + CVM FII + link + warm-cache |
| `bash scripts/data-pipeline.sh --full` | acima + `backtest` + `backtest:fii` + freeze |
| `bun run backup` | dump Postgres → `backups/*.sql.gz` |
| `CONFIRM=yes bash scripts/restore-postgres.sh backups/FILE.sql.gz` | restore (destrutivo) |
| `bun run scripts/freeze-verdict.ts` | grava `docs/backtest/LATEST-RUN.json` |

Na raiz do monorepo:

```bash
bun run pipeline:data        # quick
bun run pipeline:data:full   # full
```

## Checklist semanal (evidência de maturidade)

- [ ] `data-pipeline.sh` rodou sem erro crítico  
- [ ] `GET /v1/healthcheck` → `status: ok`  
- [ ] `GET /v1/health/data` (auth) sem warnings graves  
- [ ] Backup gerado e, a cada 30 dias, restore testado em DB throwaway  
- [ ] Após `--full`: `docs/backtest/LATEST-RUN.json` atualizado  
- [ ] Validation API mostra `strategy` e/ou `fiiBacktest`  

## Ordem lógica dos workers

```text
db:migrate
  → worker:fii-cvm (anos)
  → worker:fii-link
  → warm-cache
  → backtest          # ações + strategy years + IBOV
  → backtest:fii      # total return FII
  → freeze-verdict
```

## Incidentes

| Sintoma | Ação |
|---------|------|
| Yahoo 429 / circuit open | Esperar; rate limit; re-rodar backtest depois |
| CVM zip falha | Retry; checar URL dados.cvm.gov.br |
| FII sem ticker | `worker:fii-link`; revisar nomes em seed |
| Validation sem strategy | Rodar `bun run backtest` |
| Validation sem fiiBacktest | Rodar `bun run backtest:fii` |
