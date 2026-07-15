# Status de maturidade do produto — Urano

Checklist honesto alinhado ao código (2026-07, pós ondas de segurança + dados free + backtest FII).

**Legenda:** **Done** · **Partial** · **Deferred**

---

## Score integrity

| Item | Status | Notas |
|---|---|---|
| Veredito backtest v1 documentado | **Done** | `docs/backtest/2026-07-08-veredito-v1.md` |
| Veredito `quality-filter` | **Done** | `SCORE_VALIDATION` + UI/MCP |
| Persistência backtest ações | **Done** | `backtest_results` + `backtest_strategy_years` (vs IBOV) |
| IBOV real (Yahoo ^BVSP) | **Done** | Validation + worker + web benchmarks |
| DY/momentum reais no backtest ações | **Done** | DMPL CVM + preços na data do score |
| Freeze veredito a partir do DB | **Done** | `bun run freeze-verdict` → `docs/backtest/LATEST-RUN.json` |
| Re-rodar e alinhar JSON estático ao último run | **Done** | `bun run freeze-verdict --apply` atualiza `SCORE_VALIDATION.topN` |
| Iteração de pesos / edge | **Deferred** | Veredito atual = quality-filter |
| Score FII histórico look-ahead free | **Partial** | TR + DY→TR free; score no tempo ainda não |

---

## Production infra

| Item | Status | Notas |
|---|---|---|
| Dockerfile + compose (127.0.0.1) | **Done** | |
| Backup + **restore** script | **Done** | `backup` / `restore` com `CONFIRM=yes` |
| Pipeline de dados orquestrado | **Done** | `pipeline:data` / `pipeline:data:full` |
| Runbook data pipeline | **Done** | `docs/runbooks/data-pipeline.md` |
| Split API / worker | **Done** | |
| Staging cloud + TLS | **Deferred** | |
| Restore testado nos últimos 30 dias | **Partial** | Script existe; ritual humano |

---

## Identity & security

| Item | Status | Notas |
|---|---|---|
| Auth fail-closed, scopes, hash-only keys | **Done** | |
| Ownership wallets | **Done** | |
| Rate limit fail-closed em prod | **Done** | |
| Headers / bodyLimit / requestId | **Done** | |
| Key no localStorage | **Partial** | Single-operator; JWT se multi-user |
| Multi-user JWT | **Deferred** | |

---

## Data sources (free)

| Item | Status | Notas |
|---|---|---|
| CVM ações | **Done** | |
| CVM FII mensal + link ticker | **Done** | `worker:fii-cvm`, `worker:fii-link` |
| BCB macro expandido | **Done** | |
| Yahoo preço + IBOV | **Done** | |
| Proventos canônicos | **Done** | `dividend_events` |
| Backtest FII total return | **Done** | `backtest:fii` — sem rank por score atual |
| StatusInvest scrape | **Partial** | Ranking/screener preferem CVM+cache; scrape só em gap |
| Feed B3 pago | **Deferred** | |

---

## Tests & CI

| Item | Status | Notas |
|---|---|---|
| Unit API (~157) | **Done** | |
| Typecheck + lint + OSV + gitleaks + web build | **Done** | CI |
| Integração DB/workers no CI | **Done** | CI: Postgres+Redis services, migrate, `tests/integration/` |
| E2E browser | **Deferred** | |

---

## Frontend

| Item | Status | Notas |
|---|---|---|
| Terminal completo (ranking…journal) | **Done** | |
| Benchmarks + validação + IBOV | **Done** | |
| Painel fiiBacktest na validação | **Done** | após este ciclo |
| Copilot = roteador API (não LLM) | **Done** | Honesto |

---

## Product / compliance

| Item | Status | Notas |
|---|---|---|
| Disclaimer quality-filter | **Done** | |
| CVM 19/20 marketing | **Deferred** | |
| Multi-tenant SaaS | **Deferred** | |

---

## Gates de maturidade (evidência)

- [x] Scripts pipeline + backup/restore  
- [x] Workers dados free documentados  
- [x] Backtest ações/FII + IBOV no código  
- [ ] Pipeline `--full` rodado e `LATEST-RUN.json` no seu ambiente  
- [ ] Restore testado 1×  
- [ ] Staging TLS  
- [x] Integração CI com Postgres (workflow + smoke)  


---

*Atualizar este arquivo quando gates manuais forem cumpridos.*
