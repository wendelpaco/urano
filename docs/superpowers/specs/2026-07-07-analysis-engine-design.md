# Urano — Camada de Análise (colheita do easy-invest)

**Data:** 2026-07-07
**Status:** Aprovado (direção validada em brainstorming)
**Decisão de escopo:** Opção 1 — API de dados + análise, sem multi-usuário. Transações, alertas e cálculo de imposto ficam explicitamente fora deste ciclo.

## 1. Objetivo

Transformar o Urano de "API de dados fundamentalistas" em "API de análise", absorvendo do projeto easy-invest (`~/works/easy-invest`) apenas os módulos de lógica pura que provaram valor, adaptados às fontes de dados superiores do Urano (CVM oficial + Yahoo Finance + BCB).

O que **não** entra: users/JWT, alertas, DARF/imposto, scraping de HTML do StatusInvest, sistema de jobs com scheduler. Motivo registrado no brainstorming: escopo largo matou o easy-invest; Urano não tem consumidor multi-user hoje.

## 2. Entregas (3 ondas)

### Onda 1 — Robustez e dividendos

**1a. `src/shared/retry.ts`** — portar de `easy-invest/server/src/utils/retry.ts`:
- `withRetry(fn, options)` — backoff exponencial configurável
- `withTimeout(promise, ms)` — timeout de promise
- `batchWithConcurrency(items, op, n)` — lotes com limite de concorrência

Aplicar nos fetches existentes: `CvmStorageService.downloadZip`, `StockQuoteService.fetchQuote/fetchHistory`, `fetchBcbSeries` (macro controller). Sem mudança de comportamento externo — apenas resiliência.

**1b. `src/core/services/dividends-analyzer.ts`** — portar `DividendsAnalyzer` (classe estática, zero dependências):
- Métricas: estabilidade (coeficiente de variação), consistência (regularidade de pagamentos), tendência (6m vs 6m anteriores), qualidade 0-100
- Input: `Array<{ date: string; value: number; type: string }>`

**1c. Fonte de proventos por cota** — novo `src/infra/services/dividends-provider.ts`:
- Endpoint JSON do StatusInvest: `GET /acao/companytickerprovents?ticker=X&chartProventsType=2` e `/fii/companytickerprovents`
- Único pedaço do scraper que vale: é API JSON, não parsing de HTML
- Cache Redis 24h (proventos mudam raramente); retry via 1a
- Fallback: se indisponível, endpoints degradam para dados DMPL já existentes (anuais)

**1d. `GET /v1/dividends/:ticker` enriquecido**:
- Resposta atual (DMPL anual) + bloco novo `analysis` (métricas do DividendsAnalyzer sobre proventos mensais) + `monthlyHistory`
- Resolve também o `dividendYield: null` em `/v1/fundamentals/:ticker`: DY = soma proventos 12m / preço atual

### Onda 2 — Motor de análise

**2a. FII score — portar como `src/core/services/fii-score.ts`** + datasets:
- `fii-score.v4.1.ts` (728 l) → lógica intocada (income quality, asset quality, risk com limitadores por subclasse, penalização progressiva, recomendação conservadora, explicação humana)
- Datasets estáticos: `fii-classification.data.ts`, `fii-papel-subclasses.data.ts`, `fii-tijolo-subclasses.data.ts` → `src/core/data/`
- Inputs necessários: price (Yahoo ✅), dy (1d ✅), pvp, liquidez, histórico dividendos (1c ✅), vacância (opcional)
- **Gap conhecido:** P/VP e liquidez de FII não existem no Urano hoje. Fonte: mesmo endpoint de proventos não fornece; usar Yahoo (volume ✅ para liquidez) e P/VP marcado como `null` até fonte confiável — score já trata ausência (valuation neutro 50). Não bloquear onda 2 por isso.

**2b. Score de ações — adaptar `AssetAnalyzer` como `src/core/services/stock-score.ts`**:
- Breakdown 0-100: valuation (P/L, P/VP), rentabilidade (ROE), dividendos (DY), qualidade (setor defensivo)
- **Diferença chave vs easy-invest:** input não é snapshot de scraper e sim `FinancialIndicators` que o Urano já calcula de dados CVM auditados (`fundamentals.controller.ts:calcAllIndicators`) + cotação Yahoo
- Extrair `calcAllIndicators` do controller para `src/core/services/indicators.ts` (reuso sem duplicação)
- Manter `reasons[]` e `alerts[]` — explicabilidade é parte do produto

**2c. Endpoints novos:**
- `GET /v1/analysis/stocks/:ticker` — score + breakdown + reasons + alerts + indicadores
- `GET /v1/analysis/fiis/:ticker` — FIIScoreV4 completo
- `GET /v1/analysis/ranking?type=stock|fii&limit=N` — ranking por score (base: empresas com fundamentals no banco; FIIs da lista conhecida)
- Screener existente ganha `minScore` opcional
- Cache Redis: análise 15 min (depende de cotação), ranking 30 min

### Onda 3 — Fechamento de API

**3a. Middleware de api-key** — `src/infra/http/middleware/auth.ts`:
- Fastify `onRequest` hook: valida header `x-api-key` contra tabela `api_keys` (active=true), atualiza `last_used_at`
- Rotas públicas: `/v1/healthcheck`. Todo o resto exige key
- Corrigir `generateApiKey()`: `crypto.randomBytes` no lugar de `Math.random` (auth.controller.ts:21)
- Cache Redis de keys válidas (TTL 60s) para não bater no banco por request

**3b. Rebalance com posição atual** — conceito do `PortfolioBuilder.suggestRebalancing`:
- `POST /v1/wallets/:walletId/rebalance` aceita opcional `currentPositions: [{ticker, quantity}]` no body
- Resposta passa a preencher `currentQuantity` real e a sugerir SELL quando alocação atual excede alvo
- Sem persistência de posições (isso seria transações — fora de escopo)

## 3. Arquitetura

```
src/
├── core/
│   ├── services/          # NOVO — lógica pura, sem I/O
│   │   ├── dividends-analyzer.ts
│   │   ├── fii-score.ts
│   │   ├── stock-score.ts
│   │   └── indicators.ts        # extraído de fundamentals.controller
│   └── data/              # NOVO — datasets estáticos de classificação FII
├── shared/
│   └── retry.ts           # NOVO
└── infra/
    ├── services/
    │   └── dividends-provider.ts  # NOVO — proventos StatusInvest JSON
    └── http/
        ├── middleware/auth.ts     # NOVO
        └── controllers/analysis.controller.ts  # NOVO
```

Princípio mantido do Urano: `core/services` são funções/classes puras testáveis sem banco nem rede; `infra` faz I/O. Correção de altitude incluída: `calcAllIndicators` sai do controller (hoje viola isso).

## 4. Fluxo de dados (análise de ação)

```
GET /v1/analysis/stocks/PETR4
  → auth middleware (api-key)
  → busca fundamentals mais recente (Drizzle, JOIN companies)     [banco]
  → cotação (StockQuoteService, cache 30s)                        [Yahoo]
  → proventos 12m (DividendsProvider, cache 24h)                  [StatusInvest JSON]
  → indicators.ts calcula FinancialIndicators (agora com DY real)
  → stock-score.ts pontua + reasons + alerts
  → resposta (cache Redis 15 min)
```

FII análogo, trocando fundamentals CVM por datasets de classificação + FIIScoreV4.

## 5. Tratamento de erros

- Fonte externa indisponível → análise degrada, não falha: campos dependentes viram `null`, resposta inclui `dataQuality: { quotes: bool, dividends: bool, fundamentals: bool }`
- Ticker sem fundamentals no banco → 404 com mensagem indicando `worker:sync`
- FII fora da lista de classificação → score calculado com type inferido `tijolo` e `type_source: 'inferred'` (comportamento herdado do easy-invest, já tratado)
- Retry: máx 2 tentativas, backoff 500ms→2s; StatusInvest com rate próprio (1 req/s) para não ser bloqueado

## 6. Testes

Primeiro conjunto de testes do Urano (`bun test`):
- `dividends-analyzer.test.ts` — casos: histórico estável, decrescente, com gaps, vazio (fixtures estáticas)
- `fii-score.test.ts` — golden tests: KNCR11 (cdi_high_grade), XPML11 (shopping), HGLG11 (logística) com inputs fixos → scores esperados
- `stock-score.test.ts` — empresa saudável vs endividada vs prejuízo
- `indicators.test.ts` — validar extração do controller não mudou resultados
- `retry.test.ts` — backoff, timeout, concorrência
- Integração leve: `analysis.controller` com mocks de provider (sem rede)

## 7. Fora de escopo (registrado)

| Item | Motivo |
|---|---|
| Users/JWT/bcrypt | Sem consumidor multi-user; api-key basta |
| Alertas | Depende de users |
| TaxService/DARF | Implementação easy-invest incorreta (tributa venda FII sobre total, ignora isenção 20k); refazer do zero quando houver demanda |
| Scraper HTML StatusInvest | Frágil, fontes do Urano superiores |
| Job scheduler | Worker CLI atual suficiente; cron externo se precisar |
| Persistência de posições/transações | Próximo ciclo, se surgir frontend |

## 8. Riscos

- **Endpoint StatusInvest não documentado** — pode mudar/bloquear. Mitigação: cache 24h, fallback DMPL, rate limit próprio, isolado num provider único
- **Datasets de subclasse FII estáticos** — envelhecem (classificações de 2024/25). Mitigação: aceitável para primeira versão; documentar data no arquivo
- **P/VP de FII ausente** — score de FII menos preciso no início. Mitigação: campo `dataQuality` expõe a lacuna ao consumidor
