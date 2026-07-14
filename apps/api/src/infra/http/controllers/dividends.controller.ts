import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { DividendsAnalyzer } from '../../../core/services/dividends-analyzer.ts';

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

  const totalPerShare = events.reduce((sum, e) => sum + e.valuePerShare, 0);

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

  reply.send({
    ticker,
    companyName: company.name,
    source: dmplFallback
      ? 'CVM — DMPL (Demonstração das Mutações do Patrimônio Líquido)'
      : 'StatusInvest (proventos mensais)',
    total: events.length,
    totalValuePerShare: Math.round(totalPerShare * 100) / 100,
    data: events,
    monthlyHistory,
    analysis,
    dataQuality: {
      dividends: dividendsAvailable,
      dmplFallback,
    },
  });
}
