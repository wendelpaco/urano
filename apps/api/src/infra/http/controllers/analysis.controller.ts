/**
 * Analysis Controller — Endpoints de análise de ações e FIIs.
 *
 * Onda 2c: score + breakdown + reasons + alerts + indicadores.
 * Cache Redis: análise 15 min, ranking 30 min.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { statusInvestScraper } from '../../services/statusinvest-scraper.ts';
import { fiisScraper } from '../../services/fiis-scraper.ts';
import { fiiOperationalService } from '../../services/fii-operational.service.ts';
import { batchWithConcurrency } from '../../../shared/retry.ts';
import { isFii } from '../../../shared/ticker-utils.ts';
import { lazyDataService } from '../../services/lazy-data-service.ts';
import { calcAllIndicators } from '../../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../../core/services/stock-score.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from '../../../core/services/fii-score.ts';
import { AllocationEngine } from '../../../core/services/allocation-engine.ts';
import { flagAbsurdMetrics } from '../../../core/services/metric-sanity.ts';
import { marketDataService } from '../../services/market-data-service.ts';
import { redis } from '../../services/redis.ts';
import { SCORE_VALIDATION } from '../../../core/data/score-validation.data.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendZodError(
  reply: FastifyReply,
  error: z.ZodError,
  message: string,
): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({
      path: path.join('.'),
      message: m,
    })),
  });
}

const tickerParam = z.object({
  ticker: z
    .string()
    .min(4)
    .max(10)
    .transform((t) => t.toUpperCase()),
});

// ─── GET /v1/analysis/stocks/:ticker ─────────────────────────────────────────

export async function getStockAnalysisController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = tickerParam.safeParse(request.params);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  const cacheKey = `analysis:stock:${ticker}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch {
    // Redis offline — segue sem cache
  }

  // Busca fundamentals
  const rows = await db
    .select({
      ticker: companies.ticker,
      companyName: companies.name,
      sector: companies.sector,
      cnpj: companyFundamentals.companyCnpj,
      fiscalYear: companyFundamentals.fiscalYear,
      period: companyFundamentals.period,
      referenceDate: companyFundamentals.referenceDate,
      source: companyFundamentals.source,
      netIncome: companyFundamentals.netIncome,
      netIncomeParent: companyFundamentals.netIncomeParent,
      revenue: companyFundamentals.revenue,
      cogs: companyFundamentals.cogs,
      ebit: companyFundamentals.ebit,
      totalAssets: companyFundamentals.totalAssets,
      totalLiabilities: companyFundamentals.totalLiabilities,
      cash: companyFundamentals.cash,
      operatingCashFlow: companyFundamentals.operatingCashFlow,
      equity: companyFundamentals.equity,
      sharesOutstanding: companyFundamentals.sharesOutstanding,
    })
    .from(companyFundamentals)
    .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
    .where(eq(companies.ticker, ticker))
    .orderBy(desc(companyFundamentals.referenceDate))
    .limit(1);

  if (rows.length === 0) {
    reply.status(404).send({
      error: 'NotFound',
      message: `Fundamentos não encontrados para "${ticker}". Execute worker:sync primeiro.`,
    });
    return;
  }

  const f = rows[0]!;

  // Paraleliza: cotação + histórico DB (independentes)
  const [quoteResult, histRows] = await Promise.all([
    stockQuoteService.getQuote(ticker).catch(() => null),
    db
      .select({
        fiscalYear: companyFundamentals.fiscalYear,
        revenue: companyFundamentals.revenue,
        netIncomeParent: companyFundamentals.netIncomeParent,
        equity: companyFundamentals.equity,
        totalLiabilities: companyFundamentals.totalLiabilities,
        cogs: companyFundamentals.cogs,
      })
      .from(companyFundamentals)
      .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
      .where(eq(companies.ticker, ticker))
      .orderBy(desc(companyFundamentals.fiscalYear))
      .catch((): Array<{ fiscalYear: number; revenue: string | null; netIncomeParent: string | null; equity: string | null; totalLiabilities: string | null; cogs: string | null }> => []),
  ]);

  let price = 0;
  let quotesOk = false;
  if (quoteResult) { price = quoteResult.price; quotesOk = true; }

  // Paraleliza: dividendos + momentum (precisam de price, mas independentes entre si)
  const [dividendResult, momentum] = await Promise.all([
    (async (): Promise<{ ok: boolean; dy: number | null }> => {
      let ok = false; let dy: number | null = null;
      try {
        const scraped = await statusInvestScraper.fetchStock(ticker);
        if (scraped.dy12m > 0 && price > 0) { dy = scraped.dy12m; ok = true; }
      } catch {
        try {
          const proventos = await dividendsProvider.fetchDividends(ticker);
          if (proventos && proventos.length > 0 && price > 0) {
            const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
            const c = cutoff.toISOString().slice(0, 10);
            const s = proventos.filter((e) => e.date >= c).reduce((a, e) => a + e.value, 0);
            if (s > 0) { dy = +(s / price * 100).toFixed(2); ok = true; }
          }
        } catch { /* fallback offline */ }
      }
      return { ok, dy };
    })(),
    marketDataService.getMomentum(ticker).catch(() => undefined),
  ]);

  const dividendsOk = dividendResult.ok;
  const dividendYield = dividendResult.dy;

  // Indicadores + Score (síncrono, rápido)
  const indicators = calcAllIndicators(f, price);
  if (dividendYield !== null) indicators.dividendYield = dividendYield;

  let historical: import('../../../core/services/stock-score.ts').HistoricalData | undefined;
  if (histRows.length >= 2) {
    historical = {
      years: histRows.map((r) => {
        const rev = Number(r.revenue ?? 0);
        const inc = Number(r.netIncomeParent ?? 0);
        const eqVal = Number(r.equity ?? 0);
        const cogsVal = Math.abs(Number(r.cogs ?? 0));
        return {
          fiscalYear: r.fiscalYear,
          revenue: rev, netIncome: inc,
          roe: eqVal > 0 ? +(inc / eqVal * 100).toFixed(2) : 0,
          netMargin: rev > 0 ? +(inc / rev * 100).toFixed(2) : 0,
          debtToEquity: eqVal > 0 ? +(Number(r.totalLiabilities ?? 0) / eqVal).toFixed(2) : 0,
          grossMargin: rev > 0 ? +((rev - cogsVal) / rev * 100).toFixed(2) : 0,
        };
      }),
    };
  }

  const result = StockScoreCalculator.calculate(
    indicators, f.sector, f.companyName, historical, momentum,
  );

  const anomalies = flagAbsurdMetrics({
    price: price || null,
    peRatio: indicators.peRatio,
    dividendYield: indicators.dividendYield,
    pbRatio: indicators.pbRatio,
  });

  const response = {
    ticker: result.ticker,
    companyName: result.companyName,
    cnpj: f.cnpj,
    score: result.score,
    breakdown: result.breakdown,
    reasons: result.reasons,
    alerts: result.alerts,
    indicators,
    price: price || null,
    anomalies,
    dataQuality: {
      quotes: quotesOk,
      dividends: dividendsOk,
      fundamentals: true,
    },
  };

  // Cache 15 min
  try {
    await redis.setex(cacheKey, 900, JSON.stringify(response));
  } catch {
    /* Redis offline */
  }

  reply.send(response);
}

// ─── GET /v1/analysis/fiis/:ticker ───────────────────────────────────────────

export async function getFiiAnalysisController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = tickerParam.safeParse(request.params);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  const cacheKey = `analysis:fii:${ticker}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch {
    /* Redis offline */
  }

  // Busca empresa (FIIs usam a tabela companies também)
  const [company] = await db
    .select({
      cnpj: companies.cnpj,
      name: companies.name,
      sector: companies.sector,
    })
    .from(companies)
    .where(eq(companies.ticker, ticker));

  if (!company) {
    reply.status(404).send({
      error: 'NotFound',
      message: `FII "${ticker}" não encontrado.`,
    });
    return;
  }

  // Cotação
  let price = 0;
  let quotesOk = false;
  try {
    const quote = await stockQuoteService.getQuote(ticker);
    price = quote.price;
    quotesOk = true;
  } catch {
    /* sem cotação */
  }

  // Liquidez (volume do Yahoo)
  let liquidity: number | null = null;
  try {
    const quote = await stockQuoteService.getQuote(ticker);
    liquidity = quote.volume;
  } catch {
    /* sem liquidez */
  }

  // Proventos
  let dividendsOk = false;
  let dividendEvents: Array<{ date: string; value: number; type: string }> = [];
  let sum12m = 0;
  try {
    const proventos = await dividendsProvider.fetchDividends(ticker);
    if (proventos && proventos.length > 0) {
      dividendsOk = true;
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 12);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      dividendEvents = proventos.filter((e) => e.date >= cutoffStr);
      sum12m = dividendEvents.reduce((s, e) => s + e.value, 0);
    }
  } catch {
    /* provider indisponível */
  }

  // P/VP + DY: prioridade CVM (VP oficial) > Redis > StatusInvest
  let dyFromScraper: number | null = null;
  let pvp: number | null = null;
  let pvpOk = false;
  let pvpSource: 'cvm' | 'statusinvest' | null = null;
  let cvmNav: number | null = null;
  let cvmRef: string | null = null;

  try {
    const { cvmFiiService } = await import('../../services/cvm-fii-service.ts');
    const cvm = await cvmFiiService.getLatestByTicker(ticker);
    if (cvm?.navPerShare != null) {
      const nav = Number(cvm.navPerShare);
      if (nav > 0) {
        cvmNav = nav;
        cvmRef = String(cvm.referenceDate);
        if (price > 0) {
          pvp = +(price / nav).toFixed(3);
          pvpOk = true;
          pvpSource = 'cvm';
        }
      }
    }
  } catch { /* CVM cache vazio */ }

  try {
    const cachedFii = await redis.get(`fii:full:${ticker}`);
    if (cachedFii) {
      const fiiData = JSON.parse(cachedFii);
      if (fiiData.pvp > 0 && pvp === null) {
        pvp = fiiData.pvp;
        pvpOk = true;
        pvpSource = 'statusinvest';
      }
      if (fiiData.dy12m > 0) dyFromScraper = fiiData.dy12m;
    }
  } catch { /* Redis offline */ }

  // Fallback: scraper direto se ainda faltar P/VP ou DY
  if (dyFromScraper === null || pvp === null) {
    try {
      const fiiData = await fiisScraper.fetchFII(ticker);
      if (fiiData.pvp > 0 && pvp === null) {
        pvp = fiiData.pvp;
        pvpOk = true;
        pvpSource = 'statusinvest';
      }
      if (fiiData.dy12m > 0 && dyFromScraper === null) dyFromScraper = fiiData.dy12m;
      if (fiiData.dividendsHistory.length > 0) {
        await redis.setex(`dividends:${ticker}`, 86400, JSON.stringify(fiiData.dividendsHistory)).catch(()=>{});
      }
      await redis.setex(`fii:full:${ticker}`, 86400, JSON.stringify(fiiData)).catch(()=>{});
    } catch { /* scraper offline */ }
  }

  // DY: usa scraper se disponível, senão calcula dos proventos
  const dy = dyFromScraper ?? (sum12m > 0 && price > 0 ? +(sum12m / price * 100).toFixed(2) : 0);

  // Dados operacionais (vacância, inadimplência)
  let vacancy: number | undefined;
  let delinquency: number | undefined;
  let operationalOk = false;
  try {
    const opData = await fiiOperationalService.fetchOperationalData(ticker);
    if (opData.vacancyPct !== null) vacancy = opData.vacancyPct;
    if (opData.delinquencyPct !== null) delinquency = opData.delinquencyPct;
    operationalOk = opData.source.operational;
  } catch { /* ok */ }

  // Score FII
  const input: FIIScoreInput = {
    ticker,
    price,
    dy,
    pvp,
    liquidity,
    dividendsHistory: dividendEvents,
    vacancy,
    delinquency,
  };

  const score = FIIScoreCalculatorV4.calculate(input);

  const anomalies = flagAbsurdMetrics({
    price: price || null,
    dy,
    pvp,
  });

  const response = {
    ticker: score.ticker,
    name: company.name,
    type: score.type,
    typeSource: score.type_source,
    subclass: score.subclasse_tijolo || score.subclasse_papel || null,
    score: score.overall_score,
    breakdown: {
      incomeQuality: {
        score: score.income_quality.score,
        weight: 0.4,
        details: score.income_quality.rating,
      },
      assetQuality: {
        score: score.asset_quality.score,
        weight: 0.35,
        details: score.asset_quality.rating,
      },
      risk: {
        score: score.risk.score,
        weight: 0.25,
        details: score.risk.primary_risk,
      },
    },
    recommendation:
      score.overall_rating === 'excelente' || score.overall_rating === 'bom'
        ? 'conservador'
        : score.overall_rating === 'regular'
          ? 'moderado'
          : 'arriscado',
    explanation: score.explanation_short,
    dataQuality: {
      quotes: quotesOk,
      dividends: dividendsOk,
      pvp: pvpOk,
      pvpSource,
      cvmNav,
      cvmReferenceDate: cvmRef,
      operational: operationalOk,
      classification: score.type_source !== 'inferred',
      freeSourcesOnly: true,
    },
    price: price || null,
    dividendYield: dy || null,
    pvp,
    liquidity,
    anomalies,
  };

  // Cache 15 min
  try {
    await redis.setex(cacheKey, 900, JSON.stringify(response));
  } catch {
    /* Redis offline */
  }

  reply.send(response);
}

// ─── GET /v1/analysis/ranking ────────────────────────────────────────────────

const rankingSchema = z.object({
  type: z.enum(['stock', 'fii']).default('stock'),
  limit: z
    .string()
    .optional()
    .default('10')
    .transform(Number)
    .pipe(z.number().int().min(1).max(500)),
  minScore: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(0).max(100).optional()),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

// Sort ranking rows by a chosen numeric column (missing values always last),
// falling back to score. Ticker sorts alphabetically.
function sortRankingRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: string | undefined,
  order: 'asc' | 'desc',
): T[] {
  const key = sort || 'score';
  const dir = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'ticker') {
      return String(a.ticker ?? '').localeCompare(String(b.ticker ?? '')) * dir;
    }
    const av = a[key];
    const bv = b[key];
    const aMiss = typeof av !== 'number' || Number.isNaN(av);
    const bMiss = typeof bv !== 'number' || Number.isNaN(bv);
    if (aMiss && bMiss) return 0;
    if (aMiss) return 1;
    if (bMiss) return -1;
    return ((av as number) - (bv as number)) * dir;
  });
}

export async function getRankingController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = rankingSchema.safeParse(request.query);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Query inválida.');
  const { type, limit, minScore, sort, order } = parsed.data;

  const cacheKey = `analysis:ranking:${type}:${limit}:${minScore ?? 'none'}:${sort ?? 'score'}:${order}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch {
    /* Redis offline */
  }

  if (type === 'stock') {
    // Busca todas as empresas com fundamentals mais recentes
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (c.ticker)
        c.ticker,
        c.name,
        c.sector,
        cf.net_income_parent,
        cf.equity,
        cf.revenue,
        cf.reference_date
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE (c.ticker NOT LIKE '%11' OR c.ticker IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11'))  -- Exclui FIIs, mas mantém Units
        AND LENGTH(c.ticker) >= 5
      ORDER BY c.ticker, cf.source = 'DFP' DESC, cf.reference_date DESC
      LIMIT 200
    `);

    // Processa em batch (concorrência 5) em vez de sequencial
    const scored = await batchWithConcurrency(
      rows as unknown as Record<string, unknown>[],
      async (r) => {
        const ticker = String(r.ticker);
        let price = 0;
        let changePct: number | null = null;
        try {
          const q = await stockQuoteService.getQuote(ticker);
          price = q.price;
          changePct = typeof q.changePercent === 'number' ? q.changePercent : null;
        } catch { return null; }
        if (price <= 0) return null;

        const indicators = calcAllIndicators(r, price);

        try {
          const proventos = await dividendsProvider.fetchDividends(ticker);
          if (proventos && price > 0) {
            const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
            const sum12m = proventos.filter((e) => e.date >= cutoff.toISOString().slice(0, 10))
              .reduce((s, e) => s + e.value, 0);
            if (sum12m > 0) indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
          }
        } catch { /* ok */ }

        const result = StockScoreCalculator.calculate(indicators, (r.sector as string) || null, String(r.name));
        if (minScore !== undefined && result.score < minScore) return null;
        return {
          ticker,
          name: String(r.name),
          score: result.score,
          type: 'stock' as const,
          sector: (r.sector as string) || null,
          price,
          changePct,
          dy: indicators.dividendYield ?? null,
          pe: indicators.peRatio ?? null,
          pvp: indicators.pbRatio ?? null,
          roe: indicators.roe ?? null,
        };
      },
      8, // concorrência maior para ranking (usa cache interno do quote service)
    );

    const results: Array<Record<string, unknown>> = [];
    for (const r of scored) {
      if (r) results.push(r);
    }

    const sliced = sortRankingRows(results, sort, order).slice(0, limit);

    const response = {
      type: 'stock' as const,
      total: sliced.length,
      filters: { minScore: minScore ?? null, limit },
      data: sliced,
      // Trust badge: scoreVersion + verdict from SCORE_VALIDATION (backward-compatible add)
      meta: {
        scoreVersion: SCORE_VALIDATION.scoreVersion,
        verdict: SCORE_VALIDATION.verdict,
      },
    };

    try {
      await redis.setex(cacheKey, 1800, JSON.stringify(response));
    } catch {
      /* Redis offline */
    }

    reply.send(response);
  } else {
    // Ranking de FIIs — P/VP via CVM (DB) ou cache Redis; sem scrape síncrono em lote
    const allTickers = await db.execute(sql`
      SELECT ticker, name FROM companies
      WHERE ticker LIKE '%11'
        AND LENGTH(ticker) = 6
      ORDER BY ticker
      LIMIT 200
    `);

    const fiiTickers = (allTickers as unknown as Record<string, unknown>[])
      .filter((r) => isFii(String(r.ticker)));

    const { cvmFiiService } = await import('../../services/cvm-fii-service.ts');
    const cvmNavMap = await cvmFiiService.getLatestNavByTickerMap().catch(
      () => new Map<string, { navPerShare: number; referenceDate: string }>(),
    );

    // Batch concorrente (quotes + proventos; P/VP offline-first)
    const scoredFii = await batchWithConcurrency(
      fiiTickers as unknown as Record<string, unknown>[],
      async (r) => {
        const ticker = String(r.ticker);
        let price = 0; let liquidity: number | null = null;
        try { const q = await stockQuoteService.getQuote(ticker); price = q.price; liquidity = q.volume; } catch { return null; }
        if (price <= 0) return null;

        let dy = 0;
        let dividendEvents: Array<{ date: string; value: number; type: string }> = [];
        try {
          const proventos = await dividendsProvider.fetchDividends(ticker);
          if (proventos && price > 0) {
            const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
            const c = cutoff.toISOString().slice(0, 10);
            dividendEvents = proventos.filter((e) => e.date >= c);
            const s = dividendEvents.reduce((a, e) => a + e.value, 0);
            if (s > 0) dy = +(s / price * 100).toFixed(2);
          }
        } catch { /* ok */ }

        // P/VP: CVM (oficial) → Redis cache de scrape prévio → null (sem scrape no ranking)
        let pvp: number | null = null;
        const cvm = cvmNavMap.get(ticker);
        if (cvm && cvm.navPerShare > 0) {
          pvp = +(price / cvm.navPerShare).toFixed(3);
        } else {
          try {
            const cachedFii = await redis.get(`fii:full:${ticker}`);
            if (cachedFii) {
              const fiiData = JSON.parse(cachedFii) as { pvp?: number };
              if (typeof fiiData.pvp === 'number' && fiiData.pvp > 0) {
                pvp = fiiData.pvp;
              }
            }
          } catch { /* redis offline */ }
        }

        const score = FIIScoreCalculatorV4.calculate({
          ticker,
          price,
          dy,
          pvp,
          liquidity,
          dividendsHistory: dividendEvents,
        });
        if (minScore !== undefined && score.overall_score < minScore) return null;
        const subclass = score.subclasse_tijolo || score.subclasse_papel || score.type || null;
        return {
          ticker,
          name: String(r.name),
          score: score.overall_score,
          // Asset class drives routing to /research/fii/:ticker — must be 'fii', not the subclass.
          type: 'fii' as const,
          recommendation: score.overall_rating === 'excelente' || score.overall_rating === 'bom' ? 'conservador'
            : score.overall_rating === 'regular' ? 'moderado' : 'arriscado',
          subclass,
          // Surface the FII subclass in the "Setor" column (FIIs have no sector).
          sector: subclass,
          price,
          changePct: null,
          dy: dy || null,
          pvp,
          pe: null,
          roe: null,
        };
      },
      8,
    );

    const results: Array<Record<string, unknown>> = [];
    for (const r of scoredFii) { if (r) results.push(r); }

    const sliced = sortRankingRows(results, sort, order).slice(0, limit);

    const response = {
      type: 'fii' as const,
      total: sliced.length,
      filters: { minScore: minScore ?? null, limit },
      data: sliced,
      // Trust badge: scoreVersion + verdict from SCORE_VALIDATION (backward-compatible add)
      meta: {
        scoreVersion: SCORE_VALIDATION.scoreVersion,
        verdict: SCORE_VALIDATION.verdict,
      },
    };

    try {
      await redis.setex(cacheKey, 1800, JSON.stringify(response));
    } catch {
      /* Redis offline */
    }

    reply.send(response);
  }
}

// ─── POST /v1/analysis/allocate ──────────────────────────────────────────────

// ─── Compare ─────────────────────────────────────────────────────────────────

const compareSchema = z.object({
  tickers: z.array(z.string().min(4).max(10).transform((t) => t.toUpperCase())).min(2).max(10),
  type: z.enum(['stock', 'fii']).default('stock'),
});

interface CompareResultItem {
  ticker: string;
  name: string;
  price: number | null;
  score: number | null;
  peRatio?: number | null;
  pvp?: number | null;
  roe?: number | null;
  dy?: number | null;
  netMargin?: number | null;
  debtToEquity?: number | null;
  diagnosis?: string;
  recommendation?: string;
  highlights?: string[];
  warnings?: string[];
  error?: string;
}

/**
 * POST /v1/analysis/compare
 *
 * Comparação lado a lado de até 10 ações ou FIIs.
 * Retorna métricas alinhadas para facilitar análise comparativa.
 * Cache Redis 5 min.
 */
export async function compareController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = compareSchema.safeParse(request.body);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');

  const { tickers, type } = parsed.data;
  const cacheKey = `compare:${type}:${tickers.sort().join(',')}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) { reply.send(JSON.parse(cached)); return; }
  } catch { /* Redis offline */ }

  const results: CompareResultItem[] = await batchWithConcurrency(tickers, async (ticker) => {
    try {
      if (type === 'fii') {
        const cacheKeyFii = `analysis:fii:${ticker}`;
        let data: Record<string, unknown> | null = null;
        try {
          const cached = await redis.get(cacheKeyFii);
          if (cached) data = JSON.parse(cached);
        } catch { /* ok */ }

        if (!data) {
          // Busca via endpoint interno (simplificado)
          const [company] = await db
            .select({ name: companies.name, sector: companies.sector })
            .from(companies)
            .where(eq(companies.ticker, ticker));

          if (!company) return { ticker, name: ticker, price: null, score: null, error: 'FII não encontrado' };

          let price = 0;
          try { const q = await stockQuoteService.getQuote(ticker); price = q.price; } catch { /* ok */ }

          let dy = 0;
          let dividends: Array<{ date: string; value: number; type: string }> = [];
          try {
            const proventos = await dividendsProvider.fetchDividends(ticker);
            if (proventos && price > 0) {
              const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
              const c = cutoff.toISOString().slice(0, 10);
              dividends = proventos.filter((e) => e.date >= c);
              const sum12m = dividends.reduce((s, e) => s + e.value, 0);
              if (sum12m > 0) dy = +(sum12m / price * 100).toFixed(2);
            }
          } catch { /* ok */ }

          let pvp: number | null = null;
          try {
            const scraped = await fiisScraper.fetchFII(ticker);
            if (scraped.pvp > 0) pvp = scraped.pvp;
          } catch { /* ok */ }

          const score = FIIScoreCalculatorV4.calculate({ ticker, price, dy, pvp, liquidity: null, dividendsHistory: dividends });

          return {
            ticker,
            name: String(company.name),
            price: price || null,
            score: score.overall_score,
            pvp,
            dy: dy || null,
            diagnosis: score.overall_rating,
            recommendation: score.recommendation.action,
            highlights: [score.explanation_short],
          };
        }

        return {
          ticker: data.ticker as string,
          name: data.name as string,
          price: data.price as number | null,
          score: data.score as number | null,
          pvp: data.pvp as number | null,
          dy: data.dividendYield as number | null,
          diagnosis: (data as Record<string, unknown>).recommendation as string,
        };
      }

      // Stock
      const cacheKeyStock = `analysis:stock:${ticker}`;
      try {
        const cached = await redis.get(cacheKeyStock);
        if (cached) {
          const d = JSON.parse(cached) as Record<string, unknown>;
          const ind = d.indicators as Record<string, unknown> | undefined;
          return {
            ticker: d.ticker as string,
            name: d.companyName as string,
            price: d.price as number | null,
            score: d.score as number | null,
            peRatio: ind?.peRatio as number | null,
            pvp: ind?.pbRatio as number | null,
            roe: ind?.roe as number | null,
            dy: ind?.dividendYield as number | null,
            netMargin: ind?.netMargin as number | null,
            debtToEquity: ind?.debtToEquity as number | null,
            diagnosis: d.diagnosis as string,
            highlights: d.reasons as string[],
            warnings: d.alerts as string[],
          };
        }
      } catch { /* ok */ }

      // Fallback: busca simplificada
      const rows = await db
        .select({
          ticker: companies.ticker,
          name: companies.name,
          sector: companies.sector,
          cnpj: companyFundamentals.companyCnpj,
          referenceDate: companyFundamentals.referenceDate,
          netIncomeParent: companyFundamentals.netIncomeParent,
          equity: companyFundamentals.equity,
          revenue: companyFundamentals.revenue,
          totalLiabilities: companyFundamentals.totalLiabilities,
        })
        .from(companyFundamentals)
        .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
        .where(eq(companies.ticker, ticker))
        .orderBy(desc(companyFundamentals.referenceDate))
        .limit(1);

      if (rows.length === 0) return { ticker, name: ticker, price: null, score: null, error: 'Sem fundamentos' };

      const f = rows[0]!;
      let price = 0;
      try { const q = await stockQuoteService.getQuote(ticker); price = q.price; } catch { /* ok */ }

      const indicators = calcAllIndicators(f as unknown as Record<string, unknown>, price);
      const scoreResult = StockScoreCalculator.calculate(
        indicators, f.sector, String(f.name),
      );

      return {
        ticker,
        name: String(f.name),
        price: price || null,
        score: scoreResult.score,
        peRatio: indicators.peRatio,
        pvp: indicators.pbRatio,
        roe: indicators.roe,
        dy: indicators.dividendYield,
        netMargin: indicators.netMargin,
        debtToEquity: indicators.debtToEquity,
        diagnosis: scoreResult.diagnosis,
        highlights: scoreResult.reasons,
        warnings: scoreResult.alerts,
      };
    } catch (err) {
      return { ticker, name: ticker, price: null, score: null, error: String(err) };
    }
  }, 5);

  // Adiciona análise de dispersão
  const scores = results.filter((r) => r.score !== null).map((r) => r.score!);
  const avgScore = scores.length > 0 ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;
  const bestPick = results.filter((r) => r.score !== null).sort((a, b) => b.score! - a.score!)[0]?.ticker ?? null;

  const response = {
    type,
    count: results.length,
    bestPick,
    avgScore,
    data: results,
  };

  try { await redis.setex(cacheKey, 300, JSON.stringify(response)); } catch { /* ok */ }

  reply.send(response);
}

const allocateSchema = z.object({
  totalAmount: z.number().positive().default(10000),
  riskProfile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado'),
  stockPercent: z.number().min(0).max(100).optional(),
  fiiPercent: z.number().min(0).max(100).optional(),
  minScore: z.number().min(0).max(100).optional(),
  maxAssets: z.number().int().min(1).max(20).optional(),
});

export async function getAllocationController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = allocateSchema.safeParse(request.body);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Payload inválido.');

  try {
    const engine = new AllocationEngine();
    const result = await engine.buildAllocation(parsed.data);
    reply.send(result);
  } catch (err) {
    request.log.error({ err }, 'allocation failed');
    reply.status(503).send({
      error: 'ServiceUnavailable',
      message:
        'Falha ao montar alocação (fontes de preço/score indisponíveis). Tente de novo em instantes.',
    });
  }
}

// ─── GET /v1/analysis/validation ─────────────────────────────────────────────

export async function getValidationController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // 1) Série top-N vs universo vs IBOV persistida no último backtest (dados reais)
  let strategy: {
    runId: string;
    scoreVersion: string;
    n: number;
    summary: ReturnType<
      typeof import('../../database/backtest-queries.ts').summarizeStrategyYears
    >;
  } | null = null;

  try {
    const {
      getLatestStrategyYears,
      summarizeStrategyYears,
    } = await import('../../database/backtest-queries.ts');
    const latest = await getLatestStrategyYears(10);
    if (latest) {
      strategy = {
        runId: latest.runId,
        scoreVersion: latest.scoreVersion,
        n: 10,
        summary: summarizeStrategyYears(latest.years),
      };
    }
  } catch (err) {
    console.warn(
      '[validation] strategy years DB:',
      err instanceof Error ? err.message : err,
    );
  }

  // 2) IBOV live (Yahoo) — preenche anos mesmo sem backtest re-rodado
  let ibov: Awaited<
    ReturnType<typeof import('../../services/ibov-benchmark.ts').fetchIbovCalendarReturns>
  > & {
    vsTopN?: {
      n: number;
      avgPortfolio: number;
      avgIbov: number | null;
      ibovYears: number;
      deltaAvgPp: number | null;
      source: 'persisted_backtest' | 'verdict_static';
    };
  } | null = null;

  try {
    const { fetchIbovCalendarReturns } = await import(
      '../../services/ibov-benchmark.ts'
    );
    const years =
      strategy?.summary.byYear.map((y) => y.year) ?? SCORE_VALIDATION.yearsTested;
    const bench = await fetchIbovCalendarReturns(years);

    const avgPortfolio =
      strategy?.summary.avgPortfolio ?? SCORE_VALIDATION.topN?.avgPortfolio ?? null;
    const avgIbov =
      strategy?.summary.avgIbov ??
      (() => {
        const vals = years
          .map((y) => bench.byYear[y])
          .filter((v): v is number => typeof v === 'number');
        return vals.length
          ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2)
          : null;
      })();

    ibov = {
      ...bench,
      // Prefer byYear from persisted strategy (portfolio vs ibov same years)
      byYear: strategy
        ? Object.fromEntries(
            strategy.summary.byYear.map((y) => [
              y.year,
              y.ibovReturn ?? bench.byYear[y.year] ?? null,
            ]),
          )
        : bench.byYear,
      vsTopN: {
        n: strategy?.n ?? SCORE_VALIDATION.topN?.n ?? 10,
        avgPortfolio: avgPortfolio ?? 0,
        avgIbov,
        ibovYears:
          strategy?.summary.ibovYears ??
          years.filter((y) => bench.byYear[y] != null).length,
        deltaAvgPp:
          avgPortfolio != null && avgIbov != null
            ? +(avgPortfolio - avgIbov).toFixed(2)
            : null,
        source: strategy ? 'persisted_backtest' : 'verdict_static',
      },
    };
  } catch (err) {
    console.warn(
      '[validation] IBOV Yahoo indisponível:',
      err instanceof Error ? err.message : err,
    );
  }

  // 3) Backtest FII total return (se já rodou worker)
  let fiiBacktest: Awaited<
    ReturnType<
      typeof import('../../database/fii-backtest-queries.ts').getLatestFiiBacktestSummary
    >
  > = null;
  try {
    const { getLatestFiiBacktestSummary } = await import(
      '../../database/fii-backtest-queries.ts'
    );
    fiiBacktest = await getLatestFiiBacktestSummary();
  } catch (err) {
    console.warn(
      '[validation] fii backtest:',
      err instanceof Error ? err.message : err,
    );
  }

  reply.send({
    ...SCORE_VALIDATION,
    strategy,
    ibov,
    fiiBacktest,
    generatedAt: new Date().toISOString(),
  });
}

// ─── GET /v1/search ─────────────────────────────────────────────────────────

const searchSchema = z.object({
  q: z.string().min(1).max(50),
});

export async function searchController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = searchSchema.safeParse(request.query);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Query inválida.');

  const { q } = parsed.data;

  const result = await lazyDataService.searchAssets(q);

  // Se não encontrou nada mas parece ticker, dispara scraping em background
  if (result.results.length === 0 && /^[A-Z]{4}\d{1,2}$/.test(q.toUpperCase().trim())) {
    // Responde imediatamente com status "fetching"
    // O frontend pode refetch após alguns segundos
    reply.header('X-Search-Status', 'scraping');
    reply.send({
      query: q,
      results: [],
      source: 'live_scrape',
      message: 'Dados sendo buscados em tempo real. Tente novamente em instantes.',
    });

    // Dispara scraping em background (não bloqueia a resposta)
    lazyDataService.ensureData(q).catch((err) =>
      console.warn(`[search] Background scrape failed for ${q}:`, (err as Error).message),
    );
    return;
  }

  reply.send(result);
}
