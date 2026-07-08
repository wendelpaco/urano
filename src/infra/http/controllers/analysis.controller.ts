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
import { calcAllIndicators } from '../../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../../core/services/stock-score.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from '../../../core/services/fii-score.ts';
import { AllocationEngine } from '../../../core/services/allocation-engine.ts';
import { marketDataService } from '../../services/market-data-service.ts';
import { redis } from '../../services/redis.ts';

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

  // DY: busca via scraper (HTML, confiável) com fallback para provider (JSON)
  let dividendsOk = false;
  let dividendYield: number | null = null;
  try {
    const scraped = await statusInvestScraper.fetchStock(ticker);
    if (scraped.dy12m > 0 && price > 0) {
      dividendYield = scraped.dy12m;
      dividendsOk = true;
    }
  } catch {
    // Fallback: provider JSON
    try {
      const proventos = await dividendsProvider.fetchDividends(ticker);
      if (proventos && proventos.length > 0 && price > 0) {
        const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        const sum12m = proventos.filter((e) => e.date >= cutoffStr).reduce((s, e) => s + e.value, 0);
        if (sum12m > 0) {
          dividendYield = +(sum12m / price * 100).toFixed(2);
          dividendsOk = true;
        }
      }
    } catch { /* sem dados */ }
  }

  // Indicadores
  const indicators = calcAllIndicators(f, price);

  // Busca dados históricos (todos os anos) para análise de tendências
  let historical: import('../../../core/services/stock-score.ts').HistoricalData | undefined;
  try {
    const histRows = await db
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
      .orderBy(desc(companyFundamentals.fiscalYear));

    if (histRows.length >= 2) {
      historical = {
        years: histRows.map((r) => {
          const rev = Number(r.revenue ?? 0);
          const inc = Number(r.netIncomeParent ?? 0);
          const eq = Number(r.equity ?? 0);
          const cogs = Math.abs(Number(r.cogs ?? 0));
          return {
            fiscalYear: r.fiscalYear,
            revenue: rev,
            netIncome: inc,
            roe: eq > 0 ? +(inc / eq * 100).toFixed(2) : 0,
            netMargin: rev > 0 ? +(inc / rev * 100).toFixed(2) : 0,
            debtToEquity: eq > 0 ? +(Number(r.totalLiabilities ?? 0) / eq).toFixed(2) : 0,
            grossMargin: rev > 0 ? +((rev - cogs) / rev * 100).toFixed(2) : 0,
          };
        }),
      };
    }
  } catch { /* sem dados históricos */ }

  // Score com dados históricos
  // DY já foi definido pelo scraper acima
  if (dividendYield !== null) {
    indicators.dividendYield = dividendYield;
  }

  // Momentum de mercado
  let momentum;
  try {
    momentum = await marketDataService.getMomentum(ticker);
  } catch { /* sem momento */ }

  // Score com dados históricos + momentum
  const result = StockScoreCalculator.calculate(
    indicators,
    f.sector,
    f.companyName,
    historical,
    momentum,
  );

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

  // P/VP + DY do cache Redis com fallback para scraper direto
  let dyFromScraper: number | null = null;
  let pvp: number | null = null;
  let pvpOk = false;
  try {
    const cachedFii = await redis.get(`fii:full:${ticker}`);
    if (cachedFii) {
      const fiiData = JSON.parse(cachedFii);
      if (fiiData.pvp > 0) { pvp = fiiData.pvp; pvpOk = true; }
      if (fiiData.dy12m > 0) dyFromScraper = fiiData.dy12m;
    }
  } catch { /* Redis offline */ }

  // Fallback: chama scraper direto se Redis vazio
  if (dyFromScraper === null || pvp === null) {
    try {
      const fiiData = await fiisScraper.fetchFII(ticker);
      if (fiiData.pvp > 0 && pvp === null) { pvp = fiiData.pvp; pvpOk = true; }
      if (fiiData.dy12m > 0 && dyFromScraper === null) dyFromScraper = fiiData.dy12m;
      // Cacheia para próximas requisições
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
      operational: operationalOk,
      classification: score.type_source !== 'inferred',
    },
    price: price || null,
    dividendYield: dy || null,
    pvp,
    liquidity,
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
    .pipe(z.number().int().min(1).max(50)),
  minScore: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(0).max(100).optional()),
});

export async function getRankingController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = rankingSchema.safeParse(request.query);
  if (!parsed.success)
    return sendZodError(reply, parsed.error, 'Query inválida.');
  const { type, limit, minScore } = parsed.data;

  const cacheKey = `analysis:ranking:${type}:${limit}:${minScore ?? 'none'}`;

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
      WHERE c.ticker NOT LIKE '%11'  -- Exclui FIIs (4 letras + 11)
        AND LENGTH(c.ticker) >= 5
      ORDER BY c.ticker, cf.reference_date DESC
      LIMIT 200
    `);

    const results: Array<{
      ticker: string;
      name: string;
      score: number;
    }> = [];

    for (const r of rows as unknown as Record<string, unknown>[]) {
      const ticker = String(r.ticker);
      let price = 0;
      try {
        const quote = await stockQuoteService.getQuote(ticker);
        price = quote.price;
      } catch {
        continue; // Sem cotação → pula
      }

      const indicators = calcAllIndicators(r, price);

      // Tenta buscar DY
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 12);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          const sum12m = proventos
            .filter((e) => e.date >= cutoffStr)
            .reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) {
            indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
          }
        }
      } catch {
        /* sem proventos */
      }

      const result = StockScoreCalculator.calculate(
        indicators,
        (r.sector as string) || null,
        String(r.name),
      );

      if (minScore !== undefined && result.score < minScore) continue;
      results.push({ ticker, name: String(r.name), score: result.score });
    }

    results.sort((a, b) => b.score - a.score);
    const sliced = results.slice(0, limit);

    const response = {
      type: 'stock' as const,
      total: sliced.length,
      filters: { minScore: minScore ?? null, limit },
      data: sliced,
    };

    try {
      await redis.setex(cacheKey, 1800, JSON.stringify(response));
    } catch {
      /* Redis offline */
    }

    reply.send(response);
  } else {
    // Ranking de FIIs
    const fiiTickers = await db.execute(sql`
      SELECT ticker, name FROM companies
      WHERE ticker LIKE '%11'
        AND LENGTH(ticker) = 6
      ORDER BY ticker
      LIMIT 200
    `);

    const results: Array<{
      ticker: string;
      name: string;
      score: number;
      recommendation?: string;
      type?: string;
    }> = [];

    for (const r of fiiTickers as unknown as Record<string, unknown>[]) {
      const ticker = String(r.ticker);
      let price = 0;
      let liquidity: number | null = null;
      try {
        const quote = await stockQuoteService.getQuote(ticker);
        price = quote.price;
        liquidity = quote.volume;
      } catch {
        continue;
      }

      let dy = 0;
      let dividendEvents: Array<{ date: string; value: number; type: string }> =
        [];
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 12);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          dividendEvents = proventos.filter((e) => e.date >= cutoffStr);
          const sum12m = dividendEvents.reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) {
            dy = +(sum12m / price * 100).toFixed(2);
          }
        }
      } catch {
        /* sem proventos */
      }

      const score = FIIScoreCalculatorV4.calculate({
        ticker,
        price,
        dy,
        pvp: null,
        liquidity,
        dividendsHistory: dividendEvents,
      });

      if (minScore !== undefined && score.overall_score < minScore) continue;

      results.push({
        ticker,
        name: String(r.name),
        score: score.overall_score,
        recommendation:
          score.overall_rating === 'excelente' || score.overall_rating === 'bom'
            ? 'conservador'
            : score.overall_rating === 'regular'
              ? 'moderado'
              : 'arriscado',
        type: score.subclasse_tijolo || score.subclasse_papel || score.type,
      });
    }

    results.sort((a, b) => b.score - a.score);
    const sliced = results.slice(0, limit);

    const response = {
      type: 'fii' as const,
      total: sliced.length,
      filters: { minScore: minScore ?? null, limit },
      data: sliced,
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

  const engine = new AllocationEngine();
  const result = await engine.buildAllocation(parsed.data);

  reply.send(result);
}
