import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { calcAllIndicators } from '../../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../../core/services/stock-score.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const screenerSchema = z.object({
  sector: z.string().optional(),
  minNetIncome: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  maxNetIncome: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  year: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
  limit: z.string().optional().default('50').transform(Number).pipe(z.number().int().min(1).max(200)),
  sortBy: z.enum(['netIncome', 'ticker']).default('netIncome'),
  order: z.enum(['asc', 'desc']).default('desc'),
  minScore: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(0).max(100).optional()),
});

export async function screenerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = screenerSchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');
  const filters = parsed.data;

  const rows = await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (c.cnpj)
        c.ticker,
        c.name,
        c.sector,
        c.cnpj,
        cf.fiscal_year,
        cf.reference_date,
        cf.net_income,
        cf.net_income_parent,
        cf.equity,
        cf.source
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE 1=1
        ${filters.sector ? sql`AND c.sector ILIKE ${`%${filters.sector}%`}` : sql``}
        ${filters.minNetIncome !== undefined ? sql`AND cf.net_income >= ${filters.minNetIncome}` : sql``}
        ${filters.maxNetIncome !== undefined ? sql`AND cf.net_income <= ${filters.maxNetIncome}` : sql``}
        ${filters.year !== undefined ? sql`AND cf.fiscal_year = ${filters.year}` : sql``}
      ORDER BY c.cnpj, cf.reference_date DESC
    ) sub
    ORDER BY
      ${filters.sortBy === 'netIncome'
        ? sql`sub.net_income ${filters.order === 'desc' ? sql`DESC` : sql`ASC`}`
        : sql`sub.ticker ${filters.order === 'desc' ? sql`DESC` : sql`ASC`}`
      }
    LIMIT ${filters.limit}
  `);

  const rawData = (rows as unknown as Record<string, unknown>[]).map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector ?? null,
    cnpj: r.cnpj,
    fiscalYear: Number(r.fiscal_year),
    referenceDate: String(r.reference_date ?? '').slice(0, 10),
    netIncome: Number(r.net_income ?? 0),
    netIncomeParent: Number(r.net_income_parent ?? 0),
    equity: r.equity ? Number(r.equity) : null,
    source: r.source,
  }));

  // Se minScore informado, calcula score para filtrar
  let data: Array<Record<string, unknown> & { score?: number }> = rawData;

  if (filters.minScore !== undefined) {
    const scored: typeof data = [];
    for (const item of rawData) {
      const ticker = item.ticker as string;
      let price = 0;
      try {
        const quote = await stockQuoteService.getQuote(ticker);
        price = quote.price;
      } catch { continue; }

      const indicators = calcAllIndicators(item, price);

      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 12);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          const sum12m = proventos.filter((e) => e.date >= cutoffStr).reduce((s, e) => s + e.value, 0);
          if (sum12m > 0) {
            indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
          }
        }
      } catch { /* sem proventos */ }

      const result = StockScoreCalculator.calculate(indicators, item.sector as string | null, item.name as string);
      if (result.score >= filters.minScore!) {
        scored.push({ ...item, score: result.score });
      }
    }
    data = scored;
  }

  reply.send({
    filters: { sector: filters.sector ?? null, minNetIncome: filters.minNetIncome ?? null, maxNetIncome: filters.maxNetIncome ?? null, year: filters.year ?? null, minScore: filters.minScore ?? null },
    total: data.length,
    data,
  });
}
