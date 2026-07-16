import { eq, desc } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { companies, companyFundamentals } from '../database/schema.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';

export interface FundamentalsHistoryItem {
  fiscalYear: number;
  period: string;
  referenceDate: string;
  source: string;
  netIncome: number;
  netIncomeParent: number;
  equity: number | null;
}

export class FundamentalsQueries {
  /** Busca os fundamentos mais recentes de um ticker (via JOIN com companies) */
  async getLatestByTicker(ticker: string): Promise<CompanyFundamentals | null> {
    const rows = await db
      .select({
        cnpj: companyFundamentals.companyCnpj,
        ticker: companies.ticker,
        companyName: companies.name,
        fiscalYear: companyFundamentals.fiscalYear,
        period: companyFundamentals.period,
        referenceDate: companyFundamentals.referenceDate,
        source: companyFundamentals.source,
        netIncome: companyFundamentals.netIncome,
        netIncomeParent: companyFundamentals.netIncomeParent,
        equity: companyFundamentals.equity,
        extractedAt: companyFundamentals.extractedAt,
      })
      .from(companyFundamentals)
      .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
      .where(eq(companies.ticker, ticker.toUpperCase()))
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      cnpj: row.cnpj,
      ticker: row.ticker ?? ticker,
      companyName: row.companyName ?? '',
      referenceDate: String(row.referenceDate).slice(0, 10),
      netIncome: Number(row.netIncome ?? 0),
      netIncomeAttributableToParent: Number(row.netIncomeParent ?? 0),
      fiscalYear: Number(row.fiscalYear),
      source: row.source as 'DFP' | 'ITR',
      extractedAt: row.extractedAt ? new Date(row.extractedAt) : new Date(),
    };
  }

  /** Busca histórico de fundamentos de um ticker */
  async getHistoryByTicker(
    ticker: string,
    limit = 10,
  ): Promise<FundamentalsHistoryItem[]> {
    const rows = await db
      .select({
        fiscalYear: companyFundamentals.fiscalYear,
        period: companyFundamentals.period,
        referenceDate: companyFundamentals.referenceDate,
        source: companyFundamentals.source,
        netIncome: companyFundamentals.netIncome,
        netIncomeParent: companyFundamentals.netIncomeParent,
        equity: companyFundamentals.equity,
      })
      .from(companyFundamentals)
      .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
      .where(eq(companies.ticker, ticker.toUpperCase()))
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(limit);

    return rows.map((r) => ({
      fiscalYear: Number(r.fiscalYear),
      period: r.period,
      referenceDate: String(r.referenceDate).slice(0, 10),
      source: r.source,
      netIncome: Number(r.netIncome ?? 0),
      netIncomeParent: Number(r.netIncomeParent ?? 0),
      equity: r.equity ? Number(r.equity) : null,
    }));
  }
}

export const fundamentalsQueries = new FundamentalsQueries();
