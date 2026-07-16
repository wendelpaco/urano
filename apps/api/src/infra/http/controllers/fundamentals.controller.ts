import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tickerParamSchema } from '../../../shared/ticker-utils.ts';
import { eq, desc } from 'drizzle-orm';
import { fundamentalsQueries } from '../../database/fundamentals-queries.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
import { calcAllIndicators } from '../../../core/services/indicators.ts';
import {
  incomeDistributionsSince,
  sumIncomeDistributions,
} from '../../../core/services/dividend-income.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const paramsSchema = z.object({
  ticker: tickerParamSchema,
});

const historyQuerySchema = z.object({
  limit: z.string().optional().default('10').transform(Number).pipe(z.number().int().min(1).max(50)),
});

/** GET /v1/fundamentals/:ticker */
export async function getLatestFundamentalsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  const rows = await db
    .select({
      ticker: companies.ticker,
      companyName: companies.name,
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
      extractedAt: companyFundamentals.extractedAt,
    })
    .from(companyFundamentals)
    .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
    .where(eq(companies.ticker, ticker.toUpperCase()))
    .orderBy(desc(companyFundamentals.referenceDate))
    .limit(1);

  if (rows.length === 0) {
    reply.status(404).send({ error: 'NotFound', message: `Fundamentos não encontrados para "${ticker}".` });
    return;
  }

  const f = rows[0]!;

  let price = 0;
  try { const quote = await stockQuoteService.getQuote(ticker); price = quote.price; } catch { /* sem cotação */ }

  const indicators = calcAllIndicators(f, price);

  // Onda 1d: corrige dividendYield com proventos 12m reais
  let dividendYieldSource = false;
  try {
    const proventos = await dividendsProvider.fetchDividends(ticker);
    if (proventos && proventos.length > 0 && price > 0) {
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);
      const sum12m = sumIncomeDistributions(
        incomeDistributionsSince(proventos, cutoff),
      );
      if (sum12m > 0) {
        indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
        dividendYieldSource = true;
      }
    }
  } catch {
    // Provider indisponível → DY fica null (degradado)
  }

  reply.send({
    ticker: f.ticker,
    companyName: f.companyName,
    cnpj: f.cnpj,
    period: { fiscalYear: f.fiscalYear, referenceDate: String(f.referenceDate).slice(0, 10), source: f.source },
    price: price || null,
    indicators,
    dataQuality: {
      quotes: price > 0,
      dividends: dividendYieldSource,
      fundamentals: true,
    },
    financials: {
      revenue: Number(f.revenue ?? 0),
      cogs: Math.abs(Number(f.cogs ?? 0)),
      grossProfit: Number(f.revenue ?? 0) - Math.abs(Number(f.cogs ?? 0)),
      ebit: Number(f.ebit ?? 0),
      netIncome: Number(f.netIncome ?? 0),
      netIncomeParent: Number(f.netIncomeParent ?? 0),
      totalAssets: Number(f.totalAssets ?? 0),
      totalLiabilities: Number(f.totalLiabilities ?? 0),
      cash: Number(f.cash ?? 0),
      netDebt: Number(f.totalLiabilities ?? 0) - Number(f.cash ?? 0),
      equity: Number(f.equity ?? 0),
      operatingCashFlow: Number(f.operatingCashFlow ?? 0),
      sharesOutstanding: Number(f.sharesOutstanding ?? 0),
    },
    extractedAt: f.extractedAt instanceof Date ? f.extractedAt.toISOString() : null,
  });
}

export async function getFundamentalsHistoryController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Ticker inválido.');
  const { ticker } = paramsParsed.data;

  const queryParsed = historyQuerySchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida.');
  const { limit } = queryParsed.data;
  const history = await fundamentalsQueries.getHistoryByTicker(ticker, limit);

  if (history.length === 0) {
    reply.status(404).send({ error: 'NotFound', message: `Nenhum histórico para "${ticker}".` });
    return;
  }

  let changePercent: number | null = null;
  if (history.length >= 2 && history[0] && history[1]) {
    const latest = history[0].netIncomeParent;
    const previous = history[1].netIncomeParent;
    if (previous !== 0) changePercent = ((latest - previous) / Math.abs(previous)) * 100;
  }

  reply.send({
    ticker,
    total: history.length,
    changePercent: changePercent !== null ? Number(changePercent.toFixed(2)) : null,
    data: history,
  });
}
