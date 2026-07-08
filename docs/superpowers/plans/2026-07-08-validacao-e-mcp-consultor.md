# Validação do Motor + MCP Consultor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validar o score de ações contra retornos históricos reais (Fase 0 da spec) e transformar o MCP em consultor de aportes (Fase 1).

**Architecture:** Fase 0 persiste resultados de backtest em Postgres e extrai a análise estatística para funções puras em `core/`. Fase 1 adiciona um advisor puro de aportes (`core/services/contribution-advisor.ts`), um endpoint de data health, um endpoint `POST /v1/analysis/contribution` e 3 tools MCP novas. Princípio do projeto: `core/` é puro (sem I/O), `infra/` faz banco/rede/HTTP.

**Tech Stack:** Bun + TypeScript strict, Fastify 5, Drizzle ORM (Postgres), Redis (ioredis), Zod 3, `bun:test`, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-07-08-roadmap-produto-design.md`

## Global Constraints

- Runtime é **Bun** (não Node): testes com `bun test`, imports com extensão `.ts`.
- Typecheck: `bun run typecheck` (tsc --noEmit) deve passar ao fim de cada task.
- `src/core/` não pode importar de `src/infra/` (exceção existente: tipos de `market-data-service.ts` — não piorar).
- Versão do score em validação: `SCORE_VERSION = 'v1'` (pesos atuais: valuation 0.28, profitability 0.18, growth 0.15, dividends 0.14, quality 0.18, momentum 0.07).
- Iteração de pesos (0c): máximo 2 iterações, somente com aprovação do usuário — não faz parte deste plano executar mudança de pesos.
- Perfis de risco (valores exatos, já existentes em `allocation-engine.ts`): conservador `{stockPercent: 30, fiiPercent: 70, minScore: 65, maxAssets: 5}`, moderado `{50, 50, 55, 8}`, agressivo `{70, 30, 45, 12}`.
- Mensagens/comentários/respostas de API em português, como o restante do código.
- Commits em Conventional Commits, mensagem em português, terminando com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Fase 0 — Validação do motor

### Task 1: Tabela `backtest_results`

**Files:**
- Modify: `src/infra/database/schema.ts` (fim do arquivo, após `apiKeys`)

**Interfaces:**
- Produces: export Drizzle `backtestResults` — colunas: `id` uuid PK, `runId` uuid, `scoreVersion` varchar(20), `year` smallint, `ticker` varchar(10), `score/valuation/profitability/growth/dividends/quality/momentum` smallint, `startPrice` decimal(12,2), `endPrice` decimal(12,2) nullable, `return12m` decimal(8,2) nullable, `createdAt` timestamp.

- [ ] **Step 1: Adicionar tabela ao schema**

Adicionar ao final de `src/infra/database/schema.ts`:

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// backtest_results — Resultados persistidos do backtest (score vs retorno 12m)
// ═══════════════════════════════════════════════════════════════════════════
export const backtestResults = pgTable(
  'backtest_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    scoreVersion: varchar('score_version', { length: 20 }).notNull(),
    year: smallint('year').notNull(),
    ticker: varchar('ticker', { length: 10 }).notNull(),
    score: smallint('score').notNull(),
    valuation: smallint('valuation').notNull(),
    profitability: smallint('profitability').notNull(),
    growth: smallint('growth').notNull(),
    dividends: smallint('dividends').notNull(),
    quality: smallint('quality').notNull(),
    momentum: smallint('momentum').notNull(),
    startPrice: decimal('start_price', { precision: 12, scale: 2 }).notNull(),
    endPrice: decimal('end_price', { precision: 12, scale: 2 }),
    return12m: decimal('return_12m', { precision: 8, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_backtest_run_year_ticker').on(table.runId, table.year, table.ticker),
    index('idx_backtest_run').on(table.runId),
    index('idx_backtest_ticker').on(table.ticker),
  ],
);
```

- [ ] **Step 2: Gerar e aplicar migration**

Run: `bun run db:generate && bun run db:migrate`
Expected: novo arquivo em `db/migrations/` com `CREATE TABLE "backtest_results"`; migrate aplica sem erro.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/infra/database/schema.ts db/migrations
git commit -m "feat: tabela backtest_results para persistir rodadas de backtest"
```

---

### Task 2: `backtest-analysis.ts` — análise estatística pura (TDD)

**Files:**
- Create: `src/core/services/backtest-analysis.ts`
- Test: `tests/core/backtest-analysis.test.ts`

**Interfaces:**
- Produces (usado pela Task 3):
  - `interface BacktestRow { year: number; ticker: string; score: number; valuation: number; profitability: number; growth: number; dividends: number; quality: number; momentum: number; return12m: number | null; }`
  - `const PILLARS: readonly ['score','valuation','profitability','growth','dividends','quality','momentum']`
  - `percentile(arr: number[], p: number): number`
  - `pearson(a: number[], b: number[]): number`
  - `pillarCorrelations(rows: BacktestRow[]): Record<Pillar, number>`
  - `scoreBuckets(rows: BacktestRow[], size?: number): BucketStat[]` com `BucketStat = { label: string; count: number; avgReturn: number; pctPositive: number; best: number; worst: number; bestTicker: string }`
  - `topNStrategy(rows: BacktestRow[], n: number): StrategyResult` com `StrategyResult = { n: number; years: Array<{ year: number; portfolioReturn: number; marketReturn: number }>; avgPortfolio: number; avgMarket: number; winYears: number; totalYears: number }`

- [ ] **Step 1: Escrever testes que falham**

Criar `tests/core/backtest-analysis.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  percentile,
  pearson,
  pillarCorrelations,
  scoreBuckets,
  topNStrategy,
  type BacktestRow,
} from '../../src/core/services/backtest-analysis.ts';

function row(partial: Partial<BacktestRow>): BacktestRow {
  return {
    year: 2020, ticker: 'AAAA3', score: 50,
    valuation: 50, profitability: 50, growth: 50,
    dividends: 50, quality: 50, momentum: 50,
    return12m: 0,
    ...partial,
  };
}

describe('percentile', () => {
  it('calcula mediana e extremos', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(percentile(arr, 50)).toBe(30);
    expect(percentile(arr, 100)).toBe(50);
  });
});

describe('pearson', () => {
  it('correlação perfeita positiva = 1', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
  });
  it('correlação perfeita negativa = -1', () => {
    expect(pearson([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
  });
  it('série constante retorna 0 (sem variância)', () => {
    expect(pearson([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('pillarCorrelations', () => {
  it('pilar alinhado com retorno tem correlação 1, ignora return12m null', () => {
    const rows: BacktestRow[] = [
      row({ ticker: 'AAAA3', score: 10, return12m: -10 }),
      row({ ticker: 'BBBB3', score: 50, return12m: 20 }),
      row({ ticker: 'CCCC3', score: 90, return12m: 50 }),
      row({ ticker: 'DDDD3', score: 99, return12m: null }), // ignorada
    ];
    const corrs = pillarCorrelations(rows);
    expect(corrs.score).toBeGreaterThan(0.9);
    // pilares constantes (50 em todas) → 0
    expect(corrs.quality).toBe(0);
  });
});

describe('scoreBuckets', () => {
  it('agrupa por faixa de 10 e calcula estatísticas', () => {
    const rows: BacktestRow[] = [
      row({ ticker: 'AAAA3', score: 72, return12m: 10 }),
      row({ ticker: 'BBBB3', score: 78, return12m: 30 }),
      row({ ticker: 'CCCC3', score: 35, return12m: -20 }),
    ];
    const buckets = scoreBuckets(rows);
    const b70 = buckets.find((b) => b.label === '70-80');
    expect(b70?.count).toBe(2);
    expect(b70?.avgReturn).toBe(20);
    expect(b70?.pctPositive).toBe(100);
    expect(b70?.bestTicker).toBe('BBBB3 2020');
    expect(buckets.find((b) => b.label === '30-40')?.count).toBe(1);
  });
});

describe('topNStrategy', () => {
  it('seleciona top N por score em cada ano e compara com a média do ano', () => {
    const rows: BacktestRow[] = [
      row({ year: 2020, ticker: 'AAAA3', score: 90, return12m: 40 }),
      row({ year: 2020, ticker: 'BBBB3', score: 80, return12m: 20 }),
      row({ year: 2020, ticker: 'CCCC3', score: 10, return12m: -30 }),
      row({ year: 2021, ticker: 'AAAA3', score: 85, return12m: 10 }),
      row({ year: 2021, ticker: 'BBBB3', score: 20, return12m: -10 }),
    ];
    const result = topNStrategy(rows, 2);
    expect(result.totalYears).toBe(2);
    // 2020: top2 = AAAA3+BBBB3 → (40+20)/2 = 30; mercado = (40+20-30)/3 = 10
    expect(result.years[0]?.portfolioReturn).toBe(30);
    expect(result.years[0]?.marketReturn).toBe(10);
    // 2021: top2 = ambas → portfolio = mercado = 0
    expect(result.years[1]?.portfolioReturn).toBe(0);
    expect(result.winYears).toBe(1); // só 2020 ganha do mercado
    expect(result.avgPortfolio).toBe(15);
  });
});
```

- [ ] **Step 2: Rodar testes para ver falhar**

Run: `bun test tests/core/backtest-analysis.test.ts`
Expected: FAIL — módulo `backtest-analysis.ts` não existe.

- [ ] **Step 3: Implementar**

Criar `src/core/services/backtest-analysis.ts`:

```typescript
/**
 * BacktestAnalysis — estatística pura sobre resultados de backtest.
 * Sem I/O: recebe linhas, devolve correlações, buckets e simulação top N.
 */

export interface BacktestRow {
  year: number;
  ticker: string;
  score: number;
  valuation: number;
  profitability: number;
  growth: number;
  dividends: number;
  quality: number;
  momentum: number;
  return12m: number | null;
}

export const PILLARS = [
  'score', 'valuation', 'profitability', 'growth', 'dividends', 'quality', 'momentum',
] as const;
export type Pillar = (typeof PILLARS)[number];

export interface BucketStat {
  label: string;
  count: number;
  avgReturn: number;
  pctPositive: number;
  best: number;
  worst: number;
  bestTicker: string;
}

export interface StrategyYear { year: number; portfolioReturn: number; marketReturn: number; }

export interface StrategyResult {
  n: number;
  years: StrategyYear[];
  avgPortfolio: number;
  avgMarket: number;
  winYears: number;
  totalYears: number;
}

export function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function pearson(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] ?? 0) - ma;
    const db = (b[i] ?? 0) - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va > 0 && vb > 0 ? +(cov / Math.sqrt(va * vb)).toFixed(3) : 0;
}

/** Só considera linhas com retorno conhecido. */
function withReturn(rows: BacktestRow[]): BacktestRow[] {
  return rows.filter((r) => r.return12m !== null);
}

export function pillarCorrelations(rows: BacktestRow[]): Record<Pillar, number> {
  const wr = withReturn(rows);
  const returns = wr.map((r) => r.return12m as number);
  const out = {} as Record<Pillar, number>;
  for (const p of PILLARS) {
    out[p] = pearson(wr.map((r) => r[p]), returns);
  }
  return out;
}

export function scoreBuckets(rows: BacktestRow[], size = 10): BucketStat[] {
  const wr = withReturn(rows);
  const buckets: BucketStat[] = [];
  for (let lo = 0; lo < 100; lo += size) {
    const hi = lo + size;
    const items = wr.filter((r) => r.score >= lo && r.score < hi);
    if (items.length === 0) continue;
    const rets = items.map((r) => r.return12m as number);
    const best = [...items].sort(
      (a, b) => (b.return12m as number) - (a.return12m as number),
    )[0]!;
    buckets.push({
      label: `${lo}-${hi}`,
      count: items.length,
      avgReturn: +(rets.reduce((s, v) => s + v, 0) / rets.length).toFixed(2),
      pctPositive: +((rets.filter((v) => v > 0).length / rets.length) * 100).toFixed(1),
      best: Math.max(...rets),
      worst: Math.min(...rets),
      bestTicker: `${best.ticker} ${best.year}`,
    });
  }
  return buckets;
}

export function topNStrategy(rows: BacktestRow[], n: number): StrategyResult {
  const wr = withReturn(rows);
  const yearsList = [...new Set(wr.map((r) => r.year))].sort();
  const years: StrategyYear[] = [];
  for (const year of yearsList) {
    const yearRows = wr.filter((r) => r.year === year);
    if (yearRows.length === 0) continue;
    const top = [...yearRows].sort((a, b) => b.score - a.score).slice(0, n);
    const portfolioReturn =
      top.reduce((s, r) => s + (r.return12m as number), 0) / top.length;
    const marketReturn =
      yearRows.reduce((s, r) => s + (r.return12m as number), 0) / yearRows.length;
    years.push({
      year,
      portfolioReturn: +portfolioReturn.toFixed(2),
      marketReturn: +marketReturn.toFixed(2),
    });
  }
  const avg = (vals: number[]) =>
    vals.length > 0 ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : 0;
  return {
    n,
    years,
    avgPortfolio: avg(years.map((y) => y.portfolioReturn)),
    avgMarket: avg(years.map((y) => y.marketReturn)),
    winYears: years.filter((y) => y.portfolioReturn > y.marketReturn).length,
    totalYears: years.length,
  };
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun test tests/core/backtest-analysis.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`

```bash
git add src/core/services/backtest-analysis.ts tests/core/backtest-analysis.test.ts
git commit -m "feat: análise estatística de backtest como funções puras em core (TDD)"
```

---

### Task 3: Worker de backtest persiste no banco e usa o core

**Files:**
- Modify: `src/infra/workers/backtest.ts`

**Interfaces:**
- Consumes: `backtestResults` (Task 1), `pillarCorrelations/scoreBuckets/topNStrategy/percentile/PILLARS` (Task 2).
- Produces: cada rodada grava linhas em `backtest_results` com `run_id` único e imprime o `run_id` no final.

- [ ] **Step 1: Trocar análise inline pelos imports do core**

Em `src/infra/workers/backtest.ts`:

1. Adicionar imports no topo:

```typescript
import { randomUUID } from 'node:crypto';
import { backtestResults } from '../database/schema.ts';
import {
  PILLARS,
  percentile,
  pillarCorrelations,
  scoreBuckets,
  topNStrategy,
} from '../../core/services/backtest-analysis.ts';
```

2. Adicionar constante logo após os imports:

```typescript
const SCORE_VERSION = 'v1';
```

3. **Remover** a função local `percentile` (linhas ~113-117) e a const local `corr` dentro de `main()` (linhas ~160-165) — substituídas pelos imports.

- [ ] **Step 2: Persistir resultados por ano**

Em `main()`, criar o runId antes do loop de anos e gravar após cada ano:

```typescript
const runId = randomUUID();
console.log(`🔖 Run ID: ${runId} (score ${SCORE_VERSION})\n`);

const allResults: BacktestResult[] = [];
for (const year of years) {
  const results = await backtestYear(year);
  allResults.push(...results);

  if (results.length > 0) {
    await db.insert(backtestResults).values(
      results.map((r) => ({
        runId,
        scoreVersion: SCORE_VERSION,
        year: r.year,
        ticker: r.ticker,
        score: r.score,
        valuation: r.valuation,
        profitability: r.profitability,
        growth: r.growth,
        dividends: r.dividends,
        quality: r.quality,
        momentum: r.momentum,
        startPrice: String(r.startPrice),
        endPrice: r.endPrice === null ? null : String(r.endPrice),
        return12m: r.return12m === null ? null : String(r.return12m),
      })),
    );
  }
}
```

- [ ] **Step 3: Reescrever as seções de análise usando o core**

Substituir as seções `CORRELAÇÃO POR PILAR`, `BUCKETS` e `ESTRATÉGIA` de `main()` por:

```typescript
  // ═══ CORRELAÇÃO POR PILAR ═══
  console.log('\n═══ CORRELAÇÃO SCORE vs RETORNO 12M ═══');
  const corrs = pillarCorrelations(allResults);
  for (const p of PILLARS) {
    console.log(`  ${p.padEnd(15)}: ${corrs[p]}`);
  }

  // ═══ BUCKETS ═══
  console.log('\n═══ RESULTADOS POR FAIXA DE SCORE ═══');
  console.log('Faixa      | Casos | Retorno Méd | % Pos | Melhor  | Pior    | Top Ticker');
  console.log('───────────|───────|─────────────|──────|─────────|─────────|───────────');
  for (const b of scoreBuckets(allResults)) {
    console.log(`${b.label.padEnd(10)} | ${String(b.count).padStart(5)} | ${String(b.avgReturn.toFixed(1) + '%').padStart(11)} | ${String(b.pctPositive.toFixed(0) + '%').padStart(4)} | ${String(b.best.toFixed(1) + '%').padStart(7)} | ${String(b.worst.toFixed(1) + '%').padStart(7)} | ${b.bestTicker}`);
  }

  // ═══ ESTRATÉGIA: TOP N POR SCORE ═══
  console.log('\n═══ SIMULAÇÃO DE ESTRATÉGIA ═══');
  console.log('Compra top N por score a cada ano, vende 12 meses depois\n');
  for (const n of [3, 5, 10]) {
    const s = topNStrategy(allResults, n);
    console.log(`  Top ${String(n).padStart(2)}: Retorno médio ${s.avgPortfolio.toFixed(1)}%  |  vs Mercado ${(s.avgPortfolio - s.avgMarket).toFixed(1)}pp  |  ganha em ${s.winYears}/${s.totalYears} anos`);
  }
```

As variáveis `wr`, `scores` e a seção `DIAGNÓSTICO` continuam como estão (`wr` segue sendo usado no diagnóstico). Ao final de `main()`, antes do `process.exit(0)`:

```typescript
  console.log(`\n💾 Resultados gravados em backtest_results (run_id: ${runId})`);
```

- [ ] **Step 4: Typecheck + testes existentes**

Run: `bun run typecheck && bun test`
Expected: sem erros; testes existentes passam.

- [ ] **Step 5: Commit**

```bash
git add src/infra/workers/backtest.ts
git commit -m "feat: backtest persiste rodadas em backtest_results e reusa análise do core"
```

---

### Task 4: Backtest com dados históricos (growth real, não neutro)

**Contexto:** hoje o worker chama `StockScoreCalculator.calculate(indicators, sector, name)` sem o parâmetro `historical` — o pilar growth fica constante em 40 para todos e a correlação sai degenerada. Em produção o score usa histórico; o backtest deve ser fiel. O pilar momentum permanece neutro (precisa de histórico de preços — limitação registrada no relatório da Task 5).

**Files:**
- Modify: `src/infra/workers/backtest.ts` (função `backtestYear`)

**Interfaces:**
- Consumes: `HistoricalData` de `src/core/services/stock-score.ts` — `{ years: Array<{ fiscalYear: number; revenue: number; netIncome: number; roe: number; netMargin: number; debtToEquity: number; grossMargin: number }> }`.

- [ ] **Step 1: Buscar 5 anos de fundamentals por ticker**

Substituir a query de `backtestYear` (a atual usa `DISTINCT ON` de um único ano) por:

```typescript
  const rows = await db.execute(
    `SELECT DISTINCT ON (c.ticker, cf.fiscal_year)
      c.ticker, c.name, c.sector,
      cf.revenue, cf.cogs, cf.ebit, cf.net_income_parent,
      cf.total_assets, cf.total_liabilities, cf.cash,
      cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
      cf.reference_date, cf.fiscal_year
     FROM company_fundamentals cf
     JOIN companies c ON c.cnpj = cf.company_cnpj
     WHERE cf.fiscal_year BETWEEN ${year - 4} AND ${year}
       AND c.ticker NOT LIKE '%11'
     ORDER BY c.ticker, cf.fiscal_year, cf.reference_date DESC`,
  );
```

- [ ] **Step 2: Agrupar por ticker e montar HistoricalData**

Adicionar acima de `backtestYear`:

```typescript
import type { HistoricalData } from '../../core/services/stock-score.ts';

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildHistorical(yearRows: Record<string, unknown>[]): HistoricalData | undefined {
  const years = yearRows.map((r) => {
    const revenue = toNum(r.revenue);
    const netIncome = toNum(r.net_income_parent);
    const equity = toNum(r.equity);
    const liabilities = toNum(r.total_liabilities);
    const cogs = Math.abs(toNum(r.cogs));
    return {
      fiscalYear: Number(r.fiscal_year),
      revenue,
      netIncome,
      roe: equity > 0 ? (netIncome / equity) * 100 : 0,
      netMargin: revenue > 0 ? (netIncome / revenue) * 100 : 0,
      debtToEquity: equity > 0 ? liabilities / equity : 0,
      grossMargin: revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0,
    };
  });
  return years.length >= 2 ? { years } : undefined;
}
```

E reestruturar o corpo do loop de `backtestYear`:

```typescript
  // Agrupa linhas por ticker (cada linha = um ano fiscal)
  const byTicker = new Map<string, Record<string, unknown>[]>();
  for (const r of rows as unknown as Record<string, unknown>[]) {
    const t = String(r.ticker);
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t)!.push(r);
  }

  const results: BacktestResult[] = [];
  let count = 0;

  for (const [ticker, tickerRows] of byTicker) {
    // Linha do ano do backtest = a mais recente daquele fiscal_year
    const current = tickerRows.find((r) => Number(r.fiscal_year) === year);
    if (!current) continue;

    const refDate = String(current.reference_date || `${year}-12-31`);
    const startPrice = await getPriceAtDate(ticker, refDate);
    if (!startPrice || startPrice <= 0) continue;

    const endDate = new Date(refDate);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const endPrice = await getPriceAtDate(ticker, endDate.toISOString().slice(0, 10));

    const indicators = calcAllIndicators(current, startPrice);
    const historical = buildHistorical(tickerRows);
    const scoreResult = StockScoreCalculator.calculate(
      indicators,
      (current.sector as string) || null,
      String(current.name),
      historical,
    );

    results.push({
      year, ticker,
      score: scoreResult.score,
      valuation: scoreResult.breakdown.valuation.score,
      profitability: scoreResult.breakdown.profitability.score,
      growth: scoreResult.breakdown.growth.score,
      dividends: scoreResult.breakdown.dividends.score,
      quality: scoreResult.breakdown.quality.score,
      momentum: scoreResult.breakdown.momentum.score,
      startPrice: Math.round(startPrice * 100) / 100,
      endPrice: endPrice ? Math.round(endPrice * 100) / 100 : null,
      return12m: endPrice ? Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100 : null,
    });

    count++;
    if (count % 10 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 200));
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 4: Smoke test com 1 ano**

Run: `bun run backtest 2023 2023` (requer Postgres via `docker-compose up -d` e rede)
Expected: roda sem exceção; pilar growth deixa de ser constante (valores variados no diagnóstico); linhas gravadas em `backtest_results`.

- [ ] **Step 5: Commit**

```bash
git add src/infra/workers/backtest.ts
git commit -m "feat: backtest calcula pilar growth com histórico real de fundamentals"
```

---

### Task 5: Rodada completa + relatório de veredito + dados de validação

**Este task é análise, não código novo — mas produz dois artefatos versionados.** ⚠️ A rodada completa leva dezenas de minutos (Yahoo com pausa de 200ms por ticker, ~10 anos × ~100 tickers × 2 cotações). Rodar em background.

**Files:**
- Create: `docs/backtest/2026-07-08-veredito-v1.md`
- Create: `src/core/data/score-validation.data.ts`

**Interfaces:**
- Produces: `SCORE_VALIDATION: ScoreValidation` — consumido pelo endpoint de validação (Task 9). Shape:
  `interface ScoreValidation { scoreVersion: string; validatedAt: string | null; yearsTested: number[]; verdict: 'edge' | 'quality-filter' | 'pending'; summary: string; topN: { n: number; avgPortfolio: number; avgMarket: number; winYears: number; totalYears: number } | null; pillarCorrelations: Record<string, number> | null; }`

- [ ] **Step 1: Rodar backtest completo em background**

```bash
mkdir -p docs/backtest
bun run backtest 2>&1 | tee docs/backtest/2026-07-08-run-v1.log
```

Expected: log termina com `💾 Resultados gravados em backtest_results (run_id: <uuid>)`. Anotar o run_id.

- [ ] **Step 2: Criar arquivo de dados de validação (inicialmente pending)**

Criar `src/core/data/score-validation.data.ts`:

```typescript
/**
 * ScoreValidation — resultado da validação do score contra retornos históricos.
 * Preenchido manualmente a partir do relatório em docs/backtest/.
 * Consumido por GET /v1/analysis/validation e pela tool MCP explain_score.
 */

export interface ScoreValidation {
  scoreVersion: string;
  validatedAt: string | null;          // "YYYY-MM-DD" ou null se pendente
  yearsTested: number[];
  verdict: 'edge' | 'quality-filter' | 'pending';
  summary: string;                     // 2-4 frases em português, linguagem de leigo
  topN: {
    n: number;
    avgPortfolio: number;              // % média anual da estratégia
    avgMarket: number;                 // % média anual do universo
    winYears: number;
    totalYears: number;
  } | null;
  pillarCorrelations: Record<string, number> | null;
}

export const SCORE_VALIDATION: ScoreValidation = {
  scoreVersion: 'v1',
  validatedAt: null,
  yearsTested: [],
  verdict: 'pending',
  summary: 'Validação em andamento — backtest rodado, análise pendente.',
  topN: null,
  pillarCorrelations: null,
};
```

- [ ] **Step 3: Escrever o relatório de veredito**

Criar `docs/backtest/2026-07-08-veredito-v1.md` respondendo, com os números do log e queries no banco, as perguntas da spec (seção 0b). Template obrigatório:

```markdown
# Veredito do Backtest — score v1

**Run ID:** <uuid da rodada>
**Anos testados:** <lista>
**Universo:** <n> observações ticker-ano com retorno conhecido

## 1. Correlação score → retorno 12m
<tabela pilar × correlação, copiada do log>
Interpretação: quais pilares carregam sinal (>0.1), quais são ruído (~0), quais invertem (<-0.1).

## 2. Estratégia top N vs universo
<top 3/5/10: retorno médio, vs mercado em pp, anos ganhos/total>
Ano a ano do top 10 (query abaixo).

## 3. Monotonicidade por decil
<tabela de buckets do log>
Decil alto rende mais que decil baixo? Onde quebra?

## 4. Limitações conhecidas
- Survivorship bias: universo = empresas listadas hoje (deslistadas ausentes, retornos inflados)
- Pilar momentum neutro no backtest (sem histórico de preço na data)
- Sem comparação direta com IBOV (proxy: média do universo)
- <outras observadas na rodada>

## 5. Veredito
[ ] edge — top N bate a média do universo na maioria dos anos, decis monotônicos
[ ] quality-filter — score separa os piores, mas não ordena os melhores
Justificativa: <números>

## 6. Recomendação para o produto
<como o MCP/web deve apresentar recomendações dado o veredito>
```

Queries úteis (rodar com `docker-compose exec -T postgres psql -U <user> -d <db>` — conferir credenciais no `.env`):

```sql
-- Top 10 por score, ano a ano, vs média do ano
WITH ranked AS (
  SELECT year, ticker, score, return_12m,
         ROW_NUMBER() OVER (PARTITION BY year ORDER BY score DESC) AS rk
  FROM backtest_results
  WHERE run_id = '<RUN_ID>' AND return_12m IS NOT NULL
)
SELECT year,
       ROUND(AVG(return_12m) FILTER (WHERE rk <= 10), 1) AS top10,
       ROUND(AVG(return_12m), 1) AS universo,
       COUNT(*) AS n
FROM ranked GROUP BY year ORDER BY year;

-- Decis de score
SELECT decil, ROUND(AVG(return_12m), 1) AS ret_medio, COUNT(*) AS n
FROM (
  SELECT return_12m, NTILE(10) OVER (ORDER BY score) AS decil
  FROM backtest_results
  WHERE run_id = '<RUN_ID>' AND return_12m IS NOT NULL
) t GROUP BY decil ORDER BY decil;
```

- [ ] **Step 4: Preencher `score-validation.data.ts` com os números reais**

Atualizar `SCORE_VALIDATION`: `validatedAt` = data da análise, `yearsTested`, `verdict` conforme relatório, `summary` (linguagem de leigo, ex.: "Comprando as 10 ações de maior score a cada ano entre 2015 e 2024, o retorno médio foi X% ao ano contra Y% da média do mercado. A estratégia ganhou em N de M anos."), `topN` do top 10, `pillarCorrelations` do log.

- [ ] **Step 5: GATE — apresentar veredito ao usuário**

Apresentar relatório e discutir: prosseguir para Fase 1 como está, ou iterar pesos (0c, máx. 2 iterações, cada uma = mudança justificada economicamente + re-rodada + atualização do relatório). **Não prosseguir para as tasks da Fase 1 sem decisão explícita do usuário.**

- [ ] **Step 6: Commit**

```bash
git add docs/backtest src/core/data/score-validation.data.ts
git commit -m "docs: veredito do backtest v1 + dados de validação do score"
```

---

## Fase 1 — MCP consultor

### Task 6: Data health (queries + warnings puros + endpoint)

**Files:**
- Create: `src/core/services/data-health.ts` (tipos + warnings puros)
- Create: `src/infra/database/health-queries.ts` (SQL)
- Create: `src/infra/http/controllers/health.controller.ts`
- Modify: `src/infra/http/routes/index.ts`
- Test: `tests/core/data-health.test.ts`

**Interfaces:**
- Produces:
  - `interface DataHealth { fundamentals: { totalCompanies: number; withFundamentals: number; freshCompanies: number; byFiscalYear: Array<{ fiscalYear: number; companies: number }> }; jobs: { enabled: number; failing: number; lastRunAt: string | null }; generatedAt: string; }` (em `core/services/data-health.ts`)
  - `deriveHealthWarnings(h: DataHealth): string[]` (puro)
  - `fetchDataHealth(): Promise<DataHealth>` (em `infra/database/health-queries.ts`)
  - `GET /v1/health/data` → `DataHealth & { warnings: string[] }` (autenticado, cache Redis 300s, chave `health:data`)

- [ ] **Step 1: Testes dos warnings (falhando)**

Criar `tests/core/data-health.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { deriveHealthWarnings, type DataHealth } from '../../src/core/services/data-health.ts';

function healthy(): DataHealth {
  return {
    fundamentals: {
      totalCompanies: 100,
      withFundamentals: 90,
      freshCompanies: 85,
      byFiscalYear: [{ fiscalYear: 2025, companies: 90 }],
    },
    jobs: { enabled: 50, failing: 0, lastRunAt: new Date().toISOString() },
    generatedAt: new Date().toISOString(),
  };
}

describe('deriveHealthWarnings', () => {
  it('base saudável → sem warnings', () => {
    expect(deriveHealthWarnings(healthy())).toEqual([]);
  });

  it('cobertura < 50% → warning de cobertura', () => {
    const h = healthy();
    h.fundamentals.withFundamentals = 40;
    expect(deriveHealthWarnings(h).some((w) => w.includes('cobertura'))).toBe(true);
  });

  it('menos de 70% com dados frescos → warning de dados velhos', () => {
    const h = healthy();
    h.fundamentals.freshCompanies = 50; // 50/90 = 55%
    expect(deriveHealthWarnings(h).some((w) => w.includes('12 meses'))).toBe(true);
  });

  it('jobs falhando → warning', () => {
    const h = healthy();
    h.jobs.failing = 3;
    expect(deriveHealthWarnings(h).some((w) => w.includes('job'))).toBe(true);
  });

  it('sync parado há mais de 7 dias → warning', () => {
    const h = healthy();
    h.jobs.lastRunAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    expect(deriveHealthWarnings(h).some((w) => w.includes('sincronização'))).toBe(true);
  });

  it('lastRunAt null → warning de sincronização', () => {
    const h = healthy();
    h.jobs.lastRunAt = null;
    expect(deriveHealthWarnings(h).some((w) => w.includes('sincronização'))).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `bun test tests/core/data-health.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar core puro**

Criar `src/core/services/data-health.ts`:

```typescript
/**
 * DataHealth — contrato de saúde dos dados + derivação pura de warnings.
 * O preenchimento (SQL) fica em infra/database/health-queries.ts.
 */

export interface FiscalYearCoverage { fiscalYear: number; companies: number; }

export interface DataHealth {
  fundamentals: {
    totalCompanies: number;
    withFundamentals: number;
    /** empresas cujo fundamentals mais recente tem <= 12 meses */
    freshCompanies: number;
    byFiscalYear: FiscalYearCoverage[];
  };
  jobs: {
    enabled: number;
    failing: number;
    lastRunAt: string | null;
  };
  generatedAt: string;
}

const STALE_SYNC_DAYS = 7;

export function deriveHealthWarnings(h: DataHealth): string[] {
  const warnings: string[] = [];
  const f = h.fundamentals;

  if (f.totalCompanies > 0 && f.withFundamentals / f.totalCompanies < 0.5) {
    warnings.push(
      `Baixa cobertura de fundamentals: ${f.withFundamentals} de ${f.totalCompanies} empresas (${Math.round((f.withFundamentals / f.totalCompanies) * 100)}%)`,
    );
  }

  if (f.withFundamentals > 0 && f.freshCompanies / f.withFundamentals < 0.7) {
    const stalePct = Math.round((1 - f.freshCompanies / f.withFundamentals) * 100);
    warnings.push(
      `${stalePct}% das empresas com fundamentals mais velhos que 12 meses — scores podem estar defasados`,
    );
  }

  if (h.jobs.failing > 0) {
    warnings.push(`${h.jobs.failing} job(s) de sincronização em estado de falha`);
  }

  const last = h.jobs.lastRunAt ? new Date(h.jobs.lastRunAt).getTime() : null;
  if (last === null || Date.now() - last > STALE_SYNC_DAYS * 86400_000) {
    warnings.push(
      `Nenhuma sincronização de dados nos últimos ${STALE_SYNC_DAYS} dias — rode o worker:sync`,
    );
  }

  return warnings;
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun test tests/core/data-health.test.ts`
Expected: PASS.

- [ ] **Step 5: Queries de infra**

Criar `src/infra/database/health-queries.ts`:

```typescript
import { db } from './connection.ts';
import type { DataHealth, FiscalYearCoverage } from '../../core/services/data-health.ts';

export async function fetchDataHealth(): Promise<DataHealth> {
  const [companiesRows, withRows, freshRows, byYearRows, jobsRows] = await Promise.all([
    db.execute(`SELECT COUNT(*)::int AS total FROM companies`),
    db.execute(`SELECT COUNT(DISTINCT company_cnpj)::int AS total FROM company_fundamentals`),
    db.execute(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT company_cnpj, MAX(reference_date) AS latest
         FROM company_fundamentals GROUP BY company_cnpj
       ) t WHERE t.latest >= (CURRENT_DATE - INTERVAL '12 months')`,
    ),
    db.execute(
      `SELECT fiscal_year, COUNT(DISTINCT company_cnpj)::int AS companies
       FROM company_fundamentals GROUP BY fiscal_year
       ORDER BY fiscal_year DESC LIMIT 8`,
    ),
    db.execute(
      `SELECT
         COUNT(*) FILTER (WHERE enabled)::int AS enabled,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failing,
         MAX(last_run_at) AS last_run
       FROM jobs`,
    ),
  ]);

  const one = <T>(rows: unknown): T => (rows as T[])[0] as T;
  const jobs = one<{ enabled: number; failing: number; last_run: string | Date | null }>(jobsRows);

  return {
    fundamentals: {
      totalCompanies: Number(one<{ total: number }>(companiesRows)?.total ?? 0),
      withFundamentals: Number(one<{ total: number }>(withRows)?.total ?? 0),
      freshCompanies: Number(one<{ total: number }>(freshRows)?.total ?? 0),
      byFiscalYear: (byYearRows as unknown as Array<{ fiscal_year: number; companies: number }>).map(
        (r): FiscalYearCoverage => ({ fiscalYear: Number(r.fiscal_year), companies: Number(r.companies) }),
      ),
    },
    jobs: {
      enabled: Number(jobs?.enabled ?? 0),
      failing: Number(jobs?.failing ?? 0),
      lastRunAt: jobs?.last_run ? new Date(jobs.last_run).toISOString() : null,
    },
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 6: Controller + rota**

Criar `src/infra/http/controllers/health.controller.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fetchDataHealth } from '../../database/health-queries.ts';
import { deriveHealthWarnings } from '../../../core/services/data-health.ts';
import { redis } from '../../services/redis.ts';

const CACHE_KEY = 'health:data';
const CACHE_TTL = 300;

export async function getDataHealthController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch {
    // Redis offline — segue sem cache
  }

  const health = await fetchDataHealth();
  const response = { ...health, warnings: deriveHealthWarnings(health) };

  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(response));
  } catch { /* sem cache */ }

  reply.send(response);
}
```

Em `src/infra/http/routes/index.ts`, adicionar import e rota (junto do bloco Analysis):

```typescript
import { getDataHealthController } from '../controllers/health.controller.ts';
```

```typescript
  // Data health
  app.get('/health/data', getDataHealthController);
```

- [ ] **Step 7: Verificação manual**

Run: `bun run typecheck && bun test`. Com o server rodando (`bun run dev`) e uma api-key válida:
`curl -s -H "x-api-key: <KEY>" localhost:3000/v1/health/data`
Expected: JSON com `fundamentals`, `jobs`, `warnings`.

- [ ] **Step 8: Commit**

```bash
git add src/core/services/data-health.ts src/infra/database/health-queries.ts src/infra/http/controllers/health.controller.ts src/infra/http/routes/index.ts tests/core/data-health.test.ts
git commit -m "feat: data health — cobertura/frescor de dados com warnings e endpoint /v1/health/data"
```

---

### Task 7: Perfis de risco compartilhados + `contribution-advisor.ts` (TDD)

**Files:**
- Create: `src/core/data/risk-profiles.ts`
- Modify: `src/core/services/allocation-engine.ts` (remove `RISK_CONFIGS` local, importa do novo arquivo)
- Create: `src/core/services/contribution-advisor.ts`
- Test: `tests/core/contribution-advisor.test.ts`

**Interfaces:**
- Produces:
  - `RISK_CONFIGS: Record<RiskProfile, { stockPercent: number; fiiPercent: number; minScore: number; maxAssets: number }>` e `type RiskProfile = 'conservador' | 'moderado' | 'agressivo'` (em `core/data/risk-profiles.ts`)
  - `suggestContribution(universe: AdvisorAsset[], positions: CurrentPosition[], config: AdvisorConfig, warnings?: string[]): ContributionSuggestion` — tipos abaixo no código. Usado pela Task 8.

- [ ] **Step 1: Extrair perfis de risco**

Criar `src/core/data/risk-profiles.ts`:

```typescript
/** Perfis de risco compartilhados por AllocationEngine e ContributionAdvisor. */

export type RiskProfile = 'conservador' | 'moderado' | 'agressivo';

export interface RiskProfileConfig {
  stockPercent: number;
  fiiPercent: number;
  minScore: number;
  maxAssets: number;
}

export const RISK_CONFIGS: Record<RiskProfile, RiskProfileConfig> = {
  conservador: { stockPercent: 30, fiiPercent: 70, minScore: 65, maxAssets: 5 },
  moderado: { stockPercent: 50, fiiPercent: 50, minScore: 55, maxAssets: 8 },
  agressivo: { stockPercent: 70, fiiPercent: 30, minScore: 45, maxAssets: 12 },
};
```

Em `src/core/services/allocation-engine.ts`:
- Remover o bloco local `const RISK_CONFIGS ...` (linhas ~70-89) e o `export type RiskProfile = ...` (linha ~26).
- Adicionar: `import { RISK_CONFIGS, type RiskProfile } from '../data/risk-profiles.ts';`
- Manter re-export para não quebrar consumidores: `export type { RiskProfile };`

Run: `bun run typecheck` — sem erros.

- [ ] **Step 2: Testes do advisor (falhando)**

Criar `tests/core/contribution-advisor.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  suggestContribution,
  type AdvisorAsset,
} from '../../src/core/services/contribution-advisor.ts';

function asset(partial: Partial<AdvisorAsset>): AdvisorAsset {
  return {
    ticker: 'AAAA3', name: 'Empresa A', assetType: 'stock',
    score: 70, price: 10, sector: 'energia elétrica',
    reasons: ['ROE alto'], alerts: [],
    ...partial,
  };
}

function universe(): AdvisorAsset[] {
  return [
    asset({ ticker: 'AAAA3', score: 85, price: 20, sector: 'energia elétrica' }),
    asset({ ticker: 'BBBB3', score: 75, price: 15, sector: 'saneamento' }),
    asset({ ticker: 'CCCC3', score: 68, price: 30, sector: 'financeiro' }),
    asset({ ticker: 'DDDD3', score: 50, price: 10, sector: 'varejo' }),
    asset({ ticker: 'EEEE11', assetType: 'fii', score: 80, price: 100, sector: 'logistica' }),
    asset({ ticker: 'FFFF11', assetType: 'fii', score: 72, price: 90, sector: 'shopping' }),
    asset({ ticker: 'GGGG11', assetType: 'fii', score: 66, price: 110, sector: 'papel' }),
  ];
}

describe('suggestContribution', () => {
  it('carteira vazia, perfil moderado: compra ações e FIIs dentro do valor', () => {
    const result = suggestContribution(universe(), [], { amount: 2000, profile: 'moderado' });
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(result.purchases.some((p) => p.assetType === 'stock')).toBe(true);
    expect(result.purchases.some((p) => p.assetType === 'fii')).toBe(true);
    expect(result.totals.invested).toBeLessThanOrEqual(2000);
    expect(result.totals.invested + result.totals.remaining).toBeCloseTo(2000, 1);
    // toda compra tem justificativa
    for (const p of result.purchases) expect(p.why.length).toBeGreaterThan(0);
  });

  it('carteira concentrada: ativo no teto é pulado com explicação de concentração', () => {
    // 500 cotas × R$20 = R$10.000 em AAAA3; aporte de R$1.000 → teto 25% de R$11.000 = R$2.750 < R$10.000
    const result = suggestContribution(
      universe(),
      [{ ticker: 'AAAA3', quantity: 500 }],
      { amount: 1000, profile: 'moderado' },
    );
    expect(result.purchases.every((p) => p.ticker !== 'AAAA3')).toBe(true);
    expect(result.skipped.some((s) => s.ticker === 'AAAA3' && s.reason.includes('teto'))).toBe(true);
  });

  it('valor menor que qualquer preço: sem compras, warning de valor insuficiente', () => {
    const result = suggestContribution(universe(), [], { amount: 5, profile: 'moderado' });
    expect(result.purchases).toEqual([]);
    expect(result.warnings.some((w) => w.includes('insuficiente'))).toBe(true);
  });

  it('perfil filtra por score mínimo: conservador exclui score 50, agressivo inclui', () => {
    const conservador = suggestContribution(universe(), [], { amount: 5000, profile: 'conservador' });
    expect(conservador.purchases.every((p) => p.ticker !== 'DDDD3')).toBe(true);
    expect(conservador.skipped.some((s) => s.ticker === 'DDDD3' && s.reason.includes('Score'))).toBe(true);

    const agressivo = suggestContribution(universe(), [], { amount: 5000, profile: 'agressivo' });
    const all = [...agressivo.purchases.map((p) => p.ticker), ...agressivo.skipped.map((s) => s.ticker)];
    expect(agressivo.purchases.every((p) => p.score >= 45)).toBe(true);
  });

  it('posição em ticker fora do universo: warning, não explode', () => {
    const result = suggestContribution(
      universe(),
      [{ ticker: 'ZZZZ3', quantity: 100 }],
      { amount: 2000, profile: 'moderado' },
    );
    expect(result.warnings.some((w) => w.includes('ZZZZ3'))).toBe(true);
    expect(result.purchases.length).toBeGreaterThan(0);
  });

  it('onlyTypes fii: nenhuma ação comprada, orçamento inteiro em FIIs', () => {
    const result = suggestContribution(universe(), [], {
      amount: 2000, profile: 'moderado', onlyTypes: ['fii'],
    });
    expect(result.purchases.length).toBeGreaterThan(0);
    expect(result.purchases.every((p) => p.assetType === 'fii')).toBe(true);
  });

  it('excludeSectors: setor excluído vai para skipped', () => {
    const result = suggestContribution(universe(), [], {
      amount: 2000, profile: 'moderado', excludeSectors: ['financeiro'],
    });
    expect(result.purchases.every((p) => p.ticker !== 'CCCC3')).toBe(true);
    expect(result.skipped.some((s) => s.ticker === 'CCCC3' && s.reason.includes('excluído'))).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar para ver falhar**

Run: `bun test tests/core/contribution-advisor.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implementar o advisor**

Criar `src/core/services/contribution-advisor.ts`:

```typescript
/**
 * ContributionAdvisor — dado o universo analisado (score+preço), as posições
 * atuais e um valor de aporte, sugere o que comprar, com justificativa por
 * ativo e explicação do que foi deixado de fora.
 *
 * Função pura: sem banco, sem rede. Quem preenche o universo é a infra.
 */

import { RISK_CONFIGS, type RiskProfile } from '../data/risk-profiles.ts';

export interface AdvisorAsset {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  score: number;
  price: number;
  sector: string | null;
  reasons: string[];
  alerts: string[];
}

export interface CurrentPosition { ticker: string; quantity: number; }

export interface AdvisorConfig {
  amount: number;
  profile: RiskProfile;
  onlyTypes?: Array<'stock' | 'fii'>;
  excludeSectors?: string[];
  /** Teto de % do patrimônio final (posições + aporte) por ativo. Default 25. */
  maxAssetPercent?: number;
}

export interface ContributionPurchase {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  quantity: number;
  unitPrice: number;
  cost: number;
  score: number;
  why: string[];
}

export interface ContributionSuggestion {
  purchases: ContributionPurchase[];
  skipped: Array<{ ticker: string; reason: string }>;
  warnings: string[];
  totals: { invested: number; remaining: number; portfolioValueBefore: number };
}

const DIVERSIFY_SLOT_RATIO = 0.6;
const MAX_SKIPPED_ENTRIES = 15;

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function suggestContribution(
  universe: AdvisorAsset[],
  positions: CurrentPosition[],
  config: AdvisorConfig,
  warnings: string[] = [],
): ContributionSuggestion {
  const profileCfg = RISK_CONFIGS[config.profile];
  const maxAssetPct = config.maxAssetPercent ?? 25;
  const outWarnings = [...warnings];
  const skipped: Array<{ ticker: string; reason: string }> = [];

  // ── Valor atual das posições (preço vem do universo) ──
  const priceOf = new Map(universe.map((a) => [a.ticker, a.price]));
  const heldValue = new Map<string, number>();
  for (const p of positions) {
    const ticker = p.ticker.toUpperCase();
    const price = priceOf.get(ticker);
    if (price === undefined || price <= 0) {
      outWarnings.push(
        `Posição em ${ticker} ignorada no cálculo de concentração: ativo fora do universo analisado`,
      );
      continue;
    }
    heldValue.set(ticker, (heldValue.get(ticker) ?? 0) + p.quantity * price);
  }
  const portfolioValue = [...heldValue.values()].reduce((s, v) => s + v, 0);
  const finalValue = portfolioValue + config.amount;
  const capPerAsset = (maxAssetPct / 100) * finalValue;

  // ── Filtro de elegibilidade (ordenado por score p/ skipped relevante) ──
  const allowedTypes = config.onlyTypes ?? ['stock', 'fii'];
  const excludedSectors = (config.excludeSectors ?? []).map((s) => s.toLowerCase());
  const eligible: AdvisorAsset[] = [];

  for (const a of [...universe].sort((x, y) => y.score - x.score)) {
    if (!allowedTypes.includes(a.assetType)) continue; // excluído por config, não vale skipped
    if (a.price <= 0) continue;
    const sector = a.sector?.toLowerCase() ?? '';
    if (excludedSectors.some((s) => sector.includes(s))) {
      if (skipped.length < MAX_SKIPPED_ENTRIES) {
        skipped.push({ ticker: a.ticker, reason: `Setor "${a.sector}" excluído por preferência` });
      }
      continue;
    }
    if (a.score < profileCfg.minScore) {
      if (skipped.length < MAX_SKIPPED_ENTRIES) {
        skipped.push({
          ticker: a.ticker,
          reason: `Score ${a.score} abaixo do mínimo ${profileCfg.minScore} do perfil ${config.profile}`,
        });
      }
      continue;
    }
    eligible.push(a);
  }

  // ── Orçamento por classe ──
  const bothAllowed = allowedTypes.includes('stock') && allowedTypes.includes('fii');
  const budgetFor = (type: 'stock' | 'fii'): number => {
    if (!allowedTypes.includes(type)) return 0;
    if (!bothAllowed) return config.amount;
    const pct = type === 'stock' ? profileCfg.stockPercent : profileCfg.fiiPercent;
    return (config.amount * pct) / 100;
  };

  const purchases: ContributionPurchase[] = [];
  const plannedCost = new Map<string, number>();

  const addPurchase = (a: AdvisorAsset, quantity: number): void => {
    const cost = quantity * a.price;
    const existing = purchases.find((p) => p.ticker === a.ticker);
    if (existing) {
      existing.quantity += quantity;
      existing.cost = round2(existing.cost + cost);
    } else {
      purchases.push({
        ticker: a.ticker,
        name: a.name,
        assetType: a.assetType,
        quantity,
        unitPrice: a.price,
        cost: round2(cost),
        score: a.score,
        why: [`Score ${a.score}/100`, ...a.reasons.slice(0, 2)],
      });
    }
    plannedCost.set(a.ticker, (plannedCost.get(a.ticker) ?? 0) + cost);
  };

  /** Quanto ainda cabe neste ativo sem estourar o teto de concentração. */
  const roomFor = (a: AdvisorAsset): number =>
    capPerAsset - (heldValue.get(a.ticker) ?? 0) - (plannedCost.get(a.ticker) ?? 0);

  for (const type of ['stock', 'fii'] as const) {
    let budget = budgetFor(type);
    if (budget <= 0) continue;
    const pool = eligible.filter((a) => a.assetType === type);
    if (pool.length === 0) continue;

    const typeShare = bothAllowed
      ? (type === 'stock' ? profileCfg.stockPercent : profileCfg.fiiPercent) / 100
      : 1;
    const maxAssets = Math.max(1, Math.round(profileCfg.maxAssets * typeShare));

    // Seleção com diversificação setorial (primeiros 60% das vagas em setores únicos)
    const selected: AdvisorAsset[] = [];
    const usedSectors = new Set<string>();
    const diversifySlots = Math.ceil(maxAssets * DIVERSIFY_SLOT_RATIO);
    for (const a of pool) {
      if (selected.length >= maxAssets) break;
      const sector = a.sector ?? 'outros';
      if (selected.length < diversifySlots && usedSectors.has(sector)) continue;
      selected.push(a);
      usedSectors.add(sector);
    }

    // 1ª passada: alocação proporcional ao score, respeitando teto por ativo
    const totalScore = selected.reduce((s, a) => s + a.score, 0);
    for (const a of selected) {
      const room = roomFor(a);
      if (room < a.price) {
        const held = heldValue.get(a.ticker) ?? 0;
        skipped.push({
          ticker: a.ticker,
          reason: `Já representa ${((held / finalValue) * 100).toFixed(0)}% da carteira — teto de ${maxAssetPct}% por ativo`,
        });
        continue;
      }
      const target = Math.min((a.score / totalScore) * budgetFor(type), room, budget);
      const quantity = Math.floor(target / a.price);
      if (quantity === 0) continue;
      addPurchase(a, quantity);
      budget -= quantity * a.price;
    }

    // 2ª passada: sobra do orçamento vai para os melhores que ainda têm espaço
    for (const a of selected) {
      while (budget >= a.price && roomFor(a) >= a.price) {
        addPurchase(a, 1);
        budget -= a.price;
      }
    }
  }

  const invested = purchases.reduce((s, p) => s + p.cost, 0);

  if (purchases.length === 0) {
    const cheapest = eligible.length > 0 ? Math.min(...eligible.map((a) => a.price)) : null;
    if (cheapest !== null && config.amount < cheapest) {
      outWarnings.push(
        `Valor de R$ ${config.amount.toFixed(2)} insuficiente para 1 unidade de qualquer ativo elegível (mais barato: R$ ${cheapest.toFixed(2)}) — acumule para o próximo aporte`,
      );
    } else if (eligible.length === 0) {
      outWarnings.push('Nenhum ativo elegível com os filtros e perfil informados');
    }
  }

  return {
    purchases: purchases.sort((a, b) => b.cost - a.cost),
    skipped,
    warnings: outWarnings,
    totals: {
      invested: round2(invested),
      remaining: round2(config.amount - invested),
      portfolioValueBefore: round2(portfolioValue),
    },
  };
}
```

- [ ] **Step 5: Rodar testes**

Run: `bun test tests/core/contribution-advisor.test.ts && bun test && bun run typecheck`
Expected: PASS em tudo (inclusive suíte inteira — allocation-engine continua compilando).

- [ ] **Step 6: Commit**

```bash
git add src/core/data/risk-profiles.ts src/core/services/allocation-engine.ts src/core/services/contribution-advisor.ts tests/core/contribution-advisor.test.ts
git commit -m "feat: contribution-advisor puro — sugestão de aporte com justificativas e anti-concentração (TDD)"
```

---

### Task 8: Endpoint `POST /v1/analysis/contribution`

**Files:**
- Modify: `src/core/services/allocation-engine.ts` (métodos `analyzeAllStocks`/`analyzeAllFiis` de `private` → público)
- Create: `src/infra/http/controllers/contribution.controller.ts`
- Modify: `src/infra/http/routes/index.ts`

**Interfaces:**
- Consumes: `suggestContribution` (Task 7), `fetchDataHealth` + `deriveHealthWarnings` (Task 6), `AllocationEngine.analyzeAllStocks(): Promise<Array<{ticker; name; score; price; reasons; alerts; sector}>>` e `analyzeAllFiis()` (mesmo shape).
- Produces: `POST /v1/analysis/contribution` — body `{ amount: number; profile?: 'conservador'|'moderado'|'agressivo'; positions?: Array<{ticker: string; quantity: number}>; onlyTypes?: Array<'stock'|'fii'>; excludeSectors?: string[] }` → `ContributionSuggestion & { profile, amount, generatedAt }`. Universo cacheado no Redis (`advisor:universe`, TTL 1800s).

- [ ] **Step 1: Tornar públicos os analisadores do AllocationEngine**

Em `src/core/services/allocation-engine.ts`, trocar `private async analyzeAllStocks` por `async analyzeAllStocks` e `private async analyzeAllFiis` por `async analyzeAllFiis` (assinaturas e corpos inalterados).

- [ ] **Step 2: Controller**

Criar `src/infra/http/controllers/contribution.controller.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AllocationEngine } from '../../../core/services/allocation-engine.ts';
import {
  suggestContribution,
  type AdvisorAsset,
} from '../../../core/services/contribution-advisor.ts';
import { deriveHealthWarnings } from '../../../core/services/data-health.ts';
import { fetchDataHealth } from '../../database/health-queries.ts';
import { redis } from '../../services/redis.ts';

const UNIVERSE_CACHE_KEY = 'advisor:universe';
const UNIVERSE_CACHE_TTL = 1800;

const bodySchema = z.object({
  amount: z.number().positive(),
  profile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado'),
  positions: z
    .array(z.object({ ticker: z.string().min(4), quantity: z.number().positive() }))
    .default([]),
  onlyTypes: z.array(z.enum(['stock', 'fii'])).min(1).optional(),
  excludeSectors: z.array(z.string()).optional(),
});

async function loadUniverse(): Promise<AdvisorAsset[]> {
  try {
    const cached = await redis.get(UNIVERSE_CACHE_KEY);
    if (cached) return JSON.parse(cached) as AdvisorAsset[];
  } catch { /* Redis offline — segue sem cache */ }

  const engine = new AllocationEngine();
  const [stocks, fiis] = [await engine.analyzeAllStocks(), await engine.analyzeAllFiis()];
  const universe: AdvisorAsset[] = [
    ...stocks.map((s) => ({ ...s, assetType: 'stock' as const })),
    ...fiis.map((f) => ({ ...f, assetType: 'fii' as const })),
  ];

  try {
    await redis.setex(UNIVERSE_CACHE_KEY, UNIVERSE_CACHE_TTL, JSON.stringify(universe));
  } catch { /* sem cache */ }

  return universe;
}

export async function contributionController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'BadRequest', message: parsed.error.issues[0]?.message });
    return;
  }
  const { amount, profile, positions, onlyTypes, excludeSectors } = parsed.data;

  // Data health primeiro: recomendação nunca sai silenciosa sobre base degradada
  let healthWarnings: string[] = [];
  try {
    healthWarnings = deriveHealthWarnings(await fetchDataHealth());
  } catch {
    healthWarnings = ['Não foi possível verificar a saúde dos dados — trate a sugestão com cautela'];
  }

  const universe = await loadUniverse();
  const suggestion = suggestContribution(
    universe,
    positions,
    { amount, profile, onlyTypes, excludeSectors },
    healthWarnings,
  );

  reply.send({
    amount,
    profile,
    generatedAt: new Date().toISOString(),
    ...suggestion,
  });
}
```

- [ ] **Step 3: Rota**

Em `src/infra/http/routes/index.ts`:

```typescript
import { contributionController } from '../controllers/contribution.controller.ts';
```

```typescript
  app.post('/analysis/contribution', contributionController);
```

- [ ] **Step 4: Verificação**

Run: `bun run typecheck && bun test`. Com server + banco de pé:

```bash
curl -s -X POST -H "x-api-key: <KEY>" -H "Content-Type: application/json" \
  -d '{"amount": 2000, "profile": "moderado", "positions": [{"ticker": "PETR4", "quantity": 100}]}' \
  localhost:3000/v1/analysis/contribution
```

Expected: JSON com `purchases` (cada um com `why[]`), `skipped`, `warnings`, `totals`. Segunda chamada responde rápido (universo cacheado).

- [ ] **Step 5: Commit**

```bash
git add src/core/services/allocation-engine.ts src/infra/http/controllers/contribution.controller.ts src/infra/http/routes/index.ts
git commit -m "feat: POST /v1/analysis/contribution — sugestão de aporte com data health e cache de universo"
```

---

### Task 9: Endpoint de validação + 3 tools MCP

**Files:**
- Modify: `src/infra/http/controllers/analysis.controller.ts` (novo controller pequeno no fim)
- Modify: `src/infra/http/routes/index.ts`
- Modify: `src/infra/mcp/server.ts`

**Interfaces:**
- Consumes: `SCORE_VALIDATION` (Task 5), `POST /v1/analysis/contribution` (Task 8), `GET /v1/health/data` (Task 6), `GET /v1/analysis/stocks/:ticker` e `GET /v1/analysis/fiis/:ticker` (existentes).
- Produces: `GET /v1/analysis/validation` → `ScoreValidation`; tools MCP `suggest_contribution`, `explain_score`, `get_data_health`.

- [ ] **Step 1: Endpoint de validação**

Em `src/infra/http/controllers/analysis.controller.ts`, adicionar import e controller no fim do arquivo:

```typescript
import { SCORE_VALIDATION } from '../../../core/data/score-validation.data.ts';

export async function getValidationController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.send(SCORE_VALIDATION);
}
```

(Se `FastifyRequest`/`FastifyReply` já estão importados no topo — estão, pois os outros controllers os usam — só adicionar o import do `SCORE_VALIDATION` junto aos demais imports.)

Em `src/infra/http/routes/index.ts`, adicionar `getValidationController` ao import de `analysis.controller.ts` e registrar:

```typescript
  app.get('/analysis/validation', getValidationController);
```

- [ ] **Step 2: Tools MCP**

Em `src/infra/mcp/server.ts`, antes da seção `─── Start ───`, adicionar:

```typescript
server.tool(
  'suggest_contribution',
  'CONSULTOR DE APORTE: dado o valor disponível (ex: R$ 2.000 do mês), a carteira atual e o perfil de risco, retorna exatamente o que comprar — ticker, quantidade, custo e justificativa por ativo — além do que foi deixado de fora e por quê (concentração, score baixo, setor excluído). Use esta tool quando o usuário perguntar "onde devo investir/aportar".',
  {
    amount: z.number().positive().describe('Valor disponível para aportar em reais'),
    profile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado').describe('Perfil de risco'),
    positions: z
      .array(z.object({ ticker: z.string(), quantity: z.number().positive() }))
      .optional()
      .describe('Posições atuais da carteira (ex: [{"ticker":"PETR4","quantity":100}])'),
    onlyTypes: z.array(z.enum(['stock', 'fii'])).optional().describe('Restringir a ações (stock) ou FIIs (fii)'),
    excludeSectors: z.array(z.string()).optional().describe('Setores a evitar (ex: ["financeiro"])'),
  },
  async (params) => {
    const data = await apiPost('/analysis/contribution', params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

const PILLAR_GLOSSARY = {
  valuation: 'Preço vs o que a empresa entrega (P/L, P/VP, EV/EBIT). Alto = ação barata para o lucro que gera.',
  profitability: 'Rentabilidade: ROE e margens comparados à média do setor.',
  growth: 'Crescimento de receita e lucro ao longo dos anos + consistência (anos seguidos de lucro).',
  dividends: 'Dividend yield dos últimos 12 meses.',
  quality: 'Solidez: endividamento, geração de caixa real (FCO vs lucro) e setor defensivo ou cíclico.',
  momentum: 'Comportamento recente do preço: queda exagerada pode ser oportunidade, euforia é risco.',
} as const;

server.tool(
  'explain_score',
  'Explica o score de um ativo em linguagem simples: o que cada pilar mede, onde o ativo vai bem/mal, e o histórico de validação do score (backtest). Use quando o usuário perguntar "por que esse score?" ou "posso confiar nessa nota?".',
  {
    ticker: z.string().describe('Ticker do ativo (ex: PETR4, HGLG11)'),
    assetType: z.enum(['stock', 'fii']).default('stock').describe('Tipo do ativo'),
  },
  async ({ ticker, assetType }) => {
    const path = assetType === 'fii' ? `/analysis/fiis/${ticker.toUpperCase()}` : `/analysis/stocks/${ticker.toUpperCase()}`;
    const [analysis, validation] = [await api(path), await api('/analysis/validation')];
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ analysis, glossario_dos_pilares: PILLAR_GLOSSARY, validacao_do_score: validation }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_data_health',
  'Saúde da base de dados do Urano: cobertura de fundamentals, frescor dos dados, jobs de sincronização. Consulte antes de recomendações importantes — warnings indicam scores potencialmente defasados.',
  {},
  async () => {
    const data = await api('/health/data');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);
```

Atualizar o comentário de cabeçalho do arquivo (lista de ferramentas) incluindo as 3 novas:

```
 *   suggest_contribution — Consultor de aporte: o que comprar com o valor do mês
 *   explain_score        — Explica o score em linguagem simples + validação (backtest)
 *   get_data_health      — Saúde da base: cobertura, frescor, jobs
```

- [ ] **Step 3: Verificação**

Run: `bun run typecheck && bun test`
Com server + banco de pé, testar o MCP manualmente:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | URANO_API_KEY=<KEY> bun run mcp 2>/dev/null | head -c 2000
```

Expected: lista inclui `suggest_contribution`, `explain_score`, `get_data_health` (total 15 tools).

- [ ] **Step 4: Commit**

```bash
git add src/infra/http/controllers/analysis.controller.ts src/infra/http/routes/index.ts src/infra/mcp/server.ts
git commit -m "feat: MCP consultor — suggest_contribution, explain_score e get_data_health + endpoint de validação"
```

---

## Ordem e gates

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 (GATE: veredito com usuário)
                                        │
Task 6 → Task 7 → Task 8 → Task 9  (só após gate aprovado)
```

- Task 5 Step 5 é um checkpoint humano obrigatório: o veredito do backtest decide se a Fase 1 prossegue como está ou se antes há até 2 iterações de pesos (fora deste plano, com aprovação).
- Critério de aceite final da Fase 1 (da spec): `suggest_contribution` responde a "tenho R$ 2.000, onde aporto?" com compras + justificativas + warnings de data health, via Claude/MCP.
