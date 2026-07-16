import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tickerParamSchema } from '../../../shared/ticker-utils.ts';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { DividendsAnalyzer } from '../../../core/services/dividends-analyzer.ts';
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

/**
 * GET /v1/dividends/:ticker
 *
 * Retorna histórico de dividendos e JCP extraídos do DMPL
 * (Demonstração das Mutações do Patrimônio Líquido) da CVM.
 */
export async function getDividendsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');

  const { ticker } = parsed.data;

  const [company] = await db
    .select({ cnpj: companies.cnpj, name: companies.name })
    .from(companies)
    .where(eq(companies.ticker, ticker));

  if (!company) {
    reply.status(404).send({ error: 'NotFound', message: `Empresa "${ticker}" não encontrada.` });
    return;
  }

  const rows = await db
    .select({
      fiscalYear: companyFundamentals.fiscalYear,
      referenceDate: companyFundamentals.referenceDate,
      dividendsPaid: companyFundamentals.dividendsPaid,
      jcpPaid: companyFundamentals.jcpPaid,
      netIncomeParent: companyFundamentals.netIncomeParent,
      sharesOutstanding: companyFundamentals.sharesOutstanding,
    })
    .from(companyFundamentals)
    .where(eq(companyFundamentals.companyCnpj, company.cnpj))
    .orderBy(desc(companyFundamentals.referenceDate))
    .limit(5);

  const events: Array<{
    fiscalYear: number;
    type: string;
    totalValue: number;
    valuePerShare: number;
    payoutRatio: number | null;
  }> = [];

  for (const r of rows) {
    const div = Number(r.dividendsPaid ?? 0);
    const jcp = Number(r.jcpPaid ?? 0);
    const shares = Number(r.sharesOutstanding ?? 0);
    const netIncome = Number(r.netIncomeParent ?? 0);

    if (div > 0) {
      events.push({
        fiscalYear: Number(r.fiscalYear),
        type: 'DIVIDEND',
        totalValue: div,
        valuePerShare: shares > 0 ? Math.round((div / shares) * 100) / 100 : 0,
        payoutRatio: netIncome > 0 ? Math.round((div / netIncome) * 10000) / 100 : null,
      });
    }
    if (jcp > 0) {
      events.push({
        fiscalYear: Number(r.fiscalYear),
        type: 'JCP',
        totalValue: jcp,
        valuePerShare: shares > 0 ? Math.round((jcp / shares) * 100) / 100 : 0,
        payoutRatio: netIncome > 0 ? Math.round((jcp / netIncome) * 10000) / 100 : null,
      });
    }
  }

  const dmplTotalPerShare = events.reduce((sum, e) => sum + e.valuePerShare, 0);

  // Onda 1d: busca proventos mensais do StatusInvest + análise
  let monthlyHistory: Array<{ date: string; value: number; type: string; ticker: string }> | null = null;
  let analysis = null;
  let dividendsAvailable = false;
  let dmplFallback = true;

  try {
    const proventos = await dividendsProvider.fetchDividends(ticker);
    if (proventos !== null) {
      dividendsAvailable = true;
      dmplFallback = false;
      if (proventos.length > 0) {
        monthlyHistory = proventos.map((e) => ({
          date: e.date,
          value: e.value,
          type: e.type,
          ticker,
        }));
        analysis = DividendsAnalyzer.analyze(proventos);
      }
    }
  } catch {
    // Provider falhou → degradado, mantém DMPL
  }

  // DMPL (ações) preenche total/data. FIIs em geral só têm monthlyHistory —
  // sem este fallback a API devolvia total=0 com 100+ eventos no histórico.
  let total = events.length;
  let totalValuePerShare = Math.round(dmplTotalPerShare * 100) / 100;
  if (events.length === 0 && monthlyHistory && monthlyHistory.length > 0) {
    total = monthlyHistory.length;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const trailing = incomeDistributionsSince(monthlyHistory, cutoffIso);
    const window = trailing.length > 0
      ? trailing
      : monthlyHistory.filter((event) => event.type !== 'AMORTIZACAO').slice(0, 12);
    const sum = sumIncomeDistributions(window);
    totalValuePerShare = Math.round(sum * 100) / 100;
  }

  reply.send({
    ticker,
    companyName: company.name,
    source: dmplFallback
      ? 'cvm_dmpl'
      : 'statusinvest',
    sourceLabel: dmplFallback
      ? 'CVM — DMPL (Demonstração das Mutações do Patrimônio Líquido)'
      : 'StatusInvest (proventos mensais; cache Redis + Postgres canônico)',
    asOf: new Date().toISOString(),
    total,
    totalValuePerShare,
    /** Eventos anuais DMPL (ações). FIIs: [] — use monthlyHistory. */
    data: events,
    monthlyHistory,
    analysis,
    dataQuality: {
      dividends: dividendsAvailable,
      dmplFallback,
      freeSourcesOnly: true,
    },
  });
}
