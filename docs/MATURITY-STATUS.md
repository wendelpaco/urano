# Status de maturidade do produto — Urano

Checklist honesto do que a evolução do monorepo entregou vs. o que ficou conscientemente adiado.  
Última revisão alinhada ao código em `apps/api` / `apps/web` e scripts do monorepo (2026-07).

**Legenda:** **Done** · **Partial** · **Deferred**

---

## Score integrity

| Item | Status | Notas |
|---|---|---|
| Veredito backtest v1 documentado | **Done** | `docs/backtest/2026-07-08-veredito-v1.md` |
| Veredito `quality-filter` (não edge) | **Done** | `SCORE_VALIDATION` + cópia API/MCP/web |
| Persistência de resultados de backtest | **Done** | Worker `backtest` + schema |
| Endpoint de metadados de validação | **Done** | `GET /v1/analysis/validation` |
| Linguagem de produto (não preditor de retorno) | **Done** | OpenAPI, MCP, README, DisclaimerBanner |
| Iteração pesada de pesos pós-veredito | **Deferred** | Veredito recomenda investigar pilares; sem 2ª rodada de reweight obrigatória |
| Benchmark vs IBOV oficial | **Deferred** | Backtest usa média do universo coberto |

---

## Production infra

| Item | Status | Notas |
|---|---|---|
| Dockerfile API (build na raiz do monorepo) | **Done** | `apps/api/Dockerfile` |
| Docker Compose (Postgres 16 + Redis 7) | **Done** | Senhas obrigatórias via `.env`; profile `full` sobe API |
| Runbook local / prod | **Done** | `docs/runbooks/local-and-prod.md` |
| Backup lógico Postgres | **Done** | `bun run backup` → `scripts/backup-postgres.sh` |
| Split API vs worker | **Done** | `start:api-only` + `worker:jobs` |
| Staging / deploy cloud | **Deferred** | Docker+compose prontos; sem ambiente cloud provisionado |
| Secrets em runtime (sem bake na imagem) | **Done** | Documentado no Dockerfile e runbook |

---

## Identity

| Item | Status | Notas |
|---|---|---|
| Auth por `x-api-key` | **Done** | Middleware fail-closed; só `/v1/healthcheck` público |
| Hash SHA-256 de keys no banco | **Done** | Lookup por `key_hash`; script de backfill |
| Segredo não recuperável no DB após create | **Done** | Coluna `key` guarda placeholder `ur_hashonly_*`; plaintext só na resposta HTTP uma vez |
| Scopes RBAC + owner_id em api_keys | **Done** | `read:market`, `write:wallet`, `admin:keys`, `admin:ops`; migration 0014 |
| List/create keys sem dump global | **Done** | Lista só self (+ children se admin:keys); create exige admin:keys |
| Ops endpoints com admin:ops | **Done** | `/metrics`, `/health/scraper` |
| Ownership de carteiras por `apiKeyId` | **Done** | Não confia `userId` do cliente |
| CRUD / rotate de keys autenticado | **Done** | Bootstrap via `bun run key:create` (CLI, full scopes) |
| Rate-limit fail-closed em produção | **Done** | Default `true` quando `NODE_ENV=production` |
| bodyLimit + requestTimeout + trustProxy | **Done** | server.ts |
| Compose bind 127.0.0.1 | **Done** | Postgres/Redis/API não escutam 0.0.0.0 no host |
| API key no `localStorage` do browser | **Partial** | CSP baseline no web; JWT/httpOnly exige multi-user |
| Multi-user JWT / login-senha | **Deferred** | Fora de escopo deliberado (single-operator / api-key) |

---

## Data sources

| Item | Status | Notas |
|---|---|---|
| Fundamentals CVM oficiais (ações) | **Done** | ETL + repositório Postgres |
| Macro BCB | **Done** | Séries SGS públicas |
| Cotações / histórico Yahoo | **Done** | Retry + circuit breaker |
| StatusInvest (proventos, FII, lazy) | **Partial** | Funciona; **scrapers frágeis** — ver `docs/data-sources.md` |
| Hierarquia de confiança documentada | **Done** | `docs/data-sources.md` |
| Dados de mercado pagos / feed B3 | **Deferred** | Custo e escopo |
| Backtest / validação formal de FII | **Deferred** | Pesquisa; sem CVM FII histórico no pipeline |

---

## Compliance

| Item | Status | Notas |
|---|---|---|
| Disclaimer informativo na web | **Done** | `DisclaimerBanner` (dismissível por sessão) |
| Score como filtro, não recomendação CVM | **Done** | Copy + link para `/validation` |
| Enquadramento jurídico Fase 2 pública | **Deferred** | CVM 19/20 — decisão antes de marketing |
| Onboarding leigo / glossário público | **Deferred** | Spec web marcou fora do escopo single-user |

---

## Security residual

| Item | Status | Notas |
|---|---|---|
| Remediation audit V-01..V-13 (auth, ownership, hash, compose, etc.) | **Done** | Plano + testes infra dedicados |
| Security headers | **Done** | nosniff, frame deny, referrer, permissions-policy, no-store |
| Rate limit por API key | **Done** | Redis sliding window (~200/min); `RATE_LIMIT_FAIL_CLOSED` opcional (default fail-open) |
| Audit log de mutações sensíveis | **Done** | Console JSON + tabela `security_audit_log` |
| CORS restrito a `CORS_ORIGIN` | **Done** | Env tipada |
| CI secret scan (gitleaks) + OSV | **Done** | `.github/workflows/ci.yml` |
| Sentry / APM cloud | **Deferred** | Endpoint de métricas existe; sem SaaS de erro/tracing |

---

## Jobs / workers

| Item | Status | Notas |
|---|---|---|
| Job store + scheduler + worker | **Done** | Postgres-backed jobs |
| `SCHEDULER_ENABLED` | **Done** | Env Zod; default true em dev |
| Processo dedicado `worker:jobs` | **Done** | Sem HTTP |
| `worker:sync` CVM | **Done** | One-shot / ETL |
| Seed + warm-cache + daily snapshot | **Done** | Scripts e workers no pacote API |
| Diagnóstico scraper | **Done** | `GET /v1/health/scraper` |

---

## Observability

| Item | Status | Notas |
|---|---|---|
| Request id (`x-request-id`) | **Done** | Aceita inbound ou gera UUID; eco na resposta |
| Access log estruturado (method/url/status/time) | **Done** | Hook `onResponse` + Pino |
| `GET /v1/metrics` (JSON processo) | **Done** | Uptime + memória; auth; **não** Prometheus |
| Data health | **Done** | `GET /v1/health/data` + MCP `get_data_health` |
| Healthcheck público | **Done** | `GET /v1/healthcheck` |
| Sentry cloud / tracing distribuído | **Deferred** | Métricas locais bastam para single-host por ora |

---

## Config

| Item | Status | Notas |
|---|---|---|
| Validação de env com Zod | **Done** | `apps/api/src/config/env.ts` |
| Fail-fast em prod sem `DATABASE_URL` / `REDIS_URL` | **Done** | Sem defaults inseguros em production |
| `.env.example` + compose com senhas obrigatórias | **Done** | Redis requirepass + healthcheck com AUTH |
| Scripts monorepo raiz | **Done** | `dev:api`, `dev:web`, `test`, `typecheck`, `lint` |

---

## Tests

| Item | Status | Notas |
|---|---|---|
| Testes core (score, advisor, health, indicators, …) | **Done** | `apps/api/tests/core/` |
| Testes infra (auth, rate-limit, headers, request-id, ownership, …) | **Done** | `apps/api/tests/infra/` |
| CI: typecheck + `bun test` + web lint/build | **Done** | GitHub Actions |
| Fixture parser StatusInvest | **Done** | HTML de regressão |
| E2E browser / contract OpenAPI automatizado | **Deferred** | Não bloqueia uso single-operator |

---

## OpenAPI

| Item | Status | Notas |
|---|---|---|
| Spec embutida servida em runtime | **Done** | `GET /v1/docs/openapi.json` |
| Rotas principais documentadas (analysis, wallets, macro, …) | **Done** | `docs.controller.ts` |
| `GET /metrics` na spec | **Done** | + nota de request-id / security no `info` |
| Schemas de response completos (JSON Schema rico) | **Partial** | Maioria com descrição textual 200; sem models completos |

---

## Frontend screens

Terminal web (`apps/web`) — entregue para uso single-operator (api-key no client).

| Tela | Rota | Status |
|---|---|---|
| Overview | `/` | **Done** |
| Ranking | `/market` | **Done** |
| Screener | `/market/screener` | **Done** |
| Pesquisa | `/market/search` | **Done** |
| Comparador | `/market/compare` | **Done** |
| Macro | `/market/macro` | **Done** |
| Watchlist | `/watchlist` | **Done** |
| Carteiras | `/portfolio` | **Done** |
| Detalhe de carteira | `/portfolio/$id` | **Done** |
| Proventos / renda | `/portfolio/income` | **Done** |
| Aportes (contribution) | `/portfolio/contribution` | **Done** |
| Alocação modelo | `/portfolio/allocate` | **Done** |
| Research ticker | `/research/$type/$ticker` | **Done** |
| Copilot / AI | `/ai` | **Done** |
| Journal | `/journal` | **Done** |
| Validação do score | `/validation` | **Done** |
| Data Health | `/health` | **Done** |
| Settings | `/settings` | **Done** |

---

## DX

| Item | Status | Notas |
|---|---|---|
| Monorepo Bun workspaces | **Done** | `apps/api`, `apps/web` |
| MCP server (stdio) | **Done** | Tools de análise, aporte, health, explain_score |
| `key:create` / seed / warm-cache / backtest | **Done** | Scripts `package.json` da API |
| Runbook + README quick start | **Done** | Raiz + `docs/runbooks/` |
| Planos/specs em `docs/superpowers/` | **Done** | Histórico de decisão |

---

## Product gaps (explícitos)

| Gap | Status | Por quê |
|---|---|---|
| Validação / backtest de FII | **Deferred** | Sem fundamentals CVM históricos de FII; score permanece heurística |
| Survivorship bias no universo | **Partial** | Limitação **conhecida e documentada** no veredito; sem universo de deslistadas |
| Multi-user JWT | **Deferred** | Identidade atual = API key; sem produto multi-tenant |
| Sentry cloud | **Deferred** | `/v1/metrics` + logs bastam localmente |
| Staging cloud deploy | **Deferred** | Docker+compose prontos; deploy cloud não executado |
| Feed de mercado pago | **Deferred** | Custo; Yahoo + CVM + BCB cobrem uso atual |
| FII backtest como pesquisa | **Deferred** | Candidato: cotas + proventos para total return |

---

## Resumo executivo

| Área | Situação |
|---|---|
| Motor de score + honestidade do veredito | **Done** |
| API + MCP + web single-operator | **Done** |
| Segurança de api-key / ownership | **Done** |
| Infra container local | **Done** |
| Observabilidade SaaS / deploy cloud / multi-user | **Deferred** |
| Fontes scrapadas e FII formal | **Partial / Deferred** |

Tudo que foi implementado nas ondas de análise, validação, segurança, monorepo web, jobs e métricas está marcado **Done** acima. Itens **Deferred** são escolhas de escopo, não regressões.
