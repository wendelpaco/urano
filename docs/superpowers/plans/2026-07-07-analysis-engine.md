# Urano Analysis Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o Urano em API de análise: retry/resiliência, proventos mensais (StatusInvest JSON), scores de FII e ações, endpoints `/v1/analysis/*`, api-key auth e rebalance com posição atual.

**Architecture:** Lógica pura vai para `src/core/services` (testável sem I/O); I/O fica em `src/infra`. Ports do easy-invest (`~/works/easy-invest`) são cópias adaptadas — datasets e algoritmos intactos, inputs trocados para as fontes do Urano (CVM + Yahoo + StatusInvest JSON). Spec: `docs/superpowers/specs/2026-07-07-analysis-engine-design.md`.

**Tech Stack:** Bun (runtime + `bun test`), Fastify 5, Drizzle ORM + Postgres, ioredis, Zod 3. **Nenhuma dependência nova.**

## Global Constraints

- Runtime Bun; imports relativos com extensão `.ts` explícita (convenção do repo).
- `src/core/**` não importa de `src/infra/**` (exceção existente: `execute-rebalance.ts` já viola; não piorar).
- Retry: máx 2 tentativas totais (`maxRetries: 1`), backoff 500ms→2000ms, fator 2 (spec §5).
- StatusInvest: rate limit próprio de 1 req/s; cache Redis 24h; fallback silencioso para `[]`.
- Cache Redis TTLs: proventos 24h (86400s), análise 15min (900s), ranking 30min (1800s), api-keys 60s.
- Degradação, nunca falha: fonte externa indisponível → campos `null` + bloco `dataQuality: { fundamentals, quotes, dividends }`.
- Ticker sem fundamentals → 404 com mensagem citando `worker:sync`.
- Testes com `bun test` (imports de `bun:test`); arquivos em `tests/` espelhando `src/`.
- Verificação por task: `bun test` + `bun run typecheck` verdes antes do commit.
- Fora de escopo (NUNCA adicionar): users/JWT, alertas, DARF/imposto, scraping HTML, job scheduler, persistência de posições.

## File Structure

```
src/
├── shared/retry.ts                          # NOVO (Task 1)
├── core/
│   ├── data/
│   │   ├── fii-classification.data.ts       # NOVO — cópia (Task 7)
│   │   ├── fii-papel-subclasses.data.ts     # NOVO — cópia (Task 7)
│   │   ├── fii-tijolo-subclasses.data.ts    # NOVO — cópia (Task 7)
│   │   └── known-fiis.data.ts               # NOVO — movido de fiis.controller (Task 9)
│   └── services/
│       ├── dividends-analyzer.ts            # NOVO — port (Task 3)
│       ├── indicators.ts                    # NOVO — extraído do controller (Task 6)
│       ├── fii-score.ts                     # NOVO — port v4.1 (Task 7)
│       ├── stock-score.ts                   # NOVO — adaptação (Task 8)
│       └── rebalance-calc.ts                # NOVO (Task 13)
└── infra/
    ├── services/
    │   ├── dividends-provider.ts            # NOVO (Task 4)
    │   └── analysis-service.ts              # NOVO (Task 9)
    └── http/
        ├── middleware/auth.ts               # NOVO (Task 12)
        └── controllers/analysis.controller.ts  # NOVO (Task 10)
scripts/create-api-key.ts                    # NOVO (Task 12)
tests/                                       # NOVO — espelha src/
```

Fontes de port (ler antes de copiar):
- `~/works/easy-invest/server/src/utils/retry.ts`
- `~/works/easy-invest/server/src/modules/scrapers/dividends.analyzer.ts`
- `~/works/easy-invest/server/src/modules/scrapers/fii-classification.data.ts`
- `~/works/easy-invest/server/src/modules/intelligence/fii-papel-subclasses.data.ts`
- `~/works/easy-invest/server/src/modules/intelligence/fii-tijolo-subclasses.data.ts`
- `~/works/easy-invest/server/src/modules/intelligence/fii-score.v4.1.ts`
- `~/works/easy-invest/server/src/modules/intelligence/asset.analyzer.ts` (referência de thresholds, NÃO copiar)

---

### Task 1: `src/shared/retry.ts`

**Files:**
- Create: `src/shared/retry.ts`
- Test: `tests/shared/retry.test.ts`

**Interfaces:**
- Produces: `withRetry<T>(fn: () => Promise<T>, options?: Partial<RetryOptions>): Promise<T>`; `withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T>`; `batchWithConcurrency<T, R>(items: T[], operation: (item: T) => Promise<R>, concurrency?: number): Promise<R[]>`; `class TimeoutError extends Error`; `interface RetryOptions { maxRetries: number; initialDelay: number; maxDelay: number; backoffFactor: number; timeout?: number; onRetry?: (attempt: number, error: Error) => void }`

Port de `easy-invest/server/src/utils/retry.ts` com adaptações: sem `logger` (usar `console.warn` mínimo), `TimeoutError` definido localmente, **remover** `retryScraperOperation` (YAGNI).

- [ ] **Step 1: Write the failing test**

```ts
// tests/shared/retry.test.ts
import { describe, expect, test } from 'bun:test';
import { withRetry, withTimeout, batchWithConcurrency, TimeoutError } from '../../src/shared/retry.ts';

describe('withRetry', () => {
  test('retorna na primeira tentativa quando fn resolve', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 42; });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test('tenta novamente após falha e retorna sucesso', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
      { maxRetries: 1, initialDelay: 1, maxDelay: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('lança o último erro após esgotar tentativas', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('sempre falha'); },
        { maxRetries: 1, initialDelay: 1, maxDelay: 2 }),
    ).rejects.toThrow('sempre falha');
    expect(calls).toBe(2); // 2 tentativas totais (spec §5)
  });

  test('chama onRetry a cada nova tentativa', async () => {
    const attempts: number[] = [];
    await withRetry(
      async () => { if (attempts.length === 0) throw new Error('x'); return 1; },
      { maxRetries: 1, initialDelay: 1, maxDelay: 2, onRetry: (a) => attempts.push(a) },
    );
    expect(attempts).toEqual([1]);
  });
});

describe('withTimeout', () => {
  test('resolve quando promise termina antes do timeout', async () => {
    const result = await withTimeout(Promise.resolve('rápido'), 100);
    expect(result).toBe('rápido');
  });

  test('rejeita com TimeoutError quando estoura', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('tarde'), 200));
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('batchWithConcurrency', () => {
  test('processa todos os itens', async () => {
    const results = await batchWithConcurrency([1, 2, 3, 4, 5], async (n) => n * 2, 2);
    expect(results.toSorted((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
  });

  test('respeita o limite de concorrência', async () => {
    let active = 0;
    let peak = 0;
    await batchWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
      2,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/shared/retry.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/retry.ts'`

- [ ] **Step 3: Write implementation**

Copiar `~/works/easy-invest/server/src/utils/retry.ts` para `src/shared/retry.ts` e aplicar:
1. Remover `import { logger } ...` e `import { TimeoutError } ...`.
2. Adicionar no topo:

```ts
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
```

3. Trocar os dois blocos `logger.error({...})`/`logger.warn({...})` dentro de `withRetry` por:

```ts
// no lugar de logger.error:
console.warn(`[retry] Máximo de tentativas excedido (${attempt + 1}): ${lastError.message}`);
// no lugar de logger.warn:
console.warn(`[retry] Tentativa ${attempt + 1}/${opts.maxRetries} em ${delay}ms: ${lastError.message}`);
```

4. Remover a função `retryScraperOperation` inteira.
5. Manter defaults: `{ maxRetries: 1, initialDelay: 500, maxDelay: 2000, backoffFactor: 2 }`.
6. Tipo `Timer` (linha `let timeoutId: Timer | undefined`) é global do Bun — manter.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/shared/retry.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck e commit**

```bash
bun run typecheck
git add src/shared/retry.ts tests/shared/retry.test.ts
git commit -m "feat: adiciona utilitário de retry com backoff exponencial"
```

---

### Task 2: Aplicar retry nos fetches existentes

**Files:**
- Modify: `src/infra/services/cvm-storage-service.ts` (método `downloadZip`, ~linha 173)
- Modify: `src/infra/services/stock-quote-service.ts` (métodos `getQuote` ~linha 94 e `getHistory` ~linha 127)
- Modify: `src/infra/http/controllers/macro.controller.ts` (função `fetchBcbSeries`, ~linha 50)

**Interfaces:**
- Consumes: `withRetry` de `src/shared/retry.ts` (Task 1)
- Produces: nenhuma mudança de assinatura — comportamento externo idêntico, só resiliência.

- [ ] **Step 1: cvm-storage-service.ts**

Adicionar import no topo:

```ts
import { withRetry } from '../../shared/retry.ts';
```

Envolver o corpo de `downloadZip` (mantendo o AbortController de 2min por tentativa):

```ts
  /** Faz o download do ZIP com retry e timeout */
  private async downloadZip(url: string): Promise<ArrayBuffer> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Falha ao baixar ZIP (HTTP ${response.status}): ${url}`,
          );
        }

        return await response.arrayBuffer();
      } finally {
        clearTimeout(timeout);
      }
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000 });
  }
```

- [ ] **Step 2: stock-quote-service.ts**

Adicionar import `import { withRetry } from '../../shared/retry.ts';` e trocar as duas factories de cache:

```ts
// em getQuote:
    return getOrSet(cacheKey, 30, () =>
      withRetry(() => this.fetchQuote(symbol, ticker), {
        maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000,
      }));
```

```ts
// em getHistory:
    return getOrSet(cacheKey, 300, () =>
      withRetry(() => this.fetchHistory(symbol, ticker, range), {
        maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000,
      }));
```

- [ ] **Step 3: macro.controller.ts**

Adicionar import `import { withRetry } from '../../../shared/retry.ts';` e envolver o fetch em `fetchBcbSeries` (o `catch` externo que devolve `[]` permanece):

```ts
async function fetchBcbSeries(code: string, limit = 12): Promise<MacroSeriesPoint[]> {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json`;

  try {
    const data = await withRetry(async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`BCB HTTP ${response.status}`);
      return (await response.json()) as Array<{ data: string; valor: string }>;
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000 });

    return data.slice(-limit).map((d) => ({
      date: d.data,
      value: parseFloat(d.valor),
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Verificar e commitar**

Run: `bun test && bun run typecheck`
Expected: PASS / sem erros

```bash
git add src/infra/services/cvm-storage-service.ts src/infra/services/stock-quote-service.ts src/infra/http/controllers/macro.controller.ts
git commit -m "feat: aplica retry com backoff nos fetches externos (CVM, Yahoo, BCB)"
```

---

### Task 3: `src/core/services/dividends-analyzer.ts`

**Files:**
- Create: `src/core/services/dividends-analyzer.ts`
- Test: `tests/core/dividends-analyzer.test.ts`

**Interfaces:**
- Produces: `class DividendsAnalyzer { static analyze(dividendsHistory: Array<{ date: string; value: number; type: string }>, currentPrice: number): DividendMetrics }`; `interface DividendMetrics` (idêntica à fonte: totalPayments, totalPaid, averagePayment, last12MonthsTotal, last12MonthsCount, last12MonthsAverage, stability, consistency, trend, trendScore, growthRate, quality, qualityScore, coefficientOfVariation, monthsWithoutPayment, longestGap); **novo helper** `trailing12MonthsTotal(history: Array<{ date: string; value: number }>, now?: Date): number`

Port verbatim de `easy-invest/server/src/modules/scrapers/dividends.analyzer.ts` (classe é pura, zero dependências). Única adição: helper `trailing12MonthsTotal` para o cálculo de DY (Task 5/9).

**Atenção:** `analyze` usa `new Date()` internamente para a janela de 12 meses — fixtures dos testes DEVEM gerar datas relativas a hoje.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/dividends-analyzer.test.ts
import { describe, expect, test } from 'bun:test';
import { DividendsAnalyzer, trailing12MonthsTotal } from '../../src/core/services/dividends-analyzer.ts';

/** Data ISO N meses atrás, dia 15 (evita edge de fim de mês) */
function monthsAgoIso(n: number): string {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

function monthly(values: number[]): Array<{ date: string; value: number; type: string }> {
  return values.map((value, i) => ({ date: monthsAgoIso(i), value, type: 'Rendimento' }));
}

describe('DividendsAnalyzer.analyze', () => {
  test('histórico estável: 12 pagamentos iguais → alta estabilidade e qualidade', () => {
    const m = DividendsAnalyzer.analyze(monthly(Array(12).fill(1.0)), 100);
    expect(m.totalPayments).toBe(12);
    expect(m.coefficientOfVariation).toBe(0);
    expect(m.stability).toBe(100);
    expect(m.consistency).toBeGreaterThanOrEqual(90);
    expect(m.trend).toBe('estavel');
    expect(m.quality).toBe('excelente');
    expect(m.monthsWithoutPayment).toBe(0);
  });

  test('histórico decrescente: últimos 6m com metade do valor → decrescente', () => {
    // índice 0 = mais recente; recentes 0.5, anteriores 1.0
    const m = DividendsAnalyzer.analyze(monthly([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1]), 100);
    expect(m.trend).toBe('decrescente');
    expect(m.growthRate).toBe(-50);
    expect(m.trendScore).toBe(-100);
  });

  test('histórico com gaps: pagamentos trimestrais penalizam consistência', () => {
    const quarterly = [0, 3, 6, 9].map((n) => ({ date: monthsAgoIso(n), value: 1.0, type: 'Rendimento' }));
    const m = DividendsAnalyzer.analyze(quarterly, 100);
    expect(m.last12MonthsCount).toBe(4);
    expect(m.monthsWithoutPayment).toBe(8);
    expect(m.consistency).toBeLessThan(50);
    expect(m.longestGap).toBeGreaterThan(60);
  });

  test('histórico vazio retorna métricas zeradas', () => {
    const m = DividendsAnalyzer.analyze([], 100);
    expect(m.totalPayments).toBe(0);
    expect(m.quality).toBe('ruim');
    expect(m.qualityScore).toBe(0);
    expect(m.monthsWithoutPayment).toBe(12);
  });

  test('aceita datas em formato brasileiro DD/MM/YYYY', () => {
    const d = new Date();
    d.setDate(15);
    const br = `15/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const m = DividendsAnalyzer.analyze([{ date: br, value: 2, type: 'Dividendo' }], 100);
    expect(m.last12MonthsCount).toBe(1);
    expect(m.last12MonthsTotal).toBe(2);
  });
});

describe('trailing12MonthsTotal', () => {
  test('soma apenas os últimos 12 meses', () => {
    const history = [
      { date: monthsAgoIso(1), value: 1.0 },
      { date: monthsAgoIso(6), value: 2.0 },
      { date: monthsAgoIso(18), value: 99.0 }, // fora da janela
    ];
    expect(trailing12MonthsTotal(history)).toBe(3.0);
  });

  test('histórico vazio soma zero', () => {
    expect(trailing12MonthsTotal([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/dividends-analyzer.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Write implementation**

Copiar `~/works/easy-invest/server/src/modules/scrapers/dividends.analyzer.ts` inteiro (313 linhas) para `src/core/services/dividends-analyzer.ts` e aplicar SOMENTE:

1. Extrair `parseDate` de método privado estático para função module-level (a classe passa a chamar `parseDate(...)` em vez de `this.parseDate(...)` — 5 call sites):

```ts
/** Parse de data em "DD/MM/YYYY" ou "YYYY-MM-DD" */
function parseDate(dateStr: string): Date {
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/').map(Number);
    const day = parts[0];
    const month = parts[1];
    const year = parts[2];
    if (day !== undefined && month !== undefined && year !== undefined) {
      return new Date(year, month - 1, day);
    }
  }
  return new Date(dateStr);
}
```

2. Adicionar ao final do arquivo:

```ts
/**
 * Soma dos proventos por cota nos últimos 12 meses.
 * Usado para calcular Dividend Yield: (soma 12m / preço) * 100.
 */
export function trailing12MonthsTotal(
  history: Array<{ date: string; value: number }>,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  return history
    .filter((h) => parseDate(h.date) >= cutoff)
    .reduce((sum, h) => sum + h.value, 0);
}
```

3. Nada mais muda — thresholds, pesos e mensagens ficam idênticos à fonte.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/dividends-analyzer.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck e commit**

```bash
bun run typecheck
git add src/core/services/dividends-analyzer.ts tests/core/dividends-analyzer.test.ts
git commit -m "feat: porta DividendsAnalyzer (métricas de estabilidade/tendência/qualidade)"
```

---

### Task 4: `src/infra/services/dividends-provider.ts`

**Files:**
- Create: `src/infra/services/dividends-provider.ts`
- Test: `tests/infra/dividends-provider.test.ts`

**Interfaces:**
- Consumes: `withRetry` (Task 1), `getOrSet` de `src/infra/services/redis.ts`
- Produces: `interface DividendEvent { date: string; value: number; type: string }` (date sempre ISO `YYYY-MM-DD`); `class DividendsProvider { constructor(fetchFn?: typeof fetch, cache?: CacheFn); getDividends(ticker: string, assetType: 'stock' | 'fii'): Promise<DividendEvent[]> }`; singleton `dividendsProvider`

Endpoint StatusInvest (JSON, não HTML): `GET https://statusinvest.com.br/acao/companytickerprovents?ticker=X&chartProventsType=2` (ações) e `/fii/companytickerprovents` (FIIs). Resposta: `{ assetEarningsModels: [{ et, pd, ed, v }] }` onde `et` = tipo (Rendimento/Dividendo/JCP/Amortização), `pd` = data pagamento `DD/MM/YYYY`, `ed` = data COM (fallback), `v` = valor.

Regras: cache 24h; falha NÃO é cacheada (factory lança → `getOrSet` não grava; catch externo devolve `[]`); rate limit 1 req/s; aceitar apenas `Rendimento|Dividendo|JCP`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/dividends-provider.test.ts
import { describe, expect, test } from 'bun:test';
import { DividendsProvider } from '../../src/infra/services/dividends-provider.ts';

/** Cache fake: executa a factory direto (sem Redis) */
const noCache = <T>(_key: string, _ttl: number, factory: () => Promise<T>) => factory();

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('DividendsProvider', () => {
  test('mapeia proventos e converte data BR para ISO', async () => {
    const provider = new DividendsProvider(
      fakeFetch({
        assetEarningsModels: [
          { et: 'Rendimento', pd: '15/06/2026', v: 0.85 },
          { et: 'Dividendo', pd: '10/03/2026', v: '1.20' },
          { et: 'JCP', ed: '01/02/2026', v: 0.5 }, // sem pd → usa ed
          { et: 'Amortização', pd: '01/01/2026', v: 9.9 }, // filtrado
          { et: 'Rendimento', pd: '05/05/2026', v: 0 }, // valor 0 → filtrado
        ],
      }),
      noCache,
    );

    const events = await provider.getDividends('mxrf11', 'fii');
    expect(events).toEqual([
      { date: '2026-06-15', value: 0.85, type: 'Rendimento' },
      { date: '2026-03-10', value: 1.2, type: 'Dividendo' },
      { date: '2026-02-01', value: 0.5, type: 'JCP' },
    ]);
  });

  test('HTTP não-ok degrada para lista vazia', async () => {
    const provider = new DividendsProvider(fakeFetch({}, 503), noCache);
    expect(await provider.getDividends('PETR4', 'stock')).toEqual([]);
  });

  test('resposta sem assetEarningsModels degrada para lista vazia', async () => {
    const provider = new DividendsProvider(fakeFetch({ foo: 1 }), noCache);
    expect(await provider.getDividends('PETR4', 'stock')).toEqual([]);
  });

  test('usa endpoint de ação para stock e de fii para fii', async () => {
    const urls: string[] = [];
    const spyFetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ assetEarningsModels: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new DividendsProvider(spyFetch, noCache);
    await provider.getDividends('PETR4', 'stock');
    await provider.getDividends('MXRF11', 'fii');
    expect(urls[0]).toContain('/acao/companytickerprovents?ticker=PETR4');
    expect(urls[1]).toContain('/fii/companytickerprovents?ticker=MXRF11');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/infra/dividends-provider.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Write implementation**

```ts
// src/infra/services/dividends-provider.ts
import { getOrSet } from './redis.ts';
import { withRetry } from '../../shared/retry.ts';

/**
 * Proventos por cota via API JSON interna do StatusInvest.
 *
 * RISCO (spec §8): endpoint não documentado — pode mudar ou bloquear.
 * Mitigações: cache 24h, rate limit 1 req/s, retry curto, degradação para [].
 */
export interface DividendEvent {
  date: string; // ISO YYYY-MM-DD
  value: number;
  type: string; // Rendimento | Dividendo | JCP
}

interface AssetEarningModel {
  et: string; // Tipo: Rendimento, Dividendo, JCP, Amortização
  pd?: string; // Data de pagamento (DD/MM/YYYY)
  ed?: string; // Data COM (DD/MM/YYYY)
  v: number | string;
}

interface ProventsResponse {
  assetEarningsModels?: AssetEarningModel[];
}

type CacheFn = <T>(key: string, ttlSeconds: number, factory: () => Promise<T>) => Promise<T>;

const BASE_URL = 'https://statusinvest.com.br';
const ACCEPTED_TYPES = new Set(['Rendimento', 'Dividendo', 'JCP']);
const MIN_INTERVAL_MS = 1000; // 1 req/s (spec §5)
const CACHE_TTL_SECONDS = 86_400; // 24h — proventos mudam raramente

/** Converte DD/MM/YYYY → YYYY-MM-DD; null se inválida */
function toIsoDate(raw: string): string | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [day = '', month = '', year = ''] = parts;
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!d || !m || !y || d > 31 || m > 12 || y < 1900) return null;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export class DividendsProvider {
  private lastRequestAt = 0;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly cache: CacheFn = getOrSet,
  ) {}

  /**
   * Histórico de proventos por cota. Nunca lança: qualquer falha → [].
   * Falhas não são cacheadas (só sucesso entra no Redis).
   */
  async getDividends(ticker: string, assetType: 'stock' | 'fii'): Promise<DividendEvent[]> {
    const upper = ticker.toUpperCase();
    const cacheKey = `provents:${assetType}:${upper}`;

    try {
      return await this.cache(cacheKey, CACHE_TTL_SECONDS, () =>
        this.fetchProvents(upper, assetType),
      );
    } catch {
      return [];
    }
  }

  private async fetchProvents(
    ticker: string,
    assetType: 'stock' | 'fii',
  ): Promise<DividendEvent[]> {
    await this.rateLimit();

    const path = assetType === 'fii' ? 'fii' : 'acao';
    const url = `${BASE_URL}/${path}/companytickerprovents?ticker=${encodeURIComponent(ticker)}&chartProventsType=2`;

    const data = await withRetry(
      async () => {
        const response = await this.fetchFn(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`StatusInvest HTTP ${response.status} para ${ticker}`);
        }
        return (await response.json()) as ProventsResponse;
      },
      { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 10_000 },
    );

    if (!Array.isArray(data.assetEarningsModels)) return [];

    const events: DividendEvent[] = [];
    for (const item of data.assetEarningsModels) {
      if (!ACCEPTED_TYPES.has(item.et)) continue;
      const rawDate = item.pd || item.ed;
      if (!rawDate) continue;
      const date = toIsoDate(rawDate);
      const value = typeof item.v === 'number' ? item.v : parseFloat(item.v || '0');
      if (!date || !(value > 0)) continue;
      events.push({ date, value, type: item.et });
    }
    return events;
  }

  /** Garante intervalo mínimo entre requisições ao StatusInvest */
  private async rateLimit(): Promise<void> {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}

export const dividendsProvider = new DividendsProvider();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/infra/dividends-provider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck e commit**

```bash
bun run typecheck
git add src/infra/services/dividends-provider.ts tests/infra/dividends-provider.test.ts
git commit -m "feat: provider de proventos via API JSON do StatusInvest"
```

---

### Task 5: Enriquecer `GET /v1/dividends/:ticker` e DY em `/v1/fundamentals/:ticker`

**Files:**
- Modify: `src/infra/http/controllers/dividends.controller.ts`
- Modify: `src/infra/http/controllers/fundamentals.controller.ts` (assinatura de `calcAllIndicators` linha 26 e controller linha 76)

**Interfaces:**
- Consumes: `dividendsProvider.getDividends` (Task 4), `DividendsAnalyzer.analyze` + `trailing12MonthsTotal` (Task 3), `stockQuoteService.getQuote`
- Produces: resposta de `/v1/dividends/:ticker` ganha `analysis` (DividendMetrics | null), `monthlyHistory` (DividendEvent[]), `dataQuality`; `calcAllIndicators(f, price, dividendYield?: number | null)` — terceiro parâmetro novo, default `null`.

- [ ] **Step 1: dividends.controller.ts — bloco novo antes do `reply.send`**

Adicionar imports:

```ts
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { DividendsAnalyzer } from '../../../core/services/dividends-analyzer.ts';
```

Antes do `reply.send({...})` final, inserir:

```ts
  // Proventos mensais (StatusInvest) + análise — degrada para null se indisponível
  const monthlyHistory = await dividendsProvider.getDividends(ticker, 'stock');

  let price = 0;
  try {
    price = (await stockQuoteService.getQuote(ticker)).price;
  } catch { /* cotação indisponível não bloqueia */ }

  const analysis = monthlyHistory.length > 0
    ? DividendsAnalyzer.analyze(monthlyHistory, price)
    : null;
```

E no `reply.send`, adicionar os campos:

```ts
    analysis,
    monthlyHistory,
    dataQuality: {
      fundamentals: rows.length > 0,
      quotes: price > 0,
      dividends: monthlyHistory.length > 0,
    },
```

- [ ] **Step 2: fundamentals.controller.ts — DY real**

1. Assinatura: `function calcAllIndicators(f: Record<string, unknown>, price: number, dividendYield: number | null = null): FinancialIndicators` e trocar `dividendYield: null` por `dividendYield`.
2. Imports novos:

```ts
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { trailing12MonthsTotal } from '../../../core/services/dividends-analyzer.ts';
```

3. No controller, após obter `price`:

```ts
  let dividendYield: number | null = null;
  if (price > 0) {
    const provents = await dividendsProvider.getDividends(ticker, 'stock');
    const total12m = trailing12MonthsTotal(provents);
    if (total12m > 0) dividendYield = +((total12m / price) * 100).toFixed(2);
  }

  const indicators = calcAllIndicators(f, price, dividendYield);
```

- [ ] **Step 3: Verificar e commitar**

Run: `bun test && bun run typecheck`
Expected: PASS

Verificação manual (opcional, exige Postgres+Redis locais e `worker:sync` já rodado):
`curl -s localhost:3000/v1/dividends/PETR4 | head -c 500` — deve incluir `analysis` e `monthlyHistory`.

```bash
git add src/infra/http/controllers/dividends.controller.ts src/infra/http/controllers/fundamentals.controller.ts
git commit -m "feat: enriquece /v1/dividends com análise mensal e DY real em /v1/fundamentals"
```

---

### Task 6: Extrair `calcAllIndicators` para `src/core/services/indicators.ts`

**Files:**
- Create: `src/core/services/indicators.ts`
- Modify: `src/infra/http/controllers/fundamentals.controller.ts` (remover função local, importar do core)
- Test: `tests/core/indicators.test.ts`

**Interfaces:**
- Produces: `calcAllIndicators(f: Record<string, unknown>, price: number, dividendYield?: number | null): FinancialIndicators` exportada de `src/core/services/indicators.ts`. Corrige a violação de altitude registrada no spec §3.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/indicators.test.ts
import { describe, expect, test } from 'bun:test';
import { calcAllIndicators } from '../../src/core/services/indicators.ts';

// Números redondos para validação manual dos indicadores
const fixture = {
  ticker: 'TEST3',
  referenceDate: '2025-12-31',
  netIncomeParent: 100,
  netIncome: 90,
  revenue: 500,
  cogs: -200, // CVM reporta negativo
  ebit: 150,
  totalAssets: 1000,
  totalLiabilities: 400,
  cash: 100,
  equity: 600,
  operatingCashFlow: 120,
  sharesOutstanding: 100,
};

describe('calcAllIndicators', () => {
  test('reproduz exatamente os indicadores do controller original', () => {
    const i = calcAllIndicators(fixture, 12);
    expect(i.ticker).toBe('TEST3');
    expect(i.grossMargin).toBe(60);        // (500-200)/500
    expect(i.ebitMargin).toBe(30);         // 150/500
    expect(i.netMargin).toBe(20);          // 100/500
    expect(i.roe).toBe(16.67);             // 100/600
    expect(i.roa).toBe(10);                // 100/1000
    expect(i.eps).toBe(1);                 // 100/100
    expect(i.bvps).toBe(6);                // 600/100
    expect(i.peRatio).toBe(12);            // 12/1
    expect(i.pbRatio).toBe(2);             // 12/6
    expect(i.psRatio).toBe(2.4);           // 1200/500
    expect(i.pebit).toBe(8);               // 1200/150
    expect(i.evEbit).toBe(6.67);           // (400+600)/150
    expect(i.debtToEquity).toBe(0.67);     // 400/600
    expect(i.netDebtToEquity).toBe(0.5);   // (400-100)/600
    expect(i.assetTurnover).toBe(0.5);     // 500/1000
    expect(i.fcoToNetIncome).toBe(1.2);    // 120/100
    expect(i.marketCap).toBe(1200);
    expect(i.dividendYield).toBeNull();
  });

  test('preço zero anula indicadores de valuation', () => {
    const i = calcAllIndicators(fixture, 0);
    expect(i.peRatio).toBeNull();
    expect(i.pbRatio).toBeNull();
    expect(i.marketCap).toBe(0);
  });

  test('propaga dividendYield quando informado', () => {
    expect(calcAllIndicators(fixture, 12, 7.5).dividendYield).toBe(7.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/indicators.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Mover a função**

Criar `src/core/services/indicators.ts` movendo `calcAllIndicators` INTEIRA de `fundamentals.controller.ts` (com a mudança da Task 5 já aplicada — parâmetro `dividendYield`), sem alterar nenhuma linha de cálculo:

```ts
// src/core/services/indicators.ts
import type { FinancialIndicators } from '../entities/company-fundamentals.ts';

/**
 * Calcula todos os indicadores financeiros a partir de fundamentos CVM + cotação.
 * Extraído de fundamentals.controller.ts — lógica pura, sem I/O (spec §3).
 */
export function calcAllIndicators(
  f: Record<string, unknown>,
  price: number,
  dividendYield: number | null = null,
): FinancialIndicators {
  // ... corpo idêntico ao do controller, incluindo o comentário do COGS ...
}
```

Em `fundamentals.controller.ts`: apagar a função local e adicionar
`import { calcAllIndicators } from '../../../core/services/indicators.ts';`
(remover também o import de `FinancialIndicators` se ficar sem uso).

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS — extração não mudou resultados (validado pelo teste de fixture)

- [ ] **Step 5: Commit**

```bash
git add src/core/services/indicators.ts src/infra/http/controllers/fundamentals.controller.ts tests/core/indicators.test.ts
git commit -m "refactor: extrai calcAllIndicators do controller para core/services"
```

---

### Task 7: Datasets FII + port do `fii-score.ts` (golden tests)

**Files:**
- Create: `src/core/data/fii-classification.data.ts` (cópia de `easy-invest/server/src/modules/scrapers/fii-classification.data.ts`, 335 l)
- Create: `src/core/data/fii-papel-subclasses.data.ts` (cópia de `easy-invest/server/src/modules/intelligence/`, 207 l)
- Create: `src/core/data/fii-tijolo-subclasses.data.ts` (cópia, 343 l)
- Create: `src/core/services/fii-score.ts` (port de `fii-score.v4.1.ts`, 728 l)
- Test: `tests/core/fii-score.test.ts`

**Interfaces:**
- Produces: `FIIScoreCalculatorV4.calculate(data: { ticker: string; price: number; dy: number; pvp: number | null; liquidity: number; dividendsHistory: Array<{date,value,type}>; vacancy?: number }): FIIScoreV4` — **única mudança de assinatura vs fonte: `pvp` aceita `null`**. Exporta também todas as interfaces (`FIIScoreV4`, `IncomeQualityScoreV4`, `AssetQualityScoreV4`, `RiskScoreV4`, `DYNormalizationV4`, `RiskBreakdownV4`).

- [ ] **Step 1: Copiar os 3 datasets**

```bash
cp ~/works/easy-invest/server/src/modules/scrapers/fii-classification.data.ts src/core/data/
cp ~/works/easy-invest/server/src/modules/intelligence/fii-papel-subclasses.data.ts src/core/data/
cp ~/works/easy-invest/server/src/modules/intelligence/fii-tijolo-subclasses.data.ts src/core/data/
```

Os 3 arquivos não têm imports — copiar sem edição. Adicionar no topo de cada um (mitigação spec §8, dataset envelhece):

```ts
// Snapshot de classificação copiado do easy-invest em 2026-07-07.
// Classificações compiladas em 2024/2025 — revisar antes de confiar para tickers novos.
```

- [ ] **Step 2: Write failing golden test**

Estrutura conhecida dos datasets (verificada na fonte): KNCR11 → papel/`cdi_high_grade_juros_sensitive`; XPML11 → tijolo/`shopping_prime_ciclico`; HGLG11 → tijolo (classification), sem subclasse de tijolo mapeada obrigatória.

```ts
// tests/core/fii-score.test.ts
import { describe, expect, test } from 'bun:test';
import { FIIScoreCalculatorV4 } from '../../src/core/services/fii-score.ts';

/** 12 rendimentos mensais estáveis relativos a hoje (income_quality determinístico) */
function stableHistory(value: number): Array<{ date: string; value: number; type: string }> {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(15);
    d.setMonth(d.getMonth() - i);
    return { date: d.toISOString().slice(0, 10), value, type: 'Rendimento' };
  });
}

describe('FIIScoreCalculatorV4 — golden tests', () => {
  test('KNCR11: papel cdi_high_grade com risco de juros dominante', () => {
    const score = FIIScoreCalculatorV4.calculate({
      ticker: 'KNCR11', price: 105, dy: 11, pvp: 1.0, liquidity: 3_000_000,
      dividendsHistory: stableHistory(0.95),
    });
    expect(score.type).toBe('papel');
    expect(score.subclasse_papel).toBe('cdi_high_grade_juros_sensitive');
    expect(score.dy_normalization.applied).toBe(true);
    expect(score.risk.breakdown.juros).toBe(30); // sensibilidade altíssima a CDI (V4.1)
    expect(score.risk.breakdown.credito).toBe(85); // crédito high-grade
    expect(score.overall_score).toBeGreaterThan(0);
    expect(score.overall_score).toBeLessThanOrEqual(100);
  });

  test('XPML11: tijolo shopping_prime_ciclico', () => {
    const score = FIIScoreCalculatorV4.calculate({
      ticker: 'XPML11', price: 110, dy: 9, pvp: 0.95, liquidity: 2_500_000,
      dividendsHistory: stableHistory(0.8), vacancy: 4,
    });
    expect(score.type).toBe('tijolo');
    expect(score.subclasse_tijolo).toBe('shopping_prime_ciclico');
    expect(score.dy_normalization.applied).toBe(false); // tijolo não normaliza DY
  });

  test('HGLG11: tijolo logística classificado por fonte explícita', () => {
    const score = FIIScoreCalculatorV4.calculate({
      ticker: 'HGLG11', price: 160, dy: 8.5, pvp: 1.02, liquidity: 4_000_000,
      dividendsHistory: stableHistory(1.1), vacancy: 3,
    });
    expect(score.type).toBe('tijolo');
    expect(score.type_source).not.toBe('inferred');
  });

  test('ticker desconhecido: infere tijolo com type_source inferred (spec §5)', () => {
    const score = FIIScoreCalculatorV4.calculate({
      ticker: 'ZZZZ11', price: 100, dy: 8, pvp: 1.0, liquidity: 500_000,
      dividendsHistory: stableHistory(0.7),
    });
    expect(score.type).toBe('tijolo');
    expect(score.type_source).toBe('inferred');
  });

  test('P/VP ausente (null) usa valuation neutro 50 — gap conhecido do Urano', () => {
    const withPvp = FIIScoreCalculatorV4.calculate({
      ticker: 'ZZZZ11', price: 100, dy: 8, pvp: 0.8, liquidity: 500_000,
      dividendsHistory: stableHistory(0.7),
    });
    const withoutPvp = FIIScoreCalculatorV4.calculate({
      ticker: 'ZZZZ11', price: 100, dy: 8, pvp: null, liquidity: 500_000,
      dividendsHistory: stableHistory(0.7),
    });
    expect(withoutPvp.asset_quality.valuation_score).toBe(50);
    expect(withPvp.asset_quality.valuation_score).toBe(95); // pvp 0.8 < 0.85
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/core/fii-score.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 4: Portar fii-score**

Copiar `~/works/easy-invest/server/src/modules/intelligence/fii-score.v4.1.ts` para `src/core/services/fii-score.ts` e aplicar EXATAMENTE estas mudanças:

1. Imports (topo do arquivo):

```ts
import { getFIIClassification } from '../data/fii-classification.data.ts';
import {
  getPapelSubclass,
  normalizeDYBySubclass,
  type PapelSubclass,
} from '../data/fii-papel-subclasses.data.ts';
import {
  getTijoloSubclass,
  type TijoloSubclass,
  type TijoloSubclassification,
} from '../data/fii-tijolo-subclasses.data.ts';
```

2. **Guard de P/VP ausente** (gap conhecido, spec §2a — a fonte NÃO trata `pvp<=0`, daria score 95 indevido):
   - Na assinatura de `calculate`, trocar `pvp: number;` por `pvp: number | null;`
   - `calculateAssetQuality(pvp: number, ...)` → `calculateAssetQuality(pvp: number | null, ...)`
   - Primeira linha do bloco de valuation em `calculateAssetQuality`:

```ts
    // Valuation score (P/VP) — Urano não tem P/VP de FII confiável ainda;
    // ausência (null/0) usa neutro 50 em vez de premiar como "barato"
    let valuationScore = 50;
    if (pvp === null || pvp <= 0) {
      valuationScore = 50;
    } else if (pvp < 0.85) {
      valuationScore = 95;
    } else if (pvp < 0.95) {
      ...
```

   - No objeto retornado: `p_vp: pvp ?? 0,`
3. TODO o resto (normalização DY, income quality, risk, penalização progressiva, recomendação, explicação) fica byte a byte idêntico à fonte.

- [ ] **Step 5: Run tests**

Run: `bun test tests/core/fii-score.test.ts && bun run typecheck`
Expected: PASS (5 tests)

- [ ] **Step 6: Congelar goldens numéricos**

Rodar uma vez imprimindo os scores e congelar no teste (valores exatos viram regressão):

```bash
bun -e "
import { FIIScoreCalculatorV4 } from './src/core/services/fii-score.ts';
const h = Array.from({length:12},(_,i)=>{const d=new Date();d.setDate(15);d.setMonth(d.getMonth()-i);return{date:d.toISOString().slice(0,10),value:0.95,type:'Rendimento'}});
const s = FIIScoreCalculatorV4.calculate({ticker:'KNCR11',price:105,dy:11,pvp:1.0,liquidity:3_000_000,dividendsHistory:h});
console.log(s.overall_score, s.income_quality.score, s.risk.score, s.overall_rating);
"
```

Adicionar ao teste do KNCR11 as asserções exatas com os números impressos, ex.:

```ts
    // Goldens congelados em 2026-07-07 (regressão do port)
    expect(score.overall_score).toBe(<valor impresso>);
    expect(score.income_quality.score).toBe(<valor impresso>);
    expect(score.risk.score).toBe(<valor impresso>);
```

Repetir `bun test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/data/ src/core/services/fii-score.ts tests/core/fii-score.test.ts
git commit -m "feat: porta FIIScoreV4.1 com datasets de classificação (golden tests)"
```

---

### Task 8: `src/core/services/stock-score.ts`

**Files:**
- Create: `src/core/services/stock-score.ts`
- Test: `tests/core/stock-score.test.ts`

**Interfaces:**
- Consumes: `FinancialIndicators` de `src/core/entities/company-fundamentals.ts`
- Produces:

```ts
export interface StockScoreInput {
  ticker: string;
  price: number | null;
  sector: string | null;
  indicators: Pick<FinancialIndicators, 'peRatio' | 'pbRatio' | 'roe' | 'dividendYield' | 'netDebtToEquity'>;
}
export interface StockScore {
  ticker: string;
  score: number; // 0-100
  rating: 'excelente' | 'bom' | 'regular' | 'ruim' | 'péssimo';
  recommendation: 'comprar' | 'manter' | 'vender' | 'evitar';
  breakdown: { valuation: number; profitability: number; dividends: number; quality: number };
  reasons: string[];
  alerts: string[];
}
export function calculateStockScore(input: StockScoreInput): StockScore
```

Adaptação do `AssetAnalyzer.calculateStockBreakdown` do easy-invest (thresholds idênticos), com duas diferenças de input: (a) indicadores vêm do CVM auditado via `calcAllIndicators`, não de scraper; (b) sem `age_minutes` (não há snapshot — `dataQuality` cobre isso na camada HTTP). Adição: alerta de endividamento via `netDebtToEquity` (disponível no Urano, não existia no easy-invest).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/stock-score.test.ts
import { describe, expect, test } from 'bun:test';
import { calculateStockScore } from '../../src/core/services/stock-score.ts';

describe('calculateStockScore', () => {
  test('empresa saudável: barata, rentável, boa pagadora → score máximo', () => {
    const s = calculateStockScore({
      ticker: 'SAUD3',
      price: 25,
      sector: 'Utilidade Pública',
      indicators: { peRatio: 6, pbRatio: 0.9, roe: 22, dividendYield: 9, netDebtToEquity: 0.3 },
    });
    expect(s.breakdown.valuation).toBe(30);      // P/L<8 (15) + P/VP<1 (15)
    expect(s.breakdown.profitability).toBe(25);  // ROE>20
    expect(s.breakdown.dividends).toBe(25);      // DY>8
    expect(s.breakdown.quality).toBe(20);        // setor defensivo (10) + preço>0 (10)
    expect(s.score).toBe(100);
    expect(s.rating).toBe('excelente');
    expect(s.recommendation).toBe('comprar');
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.alerts).toEqual([]);
  });

  test('empresa endividada: alerta de endividamento e sem pontos de valuation caro', () => {
    const s = calculateStockScore({
      ticker: 'DEBT3',
      price: 40,
      sector: 'Consumo Cíclico',
      indicators: { peRatio: 35, pbRatio: 5, roe: 6, dividendYield: 1.5, netDebtToEquity: 2.4 },
    });
    expect(s.breakdown.valuation).toBe(0);       // P/L≥25 e P/VP≥4
    expect(s.alerts).toContain('⚠️ P/L muito alto - ação pode estar cara');
    expect(s.alerts.some((a) => a.includes('Endividamento'))).toBe(true);
    expect(s.recommendation).not.toBe('comprar');
  });

  test('empresa em prejuízo: ROE negativo → alerta e score baixo', () => {
    const s = calculateStockScore({
      ticker: 'LOSS3',
      price: 5,
      sector: null,
      indicators: { peRatio: null, pbRatio: 0.4, roe: -12, dividendYield: null, netDebtToEquity: 1.0 },
    });
    expect(s.breakdown.profitability).toBe(0);
    expect(s.alerts).toContain('🔴 ROE negativo - empresa não está lucrando');
    expect(s.score).toBeLessThan(50);
    expect(['vender', 'evitar']).toContain(s.recommendation);
  });

  test('sem cotação: quality não ganha os 10 pontos de preço', () => {
    const s = calculateStockScore({
      ticker: 'NOPX3',
      price: null,
      sector: null,
      indicators: { peRatio: null, pbRatio: null, roe: 10, dividendYield: null, netDebtToEquity: null },
    });
    expect(s.breakdown.quality).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/stock-score.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Write implementation**

```ts
// src/core/services/stock-score.ts
import type { FinancialIndicators } from '../entities/company-fundamentals.ts';

/**
 * Score de ações 0-100 adaptado do AssetAnalyzer (easy-invest).
 * Thresholds idênticos à fonte; input vem de dados CVM auditados
 * (calcAllIndicators) + cotação Yahoo, não de scraper.
 */
export interface StockScoreInput {
  ticker: string;
  price: number | null;
  sector: string | null;
  indicators: Pick<
    FinancialIndicators,
    'peRatio' | 'pbRatio' | 'roe' | 'dividendYield' | 'netDebtToEquity'
  >;
}

export interface StockScore {
  ticker: string;
  score: number;
  rating: 'excelente' | 'bom' | 'regular' | 'ruim' | 'péssimo';
  recommendation: 'comprar' | 'manter' | 'vender' | 'evitar';
  breakdown: { valuation: number; profitability: number; dividends: number; quality: number };
  reasons: string[];
  alerts: string[];
}

const DEFENSIVE_SECTORS = ['Utilidade Pública', 'Saúde', 'Consumo'];

export function calculateStockScore(input: StockScoreInput): StockScore {
  const { ticker, price, sector } = input;
  const { peRatio: pl, pbRatio: pvp, roe, dividendYield: dy, netDebtToEquity } = input.indicators;

  const breakdown = { valuation: 0, profitability: 0, dividends: 0, quality: 0 };

  // Valuation (0-30): P/L e P/VP — quanto menor, melhor
  if (pl !== null && pl > 0) {
    if (pl < 8) breakdown.valuation += 15;
    else if (pl < 12) breakdown.valuation += 12;
    else if (pl < 18) breakdown.valuation += 8;
    else if (pl < 25) breakdown.valuation += 4;
  }
  if (pvp !== null && pvp > 0) {
    if (pvp < 1) breakdown.valuation += 15;
    else if (pvp < 1.5) breakdown.valuation += 12;
    else if (pvp < 2.5) breakdown.valuation += 8;
    else if (pvp < 4) breakdown.valuation += 4;
  }

  // Rentabilidade (0-25): ROE
  if (roe !== null) {
    if (roe > 20) breakdown.profitability += 25;
    else if (roe > 15) breakdown.profitability += 20;
    else if (roe > 10) breakdown.profitability += 15;
    else if (roe > 5) breakdown.profitability += 8;
    else if (roe > 0) breakdown.profitability += 3;
  }

  // Dividendos (0-25): DY
  if (dy !== null) {
    if (dy > 8) breakdown.dividends += 25;
    else if (dy > 6) breakdown.dividends += 20;
    else if (dy > 4) breakdown.dividends += 15;
    else if (dy > 2) breakdown.dividends += 10;
    else if (dy > 0) breakdown.dividends += 5;
  }

  // Qualidade (0-20): setor defensivo + cotação disponível
  if (sector && DEFENSIVE_SECTORS.some((s) => sector.includes(s))) {
    breakdown.quality += 10;
  }
  if (price !== null && price > 0) {
    breakdown.quality += 10;
  }

  const score = Math.round(
    breakdown.valuation + breakdown.profitability + breakdown.dividends + breakdown.quality,
  );

  return {
    ticker,
    score,
    rating: getRating(score),
    recommendation: getRecommendation(score),
    breakdown,
    reasons: buildReasons(input),
    alerts: buildAlerts(input),
  };
}

function getRating(score: number): StockScore['rating'] {
  if (score >= 80) return 'excelente';
  if (score >= 65) return 'bom';
  if (score >= 50) return 'regular';
  if (score >= 30) return 'ruim';
  return 'péssimo';
}

function getRecommendation(score: number): StockScore['recommendation'] {
  if (score >= 75) return 'comprar';
  if (score >= 60) return 'manter';
  if (score >= 40) return 'vender';
  return 'evitar';
}

function buildReasons(input: StockScoreInput): string[] {
  const { peRatio: pl, pbRatio: pvp, roe, dividendYield: dy } = input.indicators;
  const reasons: string[] = [];

  if (pl !== null && pl > 0 && pl < 12) reasons.push(`P/L atrativo de ${pl.toFixed(2)}`);
  if (pvp !== null && pvp > 0 && pvp < 1.5) reasons.push(`P/VP abaixo de 1.5 (${pvp.toFixed(2)})`);
  if (roe !== null && roe > 15) reasons.push(`ROE elevado de ${roe.toFixed(2)}%`);
  if (dy !== null && dy > 4) reasons.push(`Dividend Yield de ${dy.toFixed(2)}%`);
  if (input.sector) reasons.push(`Setor: ${input.sector}`);

  return reasons;
}

function buildAlerts(input: StockScoreInput): string[] {
  const { peRatio: pl, roe, dividendYield: dy, netDebtToEquity } = input.indicators;
  const alerts: string[] = [];

  if (pl !== null && pl > 30) alerts.push('⚠️ P/L muito alto - ação pode estar cara');
  if (roe !== null && roe < 0) alerts.push('🔴 ROE negativo - empresa não está lucrando');
  if (dy !== null && dy < 1) alerts.push('⚠️ Dividend Yield muito baixo');
  if (netDebtToEquity !== null && netDebtToEquity > 1.5) {
    alerts.push(`🔴 Endividamento elevado - dívida líquida ${netDebtToEquity.toFixed(2)}x o patrimônio`);
  }

  return alerts;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/core/stock-score.test.ts && bun run typecheck`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/services/stock-score.ts tests/core/stock-score.test.ts
git commit -m "feat: score de ações 0-100 com reasons e alerts (adaptado do easy-invest)"
```

---

### Task 9: `AnalysisService` (orquestração testável) + `known-fiis.data.ts`

**Files:**
- Create: `src/core/data/known-fiis.data.ts` (lista movida de `fiis.controller.ts:51-60`)
- Modify: `src/infra/http/controllers/fiis.controller.ts` (importar a lista movida)
- Modify: `src/infra/database/fundamentals-queries.ts` (novo método `getLatestByTicker` — LER o arquivo primeiro e seguir o padrão do objeto existente)
- Modify: `src/infra/http/controllers/fundamentals.controller.ts` (usar `getLatestByTicker` no lugar do JOIN inline — DRY)
- Create: `src/infra/services/analysis-service.ts`
- Test: `tests/infra/analysis-service.test.ts`

**Interfaces:**
- Consumes: `calcAllIndicators` (Task 6), `calculateStockScore` (Task 8), `FIIScoreCalculatorV4` (Task 7), `trailing12MonthsTotal` (Task 3), `DividendEvent`/`dividendsProvider` (Task 4), `stockQuoteService`, `StockQuote`
- Produces:

```ts
// src/core/data/known-fiis.data.ts
export interface FiiBasic { ticker: string; name: string; cnpj: string; segment: string; admin: string }
export const KNOWN_FIIS: FiiBasic[]

// src/infra/database/fundamentals-queries.ts — método novo
// retorna a MESMA shape do JOIN de fundamentals.controller (ticker, companyName,
// cnpj, fiscalYear, period, referenceDate, source, todos os campos financeiros,
// sector de companies, extractedAt) ou null
getLatestByTicker(ticker: string): Promise<LatestFundamentalsRow | null>

// src/infra/services/analysis-service.ts
export interface DataQuality { fundamentals: boolean; quotes: boolean; dividends: boolean }
export interface StockAnalysisResult {
  ticker: string; companyName: string; sector: string | null;
  price: number | null; referenceDate: string;
  analysis: StockScore; indicators: FinancialIndicators; dataQuality: DataQuality;
}
export interface FiiAnalysisResult {
  ticker: string; name: string | null; segment: string | null;
  price: number | null; score: FIIScoreV4; dataQuality: DataQuality;
}
export interface AnalysisDeps {
  getFundamentals: (ticker: string) => Promise<LatestFundamentalsRow | null>;
  getQuote: (ticker: string) => Promise<StockQuote>;
  getDividends: (ticker: string, assetType: 'stock' | 'fii') => Promise<DividendEvent[]>;
}
export class AnalysisService {
  constructor(deps?: AnalysisDeps); // default: fundamentalsQueries/stockQuoteService/dividendsProvider reais
  analyzeStock(ticker: string): Promise<StockAnalysisResult | null>; // null = sem fundamentals (controller → 404)
  analyzeFii(ticker: string): Promise<FiiAnalysisResult>;
}
export const analysisService: AnalysisService
```

Fluxo `analyzeStock` (spec §4): fundamentals (null→null) → quote (falha→price null, quotes:false) → proventos 12m (provider já degrada) → DY = soma12m/preço*100 → `calcAllIndicators(f, price ?? 0, dy)` → `calculateStockScore`. Fluxo `analyzeFii`: quote (price + `liquidity = volume * price`) → proventos fii → DY → `FIIScoreCalculatorV4.calculate({ pvp: null, vacancy: undefined, ... })`; `name`/`segment` de `KNOWN_FIIS` se listado (senão null — score roda mesmo assim, type inferred).

- [ ] **Step 1: Mover KNOWN_FIIS**

Criar `src/core/data/known-fiis.data.ts` com a interface `FiiBasic` e o array `KNOWN_FIIS` copiados de `fiis.controller.ts` (8 FIIs, conteúdo idêntico). Em `fiis.controller.ts` remover a definição local e importar:

```ts
import { KNOWN_FIIS, type FiiBasic } from '../../../core/data/known-fiis.data.ts';
```

Run: `bun test && bun run typecheck` → PASS.

- [ ] **Step 2: `getLatestByTicker` em fundamentals-queries**

LER `src/infra/database/fundamentals-queries.ts` e adicionar método ao objeto existente, movendo o JOIN de `fundamentals.controller.ts` (mesma seleção de campos, MAIS `sector: companies.sector`). Atualizar `getLatestFundamentalsController` para chamar `fundamentalsQueries.getLatestByTicker(ticker)` e remover o JOIN inline. Comportamento HTTP idêntico.

Run: `bun test && bun run typecheck` → PASS.

- [ ] **Step 3: Write failing test do AnalysisService**

```ts
// tests/infra/analysis-service.test.ts
import { describe, expect, test } from 'bun:test';
import { AnalysisService } from '../../src/infra/services/analysis-service.ts';
import type { StockQuote } from '../../src/infra/services/stock-quote-service.ts';

function monthsAgoIso(n: number): string {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

const fundamentalsRow = {
  ticker: 'TEST3', companyName: 'Teste SA', cnpj: '00000000000100', sector: 'Saúde',
  fiscalYear: 2025, period: 'ANUAL', referenceDate: '2025-12-31', source: 'DFP',
  netIncome: 90, netIncomeParent: 100, revenue: 500, cogs: -200, ebit: 150,
  totalAssets: 1000, totalLiabilities: 400, cash: 100, operatingCashFlow: 120,
  equity: 600, sharesOutstanding: 100, extractedAt: new Date(),
};

const quote: StockQuote = {
  ticker: 'TEST3', symbol: 'TEST3.SA', price: 12, currency: 'BRL', change: 0,
  changePercent: 0, previousClose: 12, open: 12, dayHigh: 12, dayLow: 12,
  volume: 1_000_000, marketCap: null, updatedAt: new Date().toISOString(),
};

const dividends = [
  { date: monthsAgoIso(2), value: 0.6, type: 'Dividendo' },
  { date: monthsAgoIso(8), value: 0.6, type: 'JCP' },
];

describe('AnalysisService.analyzeStock', () => {
  test('fluxo completo: indicadores com DY real + score + dataQuality tudo true', async () => {
    const service = new AnalysisService({
      getFundamentals: async () => fundamentalsRow,
      getQuote: async () => quote,
      getDividends: async () => dividends,
    });
    const result = await service.analyzeStock('TEST3');
    expect(result).not.toBeNull();
    expect(result!.price).toBe(12);
    expect(result!.indicators.dividendYield).toBe(10); // (0.6+0.6)/12 * 100
    expect(result!.analysis.score).toBeGreaterThan(0);
    expect(result!.dataQuality).toEqual({ fundamentals: true, quotes: true, dividends: true });
  });

  test('sem fundamentals retorna null (controller vira 404)', async () => {
    const service = new AnalysisService({
      getFundamentals: async () => null,
      getQuote: async () => quote,
      getDividends: async () => dividends,
    });
    expect(await service.analyzeStock('XXXX9')).toBeNull();
  });

  test('cotação indisponível degrada: price null, análise ainda retorna', async () => {
    const service = new AnalysisService({
      getFundamentals: async () => fundamentalsRow,
      getQuote: async () => { throw new Error('Yahoo fora'); },
      getDividends: async () => [],
    });
    const result = await service.analyzeStock('TEST3');
    expect(result).not.toBeNull();
    expect(result!.price).toBeNull();
    expect(result!.indicators.peRatio).toBeNull();
    expect(result!.dataQuality).toEqual({ fundamentals: true, quotes: false, dividends: false });
  });
});

describe('AnalysisService.analyzeFii', () => {
  test('FII conhecido: score V4 com liquidez = volume * preço e pvp null', async () => {
    const service = new AnalysisService({
      getFundamentals: async () => null,
      getQuote: async () => ({ ...quote, ticker: 'HGLG11', price: 160, volume: 50_000 }),
      getDividends: async () => Array.from({ length: 12 }, (_, i) => ({
        date: monthsAgoIso(i), value: 1.1, type: 'Rendimento',
      })),
    });
    const result = await service.analyzeFii('HGLG11');
    expect(result.name).toBe('CSHG Logística FII');
    expect(result.score.type).toBe('tijolo');
    expect(result.score.asset_quality.valuation_score).toBe(50); // pvp null → neutro
    expect(result.dataQuality.quotes).toBe(true);
    expect(result.dataQuality.fundamentals).toBe(false); // FII não usa CVM fundamentals
  });

  test('FII fora da lista: score roda com type inferred e name null', async () => {
    const service = new AnalysisService({
      getFundamentals: async () => null,
      getQuote: async () => { throw new Error('sem cotação'); },
      getDividends: async () => [],
    });
    const result = await service.analyzeFii('ZZZZ11');
    expect(result.name).toBeNull();
    expect(result.score.type_source).toBe('inferred');
    expect(result.dataQuality).toEqual({ fundamentals: false, quotes: false, dividends: false });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/infra/analysis-service.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 5: Write implementation**

```ts
// src/infra/services/analysis-service.ts
import { fundamentalsQueries } from '../database/fundamentals-queries.ts';
import { stockQuoteService, type StockQuote } from './stock-quote-service.ts';
import { dividendsProvider, type DividendEvent } from './dividends-provider.ts';
import { calcAllIndicators } from '../../core/services/indicators.ts';
import { calculateStockScore, type StockScore } from '../../core/services/stock-score.ts';
import { FIIScoreCalculatorV4, type FIIScoreV4 } from '../../core/services/fii-score.ts';
import { trailing12MonthsTotal } from '../../core/services/dividends-analyzer.ts';
import { KNOWN_FIIS } from '../../core/data/known-fiis.data.ts';
import type { FinancialIndicators } from '../../core/entities/company-fundamentals.ts';

export interface DataQuality {
  fundamentals: boolean;
  quotes: boolean;
  dividends: boolean;
}

export interface StockAnalysisResult {
  ticker: string;
  companyName: string;
  sector: string | null;
  price: number | null;
  referenceDate: string;
  analysis: StockScore;
  indicators: FinancialIndicators;
  dataQuality: DataQuality;
}

export interface FiiAnalysisResult {
  ticker: string;
  name: string | null;
  segment: string | null;
  price: number | null;
  score: FIIScoreV4;
  dataQuality: DataQuality;
}

type LatestFundamentalsRow = NonNullable<
  Awaited<ReturnType<typeof fundamentalsQueries.getLatestByTicker>>
>;

export interface AnalysisDeps {
  getFundamentals: (ticker: string) => Promise<LatestFundamentalsRow | null>;
  getQuote: (ticker: string) => Promise<StockQuote>;
  getDividends: (ticker: string, assetType: 'stock' | 'fii') => Promise<DividendEvent[]>;
}

const defaultDeps: AnalysisDeps = {
  getFundamentals: (ticker) => fundamentalsQueries.getLatestByTicker(ticker),
  getQuote: (ticker) => stockQuoteService.getQuote(ticker),
  getDividends: (ticker, assetType) => dividendsProvider.getDividends(ticker, assetType),
};

/**
 * Orquestra o fluxo de análise (spec §4). Fonte indisponível degrada
 * (campos null + dataQuality), nunca falha (spec §5).
 */
export class AnalysisService {
  constructor(private readonly deps: AnalysisDeps = defaultDeps) {}

  async analyzeStock(ticker: string): Promise<StockAnalysisResult | null> {
    const f = await this.deps.getFundamentals(ticker);
    if (!f) return null;

    const price = await this.tryGetPrice(ticker);
    const dividends = await this.deps.getDividends(ticker, 'stock');

    const dividendYield = this.calcDy(dividends, price);
    const indicators = calcAllIndicators(
      f as unknown as Record<string, unknown>,
      price ?? 0,
      dividendYield,
    );

    const analysis = calculateStockScore({
      ticker: ticker.toUpperCase(),
      price,
      sector: f.sector ?? null,
      indicators,
    });

    return {
      ticker: ticker.toUpperCase(),
      companyName: f.companyName,
      sector: f.sector ?? null,
      price,
      referenceDate: String(f.referenceDate).slice(0, 10),
      analysis,
      indicators,
      dataQuality: {
        fundamentals: true,
        quotes: price !== null,
        dividends: dividends.length > 0,
      },
    };
  }

  async analyzeFii(ticker: string): Promise<FiiAnalysisResult> {
    const upper = ticker.toUpperCase();
    const known = KNOWN_FIIS.find((f) => f.ticker === upper) ?? null;

    let price: number | null = null;
    let liquidity = 0;
    try {
      const quote = await this.deps.getQuote(upper);
      price = quote.price;
      liquidity = quote.volume * quote.price; // volume financeiro diário (R$)
    } catch { /* degrada */ }

    const dividends = await this.deps.getDividends(upper, 'fii');
    const dy = this.calcDy(dividends, price) ?? 0;

    const score = FIIScoreCalculatorV4.calculate({
      ticker: upper,
      price: price ?? 0,
      dy,
      pvp: null, // gap conhecido: sem fonte confiável de P/VP de FII (spec §2a)
      liquidity,
      dividendsHistory: dividends,
    });

    return {
      ticker: upper,
      name: known?.name ?? null,
      segment: known?.segment ?? null,
      price,
      score,
      dataQuality: {
        fundamentals: false, // FIIs não usam fundamentals CVM neste ciclo
        quotes: price !== null,
        dividends: dividends.length > 0,
      },
    };
  }

  private async tryGetPrice(ticker: string): Promise<number | null> {
    try {
      const quote = await this.deps.getQuote(ticker);
      return quote.price;
    } catch {
      return null;
    }
  }

  private calcDy(dividends: DividendEvent[], price: number | null): number | null {
    if (price === null || price <= 0) return null;
    const total = trailing12MonthsTotal(dividends);
    if (total <= 0) return null;
    return +((total / price) * 100).toFixed(2);
  }
}

export const analysisService = new AnalysisService();
```

Nota: se a inferência `LatestFundamentalsRow` brigar com o tipo real do Drizzle, declarar a interface explicitamente com os campos do Step 2.

- [ ] **Step 6: Run tests e commit**

Run: `bun test && bun run typecheck`
Expected: PASS

```bash
git add src/core/data/known-fiis.data.ts src/infra/http/controllers/fiis.controller.ts src/infra/database/fundamentals-queries.ts src/infra/http/controllers/fundamentals.controller.ts src/infra/services/analysis-service.ts tests/infra/analysis-service.test.ts
git commit -m "feat: AnalysisService orquestra fundamentals+cotação+proventos com degradação"
```

---

### Task 10: `analysis.controller.ts` + rotas `/v1/analysis/*`

**Files:**
- Create: `src/infra/http/controllers/analysis.controller.ts`
- Modify: `src/infra/http/routes/index.ts`

**Interfaces:**
- Consumes: `analysisService` (Task 9), `getOrSet` (redis)
- Produces: `GET /v1/analysis/stocks/:ticker` (cache 900s) e `GET /v1/analysis/fiis/:ticker` (cache 900s). 404 de stock cita `worker:sync` (spec §5).

- [ ] **Step 1: Write controller**

```ts
// src/infra/http/controllers/analysis.controller.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrSet } from '../../services/redis.ts';
import { analysisService } from '../../services/analysis-service.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const paramsSchema = z.object({
  ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
});

const ANALYSIS_CACHE_TTL = 900; // 15 min — análise depende de cotação (spec §2c)

/** GET /v1/analysis/stocks/:ticker */
export async function analyzeStockController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  const result = await getOrSet(`analysis:stock:${ticker}`, ANALYSIS_CACHE_TTL, () =>
    analysisService.analyzeStock(ticker),
  );

  if (!result) {
    reply.status(404).send({
      error: 'NotFound',
      message: `Sem fundamentos para "${ticker}". Rode "bun run worker:sync --ticker ${ticker}" para sincronizar dados da CVM.`,
    });
    return;
  }

  reply.send(result);
}

/** GET /v1/analysis/fiis/:ticker */
export async function analyzeFiiController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  const result = await getOrSet(`analysis:fii:${ticker}`, ANALYSIS_CACHE_TTL, () =>
    analysisService.analyzeFii(ticker),
  );

  reply.send(result);
}
```

Cuidado com cache de null: `getOrSet` só ignora cache em erro — `analyzeStock` retornando `null` seria serializado. `JSON.stringify(null)` grava `"null"` e `JSON.parse` devolve `null` — comportamento correto (404 cacheado 15min é aceitável). Nenhuma mudança necessária; deixar comentário no controller se desejar.

- [ ] **Step 2: Registrar rotas**

Em `src/infra/http/routes/index.ts`, adicionar import e rotas:

```ts
import { analyzeStockController, analyzeFiiController } from '../controllers/analysis.controller.ts';
```

```ts
  // Analysis (motor de análise)
  app.get('/analysis/stocks/:ticker', analyzeStockController);
  app.get('/analysis/fiis/:ticker', analyzeFiiController);
```

- [ ] **Step 3: Verificar e commitar**

Run: `bun test && bun run typecheck`
Expected: PASS

Verificação manual (opcional, com stack local): `curl -s localhost:3000/v1/analysis/fiis/HGLG11` → JSON com `score.overall_score` e `dataQuality`.

```bash
git add src/infra/http/controllers/analysis.controller.ts src/infra/http/routes/index.ts
git commit -m "feat: endpoints GET /v1/analysis/stocks/:ticker e /v1/analysis/fiis/:ticker"
```

---

### Task 11: Ranking + `minScore` no screener

**Files:**
- Modify: `src/infra/http/controllers/analysis.controller.ts` (novo controller de ranking)
- Modify: `src/infra/http/controllers/screener.controller.ts` (param `minScore`)
- Modify: `src/infra/http/routes/index.ts`

**Interfaces:**
- Consumes: `analysisService`, `batchWithConcurrency` (Task 1), `KNOWN_FIIS`, `db`
- Produces: `GET /v1/analysis/ranking?type=stock|fii&limit=N` (default 10, max 50, cache 1800s); screener aceita `minScore` (0-100).

- [ ] **Step 1: Ranking controller (adicionar em analysis.controller.ts)**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { batchWithConcurrency } from '../../../shared/retry.ts';
import { KNOWN_FIIS } from '../../../core/data/known-fiis.data.ts';
```

```ts
const rankingQuerySchema = z.object({
  type: z.enum(['stock', 'fii']).default('stock'),
  limit: z.string().optional().default('10').transform(Number).pipe(z.number().int().min(1).max(50)),
});

const RANKING_CACHE_TTL = 1800; // 30 min (spec §2c)

/** GET /v1/analysis/ranking?type=stock|fii&limit=N */
export async function rankingController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = rankingQuerySchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');
  const { type, limit } = parsed.data;

  const ranking = await getOrSet(`analysis:ranking:${type}:${limit}`, RANKING_CACHE_TTL, async () => {
    if (type === 'fii') {
      const results = await batchWithConcurrency(
        KNOWN_FIIS.map((f) => f.ticker),
        (ticker) => analysisService.analyzeFii(ticker),
        5,
      );
      return results
        .sort((a, b) => b.score.overall_score - a.score.overall_score)
        .slice(0, limit)
        .map((r) => ({
          ticker: r.ticker,
          name: r.name,
          segment: r.segment,
          price: r.price,
          score: r.score.overall_score,
          rating: r.score.overall_rating,
          recommendation: r.score.recommendation.action,
          dataQuality: r.dataQuality,
        }));
    }

    // stocks: base = empresas com fundamentals no banco (spec §2c)
    const rows = await db.execute(sql`
      SELECT DISTINCT c.ticker
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
    `);
    const tickers = (rows as unknown as Array<{ ticker: string }>).map((r) => r.ticker);

    const results = await batchWithConcurrency(
      tickers,
      (ticker) => analysisService.analyzeStock(ticker).catch(() => null),
      5,
    );
    return results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.analysis.score - a.analysis.score)
      .slice(0, limit)
      .map((r) => ({
        ticker: r.ticker,
        companyName: r.companyName,
        sector: r.sector,
        price: r.price,
        score: r.analysis.score,
        rating: r.analysis.rating,
        recommendation: r.analysis.recommendation,
        dataQuality: r.dataQuality,
      }));
  });

  reply.send({ type, total: ranking.length, data: ranking });
}
```

Registrar em routes: `app.get('/analysis/ranking', rankingController);`

- [ ] **Step 2: Screener minScore**

Em `screener.controller.ts`:
1. Schema: adicionar `minScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),`
2. Imports: `import { analysisService } from '../../services/analysis-service.ts';` e `import { batchWithConcurrency } from '../../../shared/retry.ts';`
3. Após montar `data`, antes do `reply.send`:

```ts
  let result = data;
  if (filters.minScore !== undefined) {
    const analyses = await batchWithConcurrency(
      result.map((r) => String(r.ticker)),
      (ticker) => analysisService.analyzeStock(ticker).catch(() => null),
      5,
    );
    const scoreByTicker = new Map(
      analyses
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a.ticker, a.analysis.score]),
    );
    result = result
      .map((r) => ({ ...r, score: scoreByTicker.get(String(r.ticker)) ?? null }))
      .filter((r) => r.score !== null && r.score >= filters.minScore!);
  }

  reply.send({
    filters: { ...antigos, minScore: filters.minScore ?? null },
    total: result.length,
    data: result,
  });
```

- [ ] **Step 3: Verificar e commitar**

Run: `bun test && bun run typecheck`
Expected: PASS

```bash
git add src/infra/http/controllers/analysis.controller.ts src/infra/http/controllers/screener.controller.ts src/infra/http/routes/index.ts
git commit -m "feat: ranking por score e filtro minScore no screener"
```

---

### Task 12: Middleware de api-key + fix `generateApiKey` + bootstrap CLI

**Files:**
- Create: `src/infra/http/middleware/auth.ts`
- Modify: `src/infra/http/controllers/auth.controller.ts` (linhas 21-27, `generateApiKey`)
- Modify: `src/server.ts` (registrar hook antes das rotas)
- Create: `scripts/create-api-key.ts`
- Modify: `package.json` (script `key:create`)
- Test: `tests/infra/auth-middleware.test.ts`

**Interfaces:**
- Produces: `buildApiKeyHook(lookup?: KeyLookup, cacheGet?, cacheSet?): onRequest hook`; `type KeyLookup = (key: string) => Promise<boolean>`. Rota pública: só `/v1/healthcheck`. 401 `{ error: 'Unauthorized' }` sem key ou key inválida.

**Segurança:** `Math.random()` para credencial = CWE-338 (PRNG fraco); fix usa `crypto.randomBytes` (spec §3a). Bootstrap: com auth em `POST /v1/keys`, a primeira key só nasce via CLI (`bun run key:create`) — sem isso o sistema tranca a si mesmo.

- [ ] **Step 1: Write the failing test**

```ts
// tests/infra/auth-middleware.test.ts
import { describe, expect, test } from 'bun:test';
import { buildApiKeyHook } from '../../src/infra/http/middleware/auth.ts';

type Sent = { status: number; body: unknown } | null;

function fakeReply() {
  const sent: { value: Sent } = { value: null };
  const reply = {
    status(code: number) {
      return { send(body: unknown) { sent.value = { status: code, body }; } };
    },
  };
  return { reply, sent };
}

function fakeRequest(url: string, key?: string) {
  return { url, headers: key ? { 'x-api-key': key } : {} };
}

const noCacheGet = async () => null;
const noCacheSet = async () => {};

describe('apiKeyHook', () => {
  test('healthcheck é público', async () => {
    const hook = buildApiKeyHook(async () => false, noCacheGet, noCacheSet);
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/healthcheck') as never, reply as never);
    expect(sent.value).toBeNull();
  });

  test('sem header x-api-key → 401', async () => {
    const hook = buildApiKeyHook(async () => true, noCacheGet, noCacheSet);
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/fundamentals/PETR4') as never, reply as never);
    expect(sent.value?.status).toBe(401);
  });

  test('key inválida → 401', async () => {
    const hook = buildApiKeyHook(async () => false, noCacheGet, noCacheSet);
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/fundamentals/PETR4', 'ur_invalida') as never, reply as never);
    expect(sent.value?.status).toBe(401);
  });

  test('key válida passa', async () => {
    const hook = buildApiKeyHook(async (k) => k === 'ur_boa', noCacheGet, noCacheSet);
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/fundamentals/PETR4', 'ur_boa') as never, reply as never);
    expect(sent.value).toBeNull();
  });

  test('cache hit não consulta o lookup', async () => {
    let lookupCalls = 0;
    const hook = buildApiKeyHook(
      async () => { lookupCalls++; return true; },
      async () => '1', // cache sempre acerta
      noCacheSet,
    );
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'ur_cacheada') as never, reply as never);
    expect(sent.value).toBeNull();
    expect(lookupCalls).toBe(0);
  });

  test('querystring não vaza no matching de rota pública', async () => {
    const hook = buildApiKeyHook(async () => false, noCacheGet, noCacheSet);
    const { reply, sent } = fakeReply();
    await hook(fakeRequest('/v1/companies?x=/v1/healthcheck') as never, reply as never);
    expect(sent.value?.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/infra/auth-middleware.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Write middleware**

```ts
// src/infra/http/middleware/auth.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys } from '../../database/schema.ts';
import { redis } from '../../services/redis.ts';

/** Rotas acessíveis sem api-key (spec §3a) */
const PUBLIC_PATHS = new Set(['/v1/healthcheck']);

const KEY_CACHE_TTL_SECONDS = 60;

export type KeyLookup = (key: string) => Promise<boolean>;
type CacheGet = (cacheKey: string) => Promise<string | null>;
type CacheSet = (cacheKey: string, value: string, ttlSeconds: number) => Promise<void>;

/** Valida a key no banco e atualiza last_used_at (fire-and-forget) */
export const dbKeyLookup: KeyLookup = async (key) => {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.key, key), eq(apiKeys.active, true)))
    .limit(1);

  if (!row) return false;

  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => { /* atualização de auditoria não bloqueia a request */ });

  return true;
};

const redisCacheGet: CacheGet = async (cacheKey) => {
  try {
    return await redis.get(cacheKey);
  } catch {
    return null; // Redis fora → valida direto no banco
  }
};

const redisCacheSet: CacheSet = async (cacheKey, value, ttl) => {
  try {
    await redis.setex(cacheKey, ttl, value);
  } catch { /* cache é otimização, não requisito */ }
};

/**
 * Fastify onRequest hook: exige header `x-api-key` válido em todas as rotas
 * exceto PUBLIC_PATHS. Cache Redis 60s evita um SELECT por request (spec §3a).
 */
export function buildApiKeyHook(
  lookup: KeyLookup = dbKeyLookup,
  cacheGet: CacheGet = redisCacheGet,
  cacheSet: CacheSet = redisCacheSet,
) {
  return async function apiKeyHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(path)) return;

    const key = request.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Header x-api-key obrigatório. Crie uma chave com "bun run key:create".',
      });
      return;
    }

    const cacheKey = `apikey:${key}`;
    if ((await cacheGet(cacheKey)) === '1') return;

    const valid = await lookup(key);
    if (!valid) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }

    await cacheSet(cacheKey, '1', KEY_CACHE_TTL_SECONDS);
  };
}
```

- [ ] **Step 4: Fix generateApiKey (CWE-338) e registrar hook**

Em `auth.controller.ts`, substituir a função (linhas 21-27):

```ts
import { randomBytes } from 'node:crypto';

/** Gera key com CSPRNG — Math.random não serve para credenciais (CWE-338) */
function generateApiKey(): string {
  const segments = Array.from({ length: 4 }, () => randomBytes(4).toString('hex'));
  return `ur_${segments.join('_')}`;
}
```

Em `server.ts`, antes de `await app.register(routesPlugin, ...)`:

```ts
import { buildApiKeyHook } from './infra/http/middleware/auth.ts';
```

```ts
// Auth por api-key em todas as rotas (healthcheck é público)
app.addHook('onRequest', buildApiKeyHook());
```

- [ ] **Step 5: Bootstrap CLI**

```ts
// scripts/create-api-key.ts
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db } from '../src/infra/database/connection.ts';
import { apiKeys } from '../src/infra/database/schema.ts';

const name = process.argv[2] ?? 'default';
const key = `ur_${Array.from({ length: 4 }, () => randomBytes(4).toString('hex')).join('_')}`;

const [row] = await db.insert(apiKeys).values({ name, key }).returning();

console.log(`API key criada: ${row!.name}`);
console.log(`  ${row!.key}`);
console.log('Guarde esta chave — ela não será exibida novamente.');
process.exit(0);
```

Em `package.json`, adicionar em scripts: `"key:create": "bun run scripts/create-api-key.ts"`.

- [ ] **Step 6: Run tests e commit**

Run: `bun test && bun run typecheck`
Expected: PASS (6 testes novos)

Verificação manual (opcional, stack local): sem header → 401; com key criada via `bun run key:create` → 200; `/v1/healthcheck` sem key → 200.

```bash
git add src/infra/http/middleware/auth.ts src/infra/http/controllers/auth.controller.ts src/server.ts scripts/create-api-key.ts package.json tests/infra/auth-middleware.test.ts
git commit -m "feat: auth por api-key com cache Redis e CSPRNG na geração de chaves"
```

---

### Task 13: Rebalance com posição atual

**Files:**
- Create: `src/core/services/rebalance-calc.ts`
- Modify: `src/core/use-cases/execute-rebalance.ts`
- Modify: `src/infra/http/controllers/rebalance.controller.ts` (bodySchema)
- Test: `tests/core/rebalance-calc.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TargetAsset { ticker: string; targetPercent: number }
export interface CurrentPosition { ticker: string; quantity: number }
export interface RebalanceCalcResult {
  recommendations: AssetRebalanceRecommendation[];
  totalEstimatedCost: number; // soma só dos BUYs
  remainingCash: number;      // availableAmount + vendas - compras
}
export function computeRecommendations(
  assets: TargetAsset[],
  prices: Map<string, number>,
  availableAmount: number,
  currentPositions?: CurrentPosition[],
): RebalanceCalcResult
```

Regras: sem `currentPositions` → comportamento atual EXATO (targetValue = availableAmount×pct, BUY/HOLD, currentQuantity 0). Com posições: patrimônio = availableAmount + Σ(qty×preço das posições cujo ticker está na carteira; tickers fora da carteira são ignorados); targetValue = patrimônio×pct; diff = targetValue − valorAtual; BUY se diff>0 e floor(diff/preço)>0; SELL se diff<0 e floor(−diff/preço)>0; senão HOLD. Sem persistência (spec §3b).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/rebalance-calc.test.ts
import { describe, expect, test } from 'bun:test';
import { computeRecommendations } from '../../src/core/services/rebalance-calc.ts';

const prices = new Map([['PETR4', 40], ['VALE3', 60]]);
const assets = [
  { ticker: 'PETR4', targetPercent: 50 },
  { ticker: 'VALE3', targetPercent: 50 },
];

describe('computeRecommendations', () => {
  test('sem posições: paridade com comportamento atual (só BUY/HOLD)', () => {
    const r = computeRecommendations(assets, prices, 1000);
    const petr = r.recommendations.find((x) => x.ticker === 'PETR4')!;
    expect(petr.currentQuantity).toBe(0);
    expect(petr.suggestedAction).toBe('BUY');
    expect(petr.suggestedQuantity).toBe(12); // floor(500/40)
    expect(petr.estimatedCost).toBe(480);
    const vale = r.recommendations.find((x) => x.ticker === 'VALE3')!;
    expect(vale.suggestedQuantity).toBe(8); // floor(500/60)
    expect(r.totalEstimatedCost).toBe(960);
    expect(r.remainingCash).toBe(40);
  });

  test('com posições: sugere SELL quando alocação atual excede o alvo', () => {
    // Patrimônio = 1000 aporte + 50×40 (PETR4) + 0 = 3000; alvo por ativo 1500
    const r = computeRecommendations(assets, prices, 1000, [
      { ticker: 'PETR4', quantity: 50 }, // 2000 investidos → 500 acima do alvo
    ]);
    const petr = r.recommendations.find((x) => x.ticker === 'PETR4')!;
    expect(petr.currentQuantity).toBe(50);
    expect(petr.suggestedAction).toBe('SELL');
    expect(petr.suggestedQuantity).toBe(12); // floor(500/40)
    const vale = r.recommendations.find((x) => x.ticker === 'VALE3')!;
    expect(vale.suggestedAction).toBe('BUY');
    expect(vale.suggestedQuantity).toBe(25); // floor(1500/60)
  });

  test('posição de ticker fora da carteira é ignorada', () => {
    const r = computeRecommendations(assets, prices, 1000, [
      { ticker: 'ITSA4', quantity: 999 },
    ]);
    expect(r.recommendations.every((x) => x.currentQuantity === 0)).toBe(true);
  });

  test('preço indisponível → HOLD com quantidade 0', () => {
    const r = computeRecommendations(
      [{ ticker: 'SEMPRECO3', targetPercent: 100 }],
      new Map(),
      1000,
    );
    expect(r.recommendations[0]!.suggestedAction).toBe('HOLD');
    expect(r.recommendations[0]!.suggestedQuantity).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/rebalance-calc.test.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Write implementation**

```ts
// src/core/services/rebalance-calc.ts
import type { AssetRebalanceRecommendation } from '../entities/asset.ts';

export interface TargetAsset {
  ticker: string;
  targetPercent: number;
}

export interface CurrentPosition {
  ticker: string;
  quantity: number;
}

export interface RebalanceCalcResult {
  recommendations: AssetRebalanceRecommendation[];
  totalEstimatedCost: number;
  remainingCash: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Cálculo puro do rebalanceamento (conceito do PortfolioBuilder.suggestRebalancing).
 * Sem posições: aloca o aporte pelos percentuais-alvo (comportamento original).
 * Com posições: rebalanceia o patrimônio total, sugerindo SELL no excesso.
 * Posições de tickers fora da carteira são ignoradas. Sem persistência (spec §3b).
 */
export function computeRecommendations(
  assets: TargetAsset[],
  prices: Map<string, number>,
  availableAmount: number,
  currentPositions: CurrentPosition[] = [],
): RebalanceCalcResult {
  const positionByTicker = new Map(
    currentPositions.map((p) => [p.ticker.toUpperCase(), p.quantity]),
  );
  const hasPositions = currentPositions.length > 0;

  const currentValueOf = (ticker: string): number => {
    const qty = positionByTicker.get(ticker.toUpperCase()) ?? 0;
    return qty * (prices.get(ticker) ?? 0);
  };

  const portfolioValue = hasPositions
    ? availableAmount + assets.reduce((sum, a) => sum + currentValueOf(a.ticker), 0)
    : availableAmount;

  const recommendations: AssetRebalanceRecommendation[] = [];
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const asset of assets) {
    const price = prices.get(asset.ticker) ?? 0;
    const currentQuantity = positionByTicker.get(asset.ticker.toUpperCase()) ?? 0;
    const currentValue = currentQuantity * price;

    const targetValue = portfolioValue * (asset.targetPercent / 100);
    const diff = targetValue - currentValue;

    let suggestedAction: AssetRebalanceRecommendation['suggestedAction'] = 'HOLD';
    let suggestedQuantity = 0;

    if (price > 0) {
      if (diff > 0) {
        suggestedQuantity = Math.floor(diff / price);
        if (suggestedQuantity > 0) suggestedAction = 'BUY';
      } else if (diff < 0) {
        suggestedQuantity = Math.floor(-diff / price);
        if (suggestedQuantity > 0) suggestedAction = 'SELL';
      }
    }

    const estimatedCost = round2(suggestedQuantity * price);
    if (suggestedAction === 'BUY') totalBuyCost += estimatedCost;
    if (suggestedAction === 'SELL') totalSellProceeds += estimatedCost;

    recommendations.push({
      ticker: asset.ticker,
      currentQuantity,
      currentPrice: round2(price),
      targetAllocationPercent: asset.targetPercent,
      suggestedAction,
      suggestedQuantity,
      estimatedCost,
    });
  }

  return {
    recommendations,
    totalEstimatedCost: round2(totalBuyCost),
    remainingCash: round2(availableAmount + totalSellProceeds - totalBuyCost),
  };
}
```

- [ ] **Step 4: Rewire use case e controller**

`execute-rebalance.ts`: adicionar `currentPositions?: Array<{ ticker: string; quantity: number }>` ao `ExecuteRebalanceInput`; buscar cotações para a UNIÃO de tickers (`[...new Set([...assets.map(a => a.ticker), ...(currentPositions ?? []).map(p => p.ticker.toUpperCase())])]`); substituir o loop de cálculo (linhas 50-81) por:

```ts
    const prices = new Map<string, number>();
    for (const [ticker, quote] of quotes) prices.set(ticker, quote.price);

    const calc = computeRecommendations(
      assets.map((a) => ({ ticker: a.ticker, targetPercent: Number(a.targetPercent) })),
      prices,
      availableAmount,
      input.currentPositions ?? [],
    );

    return {
      walletId,
      availableAmount,
      totalEstimatedCost: calc.totalEstimatedCost,
      remainingCash: calc.remainingCash,
      executedAt: new Date(),
      recommendations: calc.recommendations,
    };
```

com `import { computeRecommendations } from '../services/rebalance-calc.ts';`

`rebalance.controller.ts`: bodySchema vira:

```ts
const bodySchema = z.object({
  availableAmount: z.number().positive(),
  currentPositions: z
    .array(z.object({
      ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
      quantity: z.number().int().nonnegative(),
    }))
    .optional(),
});
```

e repassar `currentPositions` ao use case.

- [ ] **Step 5: Run tests e commit**

Run: `bun test && bun run typecheck`
Expected: PASS

```bash
git add src/core/services/rebalance-calc.ts src/core/use-cases/execute-rebalance.ts src/infra/http/controllers/rebalance.controller.ts tests/core/rebalance-calc.test.ts
git commit -m "feat: rebalance aceita currentPositions e sugere SELL no excesso"
```

---

### Task 14: Verificação final

- [ ] **Step 1: Suíte completa**

Run: `bun test`
Expected: todos os testes PASS (≈40 testes em 9 arquivos)

Run: `bun run typecheck`
Expected: sem erros

- [ ] **Step 2: Smoke test end-to-end (exige Postgres + Redis locais)**

```bash
bun run dev &
sleep 2
curl -s localhost:3000/v1/healthcheck                        # 200 sem key
curl -s localhost:3000/v1/companies | head -c 200            # 401 sem key
KEY=$(bun run key:create smoke | sed -n 2p | tr -d ' ')
curl -s -H "x-api-key: $KEY" localhost:3000/v1/analysis/fiis/HGLG11 | head -c 400
curl -s -H "x-api-key: $KEY" localhost:3000/v1/analysis/stocks/PETR4 | head -c 400
kill %1
```

Expected: healthcheck 200; sem key 401; análises retornam JSON com `dataQuality`.

- [ ] **Step 3: Encerramento**

Usar a skill superpowers:finishing-a-development-branch para decidir merge/PR/cleanup.
