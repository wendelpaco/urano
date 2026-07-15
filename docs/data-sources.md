# Fontes de dados — Urano

Hierarquia de confiança e uso no monorepo. O score de ações é um **filtro de qualidade fundamentalista** (`quality-filter`), não preditor de retorno — ver [veredito backtest v1](backtest/2026-07-08-veredito-v1.md).

## Hierarquia (preferir o mais alto)

| Prioridade | Fonte | Uso principal | Confiabilidade |
|---|---|---|---|
| 1 | **CVM / B3 (oficial)** | Fundamentals (ETL **mensal**); FII informe; universo B3 | Alta — base do score de ações |
| 2 | **BCB** | Séries macro (Selic, IPCA, câmbio, etc.) via API SGS pública | Alta — séries oficiais |
| 3 | **Investidor10 (JSON)** | **Primária de cotação/histórico** (`batch`, `chart`); não substitui CVM | Média — API não documentada; rate limit + circuit |
| 4 | **Yahoo Finance** | Fallback cotação/histórico OHLCV, **IBOV (`^BVSP`)**, volume | Média — gratuito, sem SLA |
| 5 | **StatusInvest** | Proventos (`dividend_events`), indicadores FII, **último** fallback de cotação | Baixa/média — HTML frágil; 429 frequentes |

### Pacote A (free-only) — implementado

- Cotação/histórico com `source` + `asOf` (`investidor10` \| `yahoo` \| `statusinvest`)
- Cadeia de mercado: **Investidor10 → Yahoo → StatusInvest** (`stock-quote-service`)
- `GET /v1/benchmarks` e `/v1/benchmarks/:id` (IBOV; IFIX experimental)
- Proventos: Redis → Postgres `dividend_events` (24h) → StatusInvest
- Macro BCB expandido (CDI, IGP-M, SELIC diária, desemprego, …) com `source: bcb_sgs`
- **Sem APIs pagas** (brapi etc. fora do caminho crítico)

### Estatísticas fortes + CVM FII — implementado

- `backtest_strategy_years`: top-N vs universo vs IBOV **ano a ano** (persistido no `bun run backtest`)
- `GET /v1/analysis/validation` lê série persistida (`strategy`) + IBOV live
- **CVM FII** Informe Mensal: `bun run worker:fii-cvm [ano]` → `fii_cvm_monthly`
- `GET /v1/fiis/:ticker/cvm` — PL / cotas / VP por cota oficiais
- **Link CNPJ↔ticker**: `bun run worker:fii-link` (auto após fii-cvm)
- **P/VP FII**: prioridade `price / navPerShare` CVM; fallback StatusInvest
- **Total return FII**: `GET /v1/fiis/:ticker/total-return` (cota Yahoo + proventos)
- **Backtest ações**: DY via DMPL CVM; momentum 3M/6M com preços reais na data do score
- **Backtest FII total return**: `bun run backtest:fii` → `fii_backtest_years` + correlação DY→TR+1
- Validação: campo `fiiBacktest` no `GET /analysis/validation` após o worker

Regra prática: indicadores de score de **ações** vêm de fundamentals CVM + preço Yahoo; macro vem do BCB; scrapers preenchem lacunas (FIIs, proventos, lazy load) e **nunca** substituem CVM quando CVM existe.

## Por domínio

### Fundamentals (ações)

- **Primário:** ETL CVM (`cvm-storage-service`, `worker:sync`) → Postgres `company_fundamentals`.
- **Indicadores:** calculados em core a partir dos fundamentals oficiais + cotação.
- **Sanidade:** `metric-sanity` marca anomalias absurdas (ex.: P/L > 1000) sem rejeitar a linha.

### Cotações e histórico

- **Primário (rede):** Investidor10 JSON
  - `GET https://investidor10.com.br/api/cotacoes/batch?tickers=PRIO3,PETR4`
  - `GET https://investidor10.com.br/api/cotacoes/acao/chart/PRIO3/`
- **Fallback 1:** Yahoo Finance (símbolo `.SA`, OHLCV completo).
- **Fallback 2:** StatusInvest scrape (último recurso).
- Cache Redis (~5 min quote, ~30 min history).
- IBOV / índices: Yahoo (`^BVSP`) — fora do path de ações B3.

### Macro

- **Única fonte:** API pública do Banco Central (`api.bcb.gov.br` SGS).
- Cache Redis ~1h.

### Proventos

- StatusInvest JSON API (`dividends-provider`) — JSON estável o suficiente, mas ainda dependente de terceiro não oficial.

### FIIs

- Classificação/subclasses: datasets estáticos + StatusInvest / documentos de fundo.
- Cotação/histórico: Yahoo + scraper.
- Operacional (vacância, imóveis): scraper StatusInvest.
- **Score FII:** heurística operacional; **total return real** e correlação **DY(Y)→TR(Y+1)** via `bun run backtest:fii` (não prova edge do score histórico).
- P/VP oficial quando há CVM (`navPerShare`); proventos + cota Yahoo para TR.

## Score e quality-filter

- Veredito de ações (2015–2024): **`quality-filter`** — filtra casos fracos; **não** prova edge de retorno monotônico.
- Linguagem de produto (API, MCP, web): triagem fundamentalista, não recomendação de timing.
- Limitações documentadas no veredito: survivorship bias (só listadas hoje), amostra pequena, pilares sem variância no backtest, ausência de IBOV oficial como benchmark.

## Fragilidade de scrapers

| Risco | Mitigação atual |
|---|---|
| HTML/layout StatusInvest muda | Parse isolado + testes de fixture; circuit breaker e rate limiter |
| Bloqueio / rate limit de terceiros | Limiters centralizados, retry com backoff, pool de User-Agent |
| Dados lixo / outliers | `metric-sanity`, data health (`GET /v1/health/data`), warnings no contribution advisor |
| Dependência de API não documentada (Yahoo) | Retry + circuit breaker; jobs contam skips |

**Não** tratar scraper como fonte de verdade para balanço/DRE de ações. Dados pagos de mercado (feed oficial B3, provedor fundamentalista comercial) estão **fora de escopo** até decisão de custo.

## Onde o código vive (referência)

| Fonte | Principais módulos |
|---|---|
| CVM | `apps/api/src/infra/services/cvm-storage-service.ts`, `workers/cvm-sync-worker.ts` |
| BCB | `apps/api/src/infra/http/controllers/macro.controller.ts` |
| Investidor10 | `investidor10-provider.ts` (batch + chart) |
| Yahoo / cadeia de quote | `stock-quote-service.ts`, `market-data-service.ts` |
| StatusInvest | `statusinvest-scraper.ts`, `dividends-provider.ts`, `scrapers/statusinvest-parse.ts` |
| Lazy / composição | `lazy-data-service.ts` |

## Leitura relacionada

- [Veredito backtest v1](backtest/2026-07-08-veredito-v1.md)
- [Maturity status](MATURITY-STATUS.md)
- [Runbook local/prod](runbooks/local-and-prod.md)
