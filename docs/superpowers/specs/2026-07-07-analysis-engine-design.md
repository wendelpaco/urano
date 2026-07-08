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

## 9. Contratos de API

### 9a. GET /v1/dividends/:ticker (enriquecido — Onda 1d)

Resposta atual (seção atual `data` com DMPL anual) + dois blocos novos:

```typescript
// Response (200)
{
  ticker: string;
  companyName: string;
  source: string;
  total: number;
  totalValuePerShare: number;
  data: Array<{ fiscalYear: number; type: 'DIVIDEND' | 'JCP'; totalValue: number; valuePerShare: number; payoutRatio: number | null }>;
  // ↓ NOVO
  monthlyHistory: Array<{
    date: string;        // "2025-06-15"
    value: number;       // valor por cota
    type: string;        // "DIVIDEND" | "JCP" | "RENDIMENTO" | "AMORTIZACAO"
    ticker: string;
  }>;
  analysis: {
    stability: number;        // 0-1, coeficiente de variação invertido
    consistency: number;      // 0-1, regularidade de pagamentos
    trend: number;            // -1 a 1, tendência 6m vs 6m anterior
    quality: number;          // 0-100, score composto
    period: { start: string; end: string };
  } | null;  // null se sem dados de proventos
  dataQuality: {
    dividends: boolean;       // true = StatusInvest disponível
    dmplFallback: boolean;    // true = dados são DMPL (anual, não mensal)
  };
}
```

### 9b. GET /v1/analysis/stocks/:ticker (Onda 2c)

```typescript
// Response (200)
{
  ticker: string;
  companyName: string;
  cnpj: string;
  score: number;                  // 0-100
  breakdown: {
    valuation:    { score: number; weight: number };  // P/L, P/VP, P/S
    profitability:{ score: number; weight: number };  // ROE, margens
    dividends:    { score: number; weight: number };  // DY, payout, estabilidade
    quality:      { score: number; weight: number };  // setor defensivo, consistência
  };
  reasons: string[];              // explicações humanas
  alerts: string[];               // pontos de atenção
  indicators: FinancialIndicators; // reusa interface existente, agora com DY real
  price: number | null;
  dataQuality: {
    quotes: boolean;
    dividends: boolean;
    fundamentals: boolean;
  };
}

// Erros
// 404: { error: "NotFound", message: "Fundamentos não encontrados para \"XXXX3\". Execute worker:sync primeiro." }
// 503: { error: "ServiceUnavailable", message: "...", dataQuality: {...} }
```

### 9c. GET /v1/analysis/fiis/:ticker (Onda 2c)

```typescript
// Response (200)
{
  ticker: string;
  name: string;
  type: string;                       // "tijolo" | "papel" | "fundo_de_fundos" | "hibrido"
  typeSource: 'classified' | 'inferred';
  subclass: string;                   // "logistica" | "shopping" | "lajes_corporativas" | ...
  score: number;                      // 0-100
  breakdown: {
    incomeQuality:  { score: number; weight: number; details: string };
    assetQuality:   { score: number; weight: number; details: string };
    risk:           { score: number; weight: number; details: string };
  };
  recommendation: 'conservador' | 'moderado' | 'arriscado';
  explanation: string;                // resumo humano da recomendação
  dataQuality: {
    quotes: boolean;
    dividends: boolean;
    pvp: boolean;                     // sempre false até fonte confiável
    classification: boolean;          // false se tipo inferido
  };
  price: number | null;
  dividendYield: number | null;       // DY 12m (de proventos mensais + preço)
  pvp: number | null;                 // sempre null na Onda 2
  liquidity: number | null;           // volume médio diário (Yahoo)
}
```

### 9d. GET /v1/analysis/ranking (Onda 2c)

```typescript
// Query params: type=stock|fii, limit=10 (default), minScore (opcional, 0-100)
// Response (200)
{
  type: 'stock' | 'fii';
  total: number;
  filters: { minScore: number | null; limit: number };
  data: Array<{
    ticker: string;
    name: string;
    score: number;
    recommendation?: string;   // apenas FII
    type?: string;             // apenas FII (subclasse)
  }>;
}
```

### 9e. POST /v1/wallets/:walletId/rebalance (estendido — Onda 3b)

```typescript
// Body (currentPositions é opcional)
{
  availableAmount: number;  // obrigatório
  currentPositions?: Array<{
    ticker: string;
    quantity: number;
  }>;
}

// Response (200) — adiciona currentQuantity e sugestão SELL
{
  walletId: string;
  availableAmount: number;
  suggestions: Array<{
    ticker: string;
    action: 'BUY' | 'SELL' | 'HOLD';   // NOVO: antes só existia BUY implícito
    targetAllocation: number;
    currentQuantity: number | null;     // NOVO
    targetQuantity: number;
    suggestedQuantity: number;
    estimatedCost: number;
    reason: string;
  }>;
}
```

## 10. Modelagem de dados e migrations

### 10a. Estrutura atual já existente

`api_keys` já tem `last_used_at` (timestamp). A migration é só de código:
o middleware de auth passa a escrever nesse campo a cada request autenticado.

### 10b. Cache keys (Redis)

| Padrão | TTL | Conteúdo |
|---|---|---|
| `quote:{ticker}` | 30s | `StockQuote` serializado (já existe) |
| `dividends:{ticker}` | 24h | `Array<MonthlyDividend>` do StatusInvest |
| `analysis:stock:{ticker}` | 15min | Resposta completa de `/v1/analysis/stocks/:ticker` |
| `analysis:fii:{ticker}` | 15min | Resposta completa de `/v1/analysis/fiis/:ticker` |
| `analysis:ranking:{type}:{hash}` | 30min | Ranking serializado (hash = query params) |
| `apikey:valid:{key}` | 60s | `boolean` — lookup rápido sem query no banco |
| `apikey:valid-set` | 60s | `Set<string>` — todas as keys ativas (carga em bloco) |

### 10c. Rate limiter (StatusInvest)

Provider isolado com controle interno:
- Máximo 1 requisição por segundo para o domínio `statusinvest.com.br`
- Implementado como token bucket em memória (não Redis — single-instance basta)
- Se o bucket esgotar, operação aguarda (não rejeita) até liberar

## 11. Requisitos não-funcionais

| Dimensão | Alvo | Observação |
|---|---|---|
| Latência `/v1/analysis/stocks/:ticker` (cache hit) | p50 < 10ms | Redis local, dado serializado |
| Latência `/v1/analysis/stocks/:ticker` (cache miss) | p95 < 2s | 2 fontes externas + cálculo local |
| Latência `/v1/analysis/fiis/:ticker` (cache miss) | p95 < 3s | proventos + cotação + score (mais pesado) |
| Degradação tolerada | 1 fonte externa fora → resposta parcial | `dataQuality` sinaliza; nunca 500 por dependência externa |
| Throughput (api-key autenticado) | 100 req/s sustentado | Benchmark com `bun`; sem DB por request (cache Redis de keys) |
| Precisão numérica | 2 casas decimais para valores monetários, 4 para scores | Consistente com `FinancialIndicators` existente |

## 12. Segurança

### 12a. Correção de geração de API key (Onda 3a)

Vulnerabilidade atual (`auth.controller.ts:21`): `Math.random()` é pseudo-aleatório e previsível
— entropia efetiva de ~48 bits (6 chars × 8 posições × 4 segmentos, mas `Math.random` reduz a ~32 bits).

Correção:
```typescript
import crypto from 'node:crypto';

function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () =>
    crypto.randomBytes(6).toString('hex')  // 12 chars hex por segmento
  );
  return `ur_${segments.join('_')}`;
}
```
Entropia resultante: 192 bits (48 hex chars × 4 bits). Prefixo `ur_` mantido.

⚠️ **Breaking change**: keys existentes permanecem válidas (coluna `key` é string, sem constraint de formato),
mas novas keys terão formato diferente. Documentar no changelog.

### 12b. Rate limiting por API key

Não implementado na Onda 3 (escopo extra). Se necessário, adicionar middleware com Redis:
- Janela deslizante de 1 minuto, 100 req/key
- Excedido → 429 com header `Retry-After`
- Decisão: postergar até primeiro abuso reportado

### 12c. Secrets

- `REDIS_URL` e `DATABASE_URL` já estão em `.env` (não versionado)
- Nenhum secret novo é introduzido (StatusInvest é endpoint público)

## 13. Dependências e ordem de execução

```
Onda 1 ─────────────────────────────┐
  ├─ 1a (retry.ts) ── sem dep.      │
  ├─ 1b (dividends-analyzer) ── sem │
  ├─ 1c (dividends-provider) ── 1a  │ Bloqueia 1d e 2b (DY real)
  └─ 1d (dividends enriquecido) ── 1b + 1c
                                     │
Onda 2 ─────────────────────────────┤
  ├─ extrair indicators.ts ── sem   │
  ├─ 2a (fii-score + datasets) ── 1d (precisa de DY)
  ├─ 2b (stock-score) ── indicators.ts + 1d (DY)
  └─ 2c (endpoints analysis) ── 2a + 2b + 1a (cache Redis)
                                     │
Onda 3 ─────────────────────────────┘
  ├─ 3a (api-key middleware) ── sem dep. das ondas anteriores
  └─ 3b (rebalance c/ posição) ── sem dep.
```

## 14. Aceitação por onda

### Onda 1 — Critérios de aceite
- [ ] `withRetry` aplicado em `CvmStorageService.downloadZip`, `StockQuoteService.fetchQuote/fetchHistory`, `fetchBcbSeries`
- [ ] `withTimeout` em todas as chamadas externas (mín. 10s)
- [ ] `DividendsAnalyzer` portado com zero dependências externas
- [ ] Testes passam: estabilidade 0.98+ para KNCR11, <0.3 para empresa com gap
- [ ] `GET /v1/dividends/:ticker` inclui `monthlyHistory` e `analysis` (não-null para tickers com proventos)
- [ ] `GET /v1/fundamentals/:ticker` retorna `dividendYield` preenchido (≠ null) quando há proventos 12m + cotação
- [ ] StatusInvest indisponível → resposta degrada com `dataQuality.dividends: false`, sem 500
- [ ] Cache Redis de proventos respeita TTL 24h

### Onda 2 — Critérios de aceite
- [ ] `indicators.ts` produz os mesmos resultados que `calcAllIndicators` original (golden tests)
- [ ] `stock-score.ts` para WEGE3 (saudável, ROE alto) → score > 70
- [ ] `stock-score.ts` para empresa com prejuízo → score < 30, `alerts` inclui "prejuízo"
- [ ] `fii-score.ts` para KNCR11 (CDI high grade) → score > 80, recommendation "conservador"
- [ ] `fii-score.ts` para ticker fora da lista → type "tijolo", typeSource "inferred", score calculado mesmo assim
- [ ] `GET /v1/analysis/ranking?type=fii&limit=10` ordenado por score decrescente
- [ ] `GET /v1/screener?minScore=50` funciona (parâmetro novo)
- [ ] Cache Redis de análise: hit retorna em < 10ms

### Onda 3 — Critérios de aceite
- [ ] `GET /v1/keys` e `DELETE /v1/keys/:id` exigem api-key (antes estavam abertos)
- [ ] `GET /v1/healthcheck` continua público (sem auth)
- [ ] API key inválida/inativa → 401 `{ error: "Unauthorized" }`
- [ ] `last_used_at` atualizado a cada request autenticado
- [ ] `generateApiKey()` usa `crypto.randomBytes`, não `Math.random`
- [ ] `POST /v1/wallets/:walletId/rebalance` com `currentPositions` preenche `currentQuantity` e sugere SELL
- [ ] Sem `currentPositions` → comportamento inalterado (retrocompatível)

## 15. Perguntas abertas

| # | Pergunta | Decisão pendente | Impacto |
|---|---|---|---|
| 1 | FIIs: cadastrar tabela própria `fiis` ou usar `companies` com flag? | Usar `companies` (já existe `fiis.controller` lendo dela). Riscos: `sector` de FII é null; `cnpj` é obrigatório. | Se migrar para tabela própria, impacto em `getFiiByTicker` e `listFiis` |
| 2 | `stock-score.ts`: pesos dos pilares são fixos ou configuráveis? | Fixos na v1 (valuation 35%, profitability 25%, dividends 20%, quality 20%). Justificativa: easy-invest usava fixos. | Se configurável, precisa de tabela/payload |
| 3 | Ranking de ações: escopo é só empresas com fundamentals no banco ou todas as listadas? | Só com fundamentals (consistente com screener). Se usuário quiser PETR4 sem fundamentals → 404. | Nenhum; alinhado com comportamento atual |
| 4 | `dataQuality.pvp` de FII: quando implementar fonte? | Postergar. Fonte candidata: FundsExplorer (HTML scraping — mesma fragilidade do StatusInvest). Ou esperar CVM disponibilizar DRE de FIIs em formato estruturado. | Score de FII sem P/VP penaliza valuation como "neutro" (50), subestimando FIIs caros e superestimando baratos |
| 5 | StatusInvest rate limit: 1 req/s é suficiente para o volume esperado? | Sim para single-user/single-instance. Se surgir multi-tenant, o bucket precisa ser Redis (distribuído). | Refatorar provider para receber rate limiter injetável |

## 16. Referências

- easy-invest retry: `~/works/easy-invest/server/src/utils/retry.ts`
- easy-invest DividendsAnalyzer: `~/works/easy-invest/server/src/core/services/` (verificar caminho exato)
- easy-invest FIIScoreV4: `~/works/easy-invest/server/src/core/services/fii-score.v4.1.ts` (728 linhas)
- easy-invest datasets: `~/works/easy-invest/server/src/core/data/fii-*.data.ts`
- easy-invest AssetAnalyzer: `~/works/easy-invest/server/src/core/services/` (inspiração para stock-score.ts)
- Urano schema atual: `src/infra/database/schema.ts`
- Urano rotas atuais: `src/infra/http/routes/index.ts`
- StatusInvest endpoint proventos: `https://statusinvest.com.br/acao/companytickerprovents?ticker={TICKER}&chartProventsType=2`
