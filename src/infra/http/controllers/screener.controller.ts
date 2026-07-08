/**
 * Advanced Screener Controller — Filtro de ações por múltiplos indicadores.
 *
 * Suporta filtros combinados:
 *   - minScore, maxScore (score do modelo)
 *   - minPE, maxPE (P/L)
 *   - minROE, maxROE
 *   - minDY (dividend yield mínimo)
 *   - maxDE (dívida/equity máximo)
 *   - sector (setor)
 *   - year (ano fiscal)
 *   - sortBy (score, peRatio, roe, dy, ticker)
 *   - limit, order
 *
 * Performance: cache Redis 5 min + batch com concorrência controlada.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, eq, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
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

const screenerSchema = z.object({
  // Score
  minScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),
  maxScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),

  // Valuation
  minPE: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  maxPE: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),

  // Rentabilidade
  minROE: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().optional()),
  maxROE: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().optional()),

  // Dividendos
  minDY: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),

  // Endividamento
  maxDE: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),

  // Setor / Ano
  sector: z.string().optional(),
  year: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().optional()),

  // Paginação / Ordenação
  limit: z.string().optional().default('20').transform(Number).pipe(z.number().int().min(1).max(100)),
  sortBy: z.enum(['score', 'peRatio', 'roe', 'dy', 'ticker']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export async function screenerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = screenerSchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');
  const filters = parsed.data;

  // Cache key (exclui filtros vazios)
  const activeFilters = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined),
  );
  const cacheKey = `screener:${JSON.stringify(activeFilters)}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
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
    WHERE c.ticker NOT LIKE '%11' AND LENGTH(c.ticker) >= 5
  `;

  if (filters.sector) {
    query = sql`${query} AND c.sector ILIKE ${`%${filters.sector}%`}`;
  }
  if (filters.year) {
    query = sql`${query} AND cf.fiscal_year = ${filters.year}`;
  }

  query = sql`${query} ORDER BY c.ticker, cf.reference_date DESC LIMIT 100`;

  const rows = await db.execute(query);
  const rawData = rows as unknown as Record<string, unknown>[];

  // Enriquece com scores usando batch (concorrência controlada)
  const results: Array<Record<string, unknown>> = [];

  const enriched = await batchWithConcurrency(
    rawData,
    async (r) => {
      const ticker = String(r.ticker);

      let price = 0;
      try { const q = await stockQuoteService.getQuote(ticker); price = q.price; } catch { return null; }
      if (price <= 0) return null;

      const indicators = calcAllIndicators(r, price);

      // DY
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
          const sum12m = proventos.filter((e) => e.date >= cutoff.toISOString().slice(0, 10))
            .reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
        }
      } catch { /* ok */ }

      const scoreResult = StockScoreCalculator.calculate(indicators, (r.sector as string) || null, String(r.name));

      return {
        ticker,
        name: r.name,
        sector: r.sector ?? null,
        price: Math.round(price * 100) / 100,
        score: scoreResult.score,
        peRatio: indicators.peRatio,
        roe: indicators.roe,
        dividendYield: indicators.dividendYield,
        debtToEquity: indicators.debtToEquity,
        netMargin: indicators.netMargin,
        diagnosis: scoreResult.diagnosis,
      };
    },
    5,
  );

  // Filtra resultados
  for (const r of enriched) {
    if (!r) continue;

    if (filters.minScore !== undefined && (r.score as number) < filters.minScore) continue;
    if (filters.maxScore !== undefined && (r.score as number) > filters.maxScore) continue;
    if (filters.minPE !== undefined && (r.peRatio === null || (r.peRatio as number) < filters.minPE)) continue;
    if (filters.maxPE !== undefined && (r.peRatio === null || (r.peRatio as number) > filters.maxPE)) continue;
    if (filters.minROE !== undefined && (r.roe === null || (r.roe as number) < filters.minROE)) continue;
    if (filters.maxROE !== undefined && (r.roe === null || (r.roe as number) > filters.maxROE)) continue;
    if (filters.minDY !== undefined && (r.dividendYield === null || (r.dividendYield as number) < filters.minDY)) continue;
    if (filters.maxDE !== undefined && (r.debtToEquity === null || (r.debtToEquity as number) > filters.maxDE)) continue;

    results.push(r);
  }

  // Ordena
  const sortMap: Record<string, string> = {
    score: 'score', peRatio: 'peRatio', roe: 'roe', dy: 'dividendYield', ticker: 'ticker',
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
      minROE: filters.minROE ?? null, maxROE: filters.maxROE ?? null,
      minDY: filters.minDY ?? null, maxDE: filters.maxDE ?? null,
      year: filters.year ?? null,
    },
    total: sliced.length,
    data: sliced,
  };

  // Cache 5 min
  try { await redis.setex(cacheKey, 300, JSON.stringify(response)); } catch { /* ok */ }

  reply.send(response);
}
