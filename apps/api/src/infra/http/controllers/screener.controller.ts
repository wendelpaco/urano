/**
 * Advanced Screener Controller — Filtro de ações por múltiplos indicadores.
 *
 * Suporta filtros de range (min/max) em 8 dimensões:
 *   Score, P/L, P/VP, EV/EBIT, ROE, ROA, Margem Líquida, Margem Bruta,
 *   LPA, DY, Dívida/Equity, Setor, Ano.
 *
 * Performance: cache Redis 5 min + batch com concorrência controlada (5 workers).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { calcAllIndicators } from '../../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../../core/services/stock-score.ts';
import { batchWithConcurrency } from '../../../shared/retry.ts';
import { redis } from '../../services/redis.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const numberParam = () =>
  z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().optional());

const screenerSchema = z.object({
  // Score
  minScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),
  maxScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),

  // Valuation
  minPE: numberParam(),
  maxPE: numberParam(),
  minPVP: numberParam(),
  maxPVP: numberParam(),
  minEVEBIT: numberParam(),
  maxEVEBIT: numberParam(),

  // Rentabilidade
  minROE: numberParam(),
  maxROE: numberParam(),
  minROA: numberParam(),
  maxROA: numberParam(),

  // Margens
  minNetMargin: numberParam(),
  maxNetMargin: numberParam(),
  minGrossMargin: numberParam(),
  maxGrossMargin: numberParam(),

  // Per-share
  minLPA: numberParam(),
  maxLPA: numberParam(),

  // Dividendos
  minDY: numberParam(),

  // Endividamento
  maxDE: numberParam(),

  // Setor / Ano
  sector: z.string().optional(),
  year: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().optional()),

  // Paginação / Ordenação
  limit: z.string().optional().default('20').transform(Number).pipe(z.number().int().min(1).max(100)),
  sortBy: z.enum(['score', 'peRatio', 'pvp', 'roe', 'roa', 'dy', 'netMargin', 'ticker']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export async function screenerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = screenerSchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');
  const filters = parsed.data;

  // Cache key
  const activeFilters = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined),
  );
  const cacheKey = `screener:${JSON.stringify(activeFilters)}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) { reply.send(JSON.parse(cached)); return; }
  } catch { /* Redis offline */ }

  // Busca fundamentals base
  let query = sql`
    SELECT DISTINCT ON (c.ticker)
      c.ticker, c.name, c.sector, c.cnpj,
      cf.fiscal_year,
      cf.reference_date AS "referenceDate",
      cf.net_income_parent AS "netIncomeParent",
      cf.net_income AS "netIncome",
      cf.revenue AS "revenue",
      cf.cogs AS "cogs",
      cf.ebit AS "ebit",
      cf.total_assets AS "totalAssets",
      cf.total_liabilities AS "totalLiabilities",
      cf.cash AS "cash",
      cf.operating_cash_flow AS "operatingCashFlow",
      cf.equity AS "equity",
      cf.shares_outstanding AS "sharesOutstanding",
      cf.source
    FROM companies c
    INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
    WHERE (c.ticker NOT LIKE '%11' OR c.ticker IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11')) AND LENGTH(c.ticker) >= 5
  `;

  if (filters.sector) query = sql`${query} AND c.sector ILIKE ${`%${filters.sector}%`}`;
  if (filters.year) query = sql`${query} AND cf.fiscal_year = ${filters.year}`;

  query = sql`${query} ORDER BY c.ticker, cf.source = 'DFP' DESC, cf.reference_date DESC LIMIT 100`;

  const rows = await db.execute(query);
  const rawData = rows as unknown as Record<string, unknown>[];

  // Enriquece com scores usando batch (concorrência controlada)
  const results: Array<Record<string, unknown>> = [];

  const enriched = await batchWithConcurrency(rawData, async (r) => {
    const ticker = String(r.ticker);

    let price = 0;
    let changePct: number | null = null;
    try {
      const q = await stockQuoteService.getQuote(ticker);
      price = q.price;
      changePct = typeof q.changePercent === 'number' ? q.changePercent : null;
    } catch {
      return null;
    }
    if (price <= 0) return null;

    const indicators = calcAllIndicators(r, price);

    // DY 12m via proventos (StatusInvest) — mesmo path do ranking
    try {
      const proventos = await dividendsProvider.fetchDividends(ticker);
      if (proventos && price > 0) {
        const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
        const sum12m = proventos.filter((e) => e.date >= cutoff.toISOString().slice(0, 10))
          .reduce((s, e) => s + e.value, 0);
        if (sum12m > 0) indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
      }
    } catch { /* ok */ }

    const scoreResult = StockScoreCalculator.calculate(
      indicators, (r.sector as string) || null, String(r.name),
    );

    // Aliases UI (dy/pe/changePct) + nomes longos (dividendYield/peRatio)
    return {
      ticker,
      name: r.name,
      type: 'stock' as const,
      sector: r.sector ?? null,
      price: Math.round(price * 100) / 100,
      changePct,
      changePercent: changePct,
      score: scoreResult.score,
      pe: indicators.peRatio,
      peRatio: indicators.peRatio,
      pvp: indicators.pbRatio,
      dy: indicators.dividendYield,
      dividendYield: indicators.dividendYield,
      evEbit: indicators.evEbit,
      roe: indicators.roe,
      roa: indicators.roa,
      netMargin: indicators.netMargin,
      grossMargin: indicators.grossMargin,
      lpa: indicators.eps,
      debtToEquity: indicators.debtToEquity,
      diagnosis: scoreResult.diagnosis,
    };
  }, 5);

  // Filtra resultados
  for (const r of enriched) {
    if (!r) continue;

    const num = (v: unknown): number | null => (v === null || v === undefined ? null : v as number);
    const pass = (min: number | undefined, max: number | undefined, val: number | null): boolean => {
      if (val === null) return false;
      if (min !== undefined && val < min) return false;
      if (max !== undefined && val > max) return false;
      return true;
    };

    if (!pass(filters.minScore, filters.maxScore, r.score as number)) continue;
    if (!pass(filters.minPE, filters.maxPE, num(r.peRatio))) continue;
    if (!pass(filters.minPVP, filters.maxPVP, num(r.pvp))) continue;
    if (!pass(filters.minEVEBIT, filters.maxEVEBIT, num(r.evEbit))) continue;
    if (!pass(filters.minROE, filters.maxROE, num(r.roe))) continue;
    if (!pass(filters.minROA, filters.maxROA, num(r.roa))) continue;
    if (!pass(filters.minNetMargin, filters.maxNetMargin, num(r.netMargin))) continue;
    if (!pass(filters.minGrossMargin, filters.maxGrossMargin, num(r.grossMargin))) continue;
    if (!pass(filters.minLPA, filters.maxLPA, num(r.lpa))) continue;
    if (filters.minDY !== undefined && (num(r.dividendYield) === null || (r.dividendYield as number) < filters.minDY)) continue;
    if (filters.maxDE !== undefined && (num(r.debtToEquity) !== null && (r.debtToEquity as number) > filters.maxDE)) continue;

    results.push(r);
  }

  // Ordena
  const sortMap: Record<string, string> = {
    score: 'score', peRatio: 'peRatio', pvp: 'pvp', roe: 'roe', roa: 'roa',
    dy: 'dividendYield', netMargin: 'netMargin', ticker: 'ticker',
  };
  const sortKey = sortMap[filters.sortBy] || 'score';
  results.sort((a, b) => {
    const va = (a[sortKey] as number) ?? 0;
    const vb = (b[sortKey] as number) ?? 0;
    return filters.order === 'desc' ? vb - va : va - vb;
  });

  const sliced = results.slice(0, filters.limit);

  const response = {
    filters: {
      sector: filters.sector ?? null,
      minScore: filters.minScore ?? null, maxScore: filters.maxScore ?? null,
      minPE: filters.minPE ?? null, maxPE: filters.maxPE ?? null,
      minPVP: filters.minPVP ?? null, maxPVP: filters.maxPVP ?? null,
      minEVEBIT: filters.minEVEBIT ?? null, maxEVEBIT: filters.maxEVEBIT ?? null,
      minROE: filters.minROE ?? null, maxROE: filters.maxROE ?? null,
      minROA: filters.minROA ?? null, maxROA: filters.maxROA ?? null,
      minNetMargin: filters.minNetMargin ?? null, maxNetMargin: filters.maxNetMargin ?? null,
      minGrossMargin: filters.minGrossMargin ?? null, maxGrossMargin: filters.maxGrossMargin ?? null,
      minLPA: filters.minLPA ?? null, maxLPA: filters.maxLPA ?? null,
      minDY: filters.minDY ?? null, maxDE: filters.maxDE ?? null,
      year: filters.year ?? null,
    },
    total: sliced.length,
    data: sliced,
  };

  try { await redis.setex(cacheKey, 300, JSON.stringify(response)); } catch { /* ok */ }

  reply.send(response);
}
