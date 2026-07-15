# Fontes de dados — Urano

Hierarquia de confiança e uso no monorepo. O score de ações é um **filtro de qualidade fundamentalista** (`quality-filter`), não preditor de retorno — ver [veredito backtest v1](backtest/2026-07-08-veredito-v1.md).

## Hierarquia (preferir o mais alto)

| Prioridade | Fonte | Uso principal | Confiabilidade |
|---|---|---|---|
| 1 | **CVM / B3 (oficial)** | Fundamentals de empresas listadas (DRE/BPA/BPP/DFC via dados públicos CVM); universo de tickers B3 | Alta — base do score de ações |
| 2 | **BCB** | Séries macro (Selic, IPCA, câmbio, etc.) via API SGS pública | Alta — séries oficiais |
| 3 | **Yahoo Finance** | Cotações, histórico OHLCV, **IBOV (`^BVSP`)**, momento, volume | Média — gratuito, sem SLA; circuit breaker + retry |
| 4 | **StatusInvest (scraper / JSON)** | Proventos (persistidos em `dividend_events`), indicadores FII, fallback de cotação | Baixa/média — **scrapers frágeis**; HTML e endpoints mudam sem aviso |

### Pacote A (free-only) — implementado

- Cotação/histórico com `source` + `asOf` (`statusinvest` | `yahoo`)
- `GET /v1/benchmarks` e `/v1/benchmarks/:id` (IBOV; IFIX experimental)
- Proventos: Redis → Postgres `dividend_events` (24h) → StatusInvest
- Macro BCB expandido (CDI, IGP-M, SELIC diária, desemprego, …) com `source: bcb_sgs`
- **Sem APIs pagas** (brapi etc. fora do caminho crítico)

Regra prática: indicadores de score de **ações** vêm de fundamentals CVM + preço Yahoo; macro vem do BCB; scrapers preenchem lacunas (FIIs, proventos, lazy load) e **nunca** substituem CVM quando CVM existe.

## Por domínio

### Fundamentals (ações)

- **Primário:** ETL CVM (`cvm-storage-service`, `worker:sync`) → Postgres `company_fundamentals`.
- **Indicadores:** calculados em core a partir dos fundamentals oficiais + cotação.
- **Sanidade:** `metric-sanity` marca anomalias absurdas (ex.: P/L > 1000) sem rejeitar a linha.

### Cotações e histórico

- **Primário:** Yahoo Finance (símbolo `.SA`).
- **Fallback / enriquecimento:** StatusInvest quando Yahoo falha ou no fluxo lazy scrape.
- Cache Redis (TTL curto a médio) para reduzir chamadas.

### Macro

- **Única fonte:** API pública do Banco Central (`api.bcb.gov.br` SGS).
- Cache Redis ~1h.

### Proventos

- StatusInvest JSON API (`dividends-provider`) — JSON estável o suficiente, mas ainda dependente de terceiro não oficial.

### FIIs

- Classificação/subclasses: datasets estáticos + StatusInvest / documentos de fundo.
- Cotação/histórico: Yahoo + scraper.
- Operacional (vacância, imóveis): scraper StatusInvest.
- **Score FII não foi backtestado** — sem fundamentals CVM históricos de FII no pipeline atual; permanece heurística / qualidade de dados limitada (`dataQuality` no endpoint de análise). Validação formal = pesquisa futura.

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
| Yahoo | `apps/api/src/infra/services/stock-quote-service.ts`, `market-data-service.ts` |
| StatusInvest | `statusinvest-scraper.ts`, `dividends-provider.ts`, `scrapers/statusinvest-parse.ts` |
| Lazy / composição | `lazy-data-service.ts` |

## Leitura relacionada

- [Veredito backtest v1](backtest/2026-07-08-veredito-v1.md)
- [Maturity status](MATURITY-STATUS.md)
- [Runbook local/prod](runbooks/local-and-prod.md)
