import { eq, desc, isNotNull } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { companies, companyFundamentals } from '../database/schema.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';

export interface CompanySummary {
  cnpj: string;
  ticker: string;
  name: string;
  sector: string | null;
}

export interface CompanyDetail extends CompanySummary {
  latestFundamentals: CompanyFundamentals | null;
}

export class CompanyQueries {
  /** Lista todas as empresas, com filtro opcional por setor */
  async listCompanies(sector?: string): Promise<CompanySummary[]> {
    if (sector) {
      return db
        .select({
          cnpj: companies.cnpj,
          ticker: companies.ticker,
          name: companies.name,
          sector: companies.sector,
        })
        .from(companies)
        .where(eq(companies.sector, sector))
        .orderBy(companies.ticker);
    }

    return db
      .select({
        cnpj: companies.cnpj,
        ticker: companies.ticker,
        name: companies.name,
        sector: companies.sector,
      })
      .from(companies)
      .orderBy(companies.ticker);
  }

  /** Lista setores distintos */
  async listSectors(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ sector: companies.sector })
      .from(companies)
      .where(isNotNull(companies.sector))
      .orderBy(companies.sector);

    return rows
      .map((r) => r.sector)
      .filter((s): s is string => s !== null);
  }

  /** Busca empresa por ticker (case-insensitive via lower) */
  async findByTicker(ticker: string): Promise<CompanySummary | null> {
    const rows = await db
      .select({
        cnpj: companies.cnpj,
        ticker: companies.ticker,
        name: companies.name,
        sector: companies.sector,
      })
      .from(companies)
      .where(eq(companies.ticker, ticker.toUpperCase()));

    return rows[0] ?? null;
  }

  /** Busca empresa por ticker com fundamentals mais recentes */
  async findDetailByTicker(ticker: string): Promise<CompanyDetail | null> {
    const companyRow = await this.findByTicker(ticker);
    if (!companyRow) return null;

    const fundamentals = await this.getLatestFundamentals(companyRow.cnpj);
    if (fundamentals) {
      fundamentals.ticker = companyRow.ticker;
      fundamentals.companyName = companyRow.name;
    }

    return {
      ...companyRow,
      latestFundamentals: fundamentals,
    };
  }

  /** Busca os fundamentos mais recentes de um CNPJ */
  private async getLatestFundamentals(
    cnpj: string,
  ): Promise<CompanyFundamentals | null> {
    const rows = await db
      .select()
      .from(companyFundamentals)
      .where(eq(companyFundamentals.companyCnpj, cnpj))
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      cnpj: row.companyCnpj,
      ticker: '',
      companyName: '',
      referenceDate: String(row.referenceDate).slice(0, 10),
      netIncome: Number(row.netIncome ?? 0),
      netIncomeAttributableToParent: Number(row.netIncomeParent ?? 0),
      fiscalYear: Number(row.fiscalYear),
      source: row.source as 'DFP' | 'ITR',
      extractedAt: row.extractedAt ? new Date(row.extractedAt) : new Date(),
    };
  }
}

// Singleton
export const companyQueries = new CompanyQueries();
