import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { fundamentalsQueries } from '../../database/fundamentals-queries.ts';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
import type { FinancialIndicators } from '../../../core/entities/company-fundamentals.ts';

const paramsSchema = z.object({
  ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
});

function calcAllIndicators(f: Record<string, unknown>, price: number): FinancialIndicators {
  const netIncome = Number(f.netIncomeParent ?? f.netIncome ?? 0);
  const revenue = Number(f.revenue ?? 0);
  const cogs = Math.abs(Number(f.cogs ?? 0)); // CVM reporta COGS negativo
  const ebit = Number(f.ebit ?? 0);
  const totalAssets = Number(f.totalAssets ?? 0);
  const totalLiabilities = Number(f.totalLiabilities ?? 0);
  const cash = Number(f.cash ?? 0);
  const equity = Number(f.equity ?? 0);
  const ocf = Number(f.operatingCashFlow ?? 0);
  const shares = Number(f.sharesOutstanding ?? 0);

  const eps = shares > 0 ? netIncome / shares : 0;
  const bvps = shares > 0 ? equity / shares : 0;
  const marketCap = shares > 0 ? shares * price : 0;
  const grossProfit = revenue - cogs;
  const netDebt = totalLiabilities - cash;

  return {
    ticker: String(f.ticker ?? ''),
    referenceDate: String(f.referenceDate ?? '').slice(0, 10),
    // Margens
    grossMargin: revenue > 0 ? +(grossProfit / revenue * 100).toFixed(2) : null,
    ebitMargin: revenue > 0 ? +(ebit / revenue * 100).toFixed(2) : null,
    netMargin: revenue > 0 ? +(netIncome / revenue * 100).toFixed(2) : null,
    // Retornos
    roe: equity > 0 ? +(netIncome / equity * 100).toFixed(2) : null,
    roa: totalAssets > 0 ? +(netIncome / totalAssets * 100).toFixed(2) : null,
    // Valuation
    peRatio: eps > 0 && price > 0 ? +(price / eps).toFixed(2) : null,
    pbRatio: bvps > 0 && price > 0 ? +(price / bvps).toFixed(2) : null,
    psRatio: revenue > 0 && shares > 0 ? +(marketCap / revenue).toFixed(2) : null,
    pebit: ebit > 0 && shares > 0 ? +(marketCap / ebit).toFixed(2) : null,
    evEbit: ebit > 0 ? +((totalLiabilities + equity) / ebit).toFixed(2) : null,
    // Endividamento
    debtToEquity: equity > 0 ? +(totalLiabilities / equity).toFixed(2) : null,
    netDebtToEquity: equity > 0 ? +(netDebt / equity).toFixed(2) : null,
    // Per-share
    eps: +eps.toFixed(2),
    bvps: +bvps.toFixed(2),
    // Eficiência
    assetTurnover: totalAssets > 0 ? +(revenue / totalAssets).toFixed(2) : null,
    fcoToNetIncome: netIncome !== 0 ? +(ocf / Math.abs(netIncome)).toFixed(2) : null,
    // Mercado
    marketCap,
    dividendYield: null,
  };
}

/** GET /v1/fundamentals/:ticker */
export async function getLatestFundamentalsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { ticker } = paramsSchema.parse(request.params);

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

  reply.send({
    ticker: f.ticker,
    companyName: f.companyName,
    cnpj: f.cnpj,
    period: { fiscalYear: f.fiscalYear, referenceDate: String(f.referenceDate).slice(0, 10), source: f.source },
    price: price || null,
    indicators,
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
  const { ticker } = paramsSchema.parse(request.params);
  const querySchema = z.object({
    limit: z.string().optional().default('10').transform(Number).pipe(z.number().int().min(1).max(50)),
  });
  const { limit } = querySchema.parse(request.query);
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
