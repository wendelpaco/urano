import { eq, desc, and } from 'drizzle-orm';
import type { ICompanyRepository } from '../../core/repositories/company-repository.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';
import { db } from './connection.ts';
import { companies, companyFundamentals } from './schema.ts';

/**
 * Implementação PostgreSQL via Drizzle ORM do repositório de dados fundamentalistas.
 *
 * Substitui as queries raw SQL por chamadas tipadas do Drizzle.
 * UPSERT via .onConflictDoUpdate() garante idempotência nas sincronizações.
 */
export class PgCompanyRepository implements ICompanyRepository {
  async upsertFundamentals(
    data: CompanyFundamentals,
  ): Promise<CompanyFundamentals> {
    // Garante que a empresa existe
    await this.ensureCompany(data.cnpj, data.ticker, data.companyName);

    const period = this.inferPeriod(data.referenceDate, data.source);
    const now = new Date();

    const rows = await db
      .insert(companyFundamentals)
      .values({
        companyCnpj: data.cnpj,
        fiscalYear: data.fiscalYear,
        period,
        referenceDate: data.referenceDate,
        source: data.source,
        netIncome: String(data.netIncome),
        netIncomeParent: String(data.netIncomeAttributableToParent),
        revenue: data.revenue != null ? String(data.revenue) : null,
        cogs: data.cogs != null ? String(data.cogs) : null,
        ebit: data.ebit != null ? String(data.ebit) : null,
        totalAssets: data.totalAssets != null ? String(data.totalAssets) : null,
        totalLiabilities: data.totalLiabilities != null ? String(data.totalLiabilities) : null,
        cash: data.cash != null ? String(data.cash) : null,
        dividendsPaid: data.dividendsPaid != null ? String(data.dividendsPaid) : null,
        jcpPaid: data.jcpPaid != null ? String(data.jcpPaid) : null,
        operatingCashFlow: data.operatingCashFlow != null ? String(data.operatingCashFlow) : null,
        equity: data.equity != null ? String(data.equity) : null,
        sharesOutstanding: data.sharesOutstanding != null ? String(data.sharesOutstanding) : null,
        extractedAt: data.extractedAt,
      })
      .onConflictDoUpdate({
        target: [
          companyFundamentals.companyCnpj,
          companyFundamentals.fiscalYear,
          companyFundamentals.period,
          companyFundamentals.source,
        ],
        set: {
          netIncome: String(data.netIncome),
          netIncomeParent: String(data.netIncomeAttributableToParent),
          revenue: data.revenue != null ? String(data.revenue) : null,
          cogs: data.cogs != null ? String(data.cogs) : null,
          ebit: data.ebit != null ? String(data.ebit) : null,
          totalAssets: data.totalAssets != null ? String(data.totalAssets) : null,
          totalLiabilities: data.totalLiabilities != null ? String(data.totalLiabilities) : null,
          cash: data.cash != null ? String(data.cash) : null,
          dividendsPaid: data.dividendsPaid != null ? String(data.dividendsPaid) : null,
          jcpPaid: data.jcpPaid != null ? String(data.jcpPaid) : null,
          operatingCashFlow: data.operatingCashFlow != null ? String(data.operatingCashFlow) : null,
          sharesOutstanding: data.sharesOutstanding != null ? String(data.sharesOutstanding) : null,
          referenceDate: data.referenceDate,
          equity: data.equity != null ? String(data.equity) : null,
          extractedAt: data.extractedAt,
          updatedAt: now,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error('UPSERT não retornou linha — verifique a constraint unique');
    }

    return this.mapRowToFundamentals(
      { ...row, cnpj: row.companyCnpj },
      data.ticker,
    );
  }

  async findLatestByCnpj(cnpj: string): Promise<CompanyFundamentals | null> {
    const rows = await db
      .select({
        cnpj: companyFundamentals.companyCnpj,
        fiscalYear: companyFundamentals.fiscalYear,
        period: companyFundamentals.period,
        referenceDate: companyFundamentals.referenceDate,
        source: companyFundamentals.source,
        netIncome: companyFundamentals.netIncome,
        netIncomeParent: companyFundamentals.netIncomeParent,
        equity: companyFundamentals.equity,
        extractedAt: companyFundamentals.extractedAt,
        ticker: companies.ticker,
        companyName: companies.name,
      })
      .from(companyFundamentals)
      .innerJoin(companies, eq(companyFundamentals.companyCnpj, companies.cnpj))
      .where(eq(companyFundamentals.companyCnpj, cnpj))
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;
    return this.mapRowToFundamentals(
      { ...row, netIncome: row.netIncome },
      row.ticker ?? '',
    );
  }

  async findQuarterlyNetIncomeHistory(
    cnpj: string,
    limit: number,
  ): Promise<Array<{ referenceDate: string; netIncome: number }>> {
    // Busca ITR primeiro (dados trimestrais)
    const itrRows = await db
      .select({
        referenceDate: companyFundamentals.referenceDate,
        netIncome: companyFundamentals.netIncomeParent,
      })
      .from(companyFundamentals)
      .where(
        and(
          eq(companyFundamentals.companyCnpj, cnpj),
          eq(companyFundamentals.source, 'ITR'),
        ),
      )
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(limit);

    const mapRow = (r: typeof itrRows[number]) => ({
      referenceDate: r.referenceDate,
      netIncome: Number(r.netIncome ?? 0),
    });

    if (itrRows.length >= limit) {
      return itrRows.map(mapRow);
    }

    // Fallback: complementa com DFP anual (estima trimestral = FY/4)
    const dfpRows = await db
      .select({
        referenceDate: companyFundamentals.referenceDate,
        netIncome: companyFundamentals.netIncomeParent,
      })
      .from(companyFundamentals)
      .where(
        and(
          eq(companyFundamentals.companyCnpj, cnpj),
          eq(companyFundamentals.source, 'DFP'),
        ),
      )
      .orderBy(desc(companyFundamentals.referenceDate))
      .limit(1);

    const results = itrRows.map(mapRow);

    if (dfpRows.length > 0) {
      const dfpRow = dfpRows[0]!;
      const annual = Number(dfpRow.netIncome ?? 0);
      const estimated = annual / 4;

      while (results.length < limit) {
        results.push({
          referenceDate: dfpRow.referenceDate,
          netIncome: estimated,
        });
      }
    }

    return results.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * UPSERT na tabela companies: insere se não existe, atualiza ticker/nome se existir.
   */
  private async ensureCompany(
    cnpj: string,
    ticker: string,
    name: string,
  ): Promise<void> {
    const now = new Date();
    await db
      .insert(companies)
      .values({ cnpj, ticker, name, sector: null, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: companies.cnpj,
        set: { ticker, name, updatedAt: now },
      });
  }

  /**
   * Infere o período contábil (Q1-Q4 ou FY) a partir da data de referência.
   * DFP → FY, ITR → Q1/Q2/Q3/Q4 baseado no mês.
   */
  private inferPeriod(referenceDate: string, source: string): string {
    if (source === 'DFP') return 'FY';

    const month = parseInt(referenceDate.slice(5, 7), 10);
    const quarterMap: Record<number, string> = {
      3: 'Q1',
      6: 'Q2',
      9: 'Q3',
      12: 'Q4',
    };
    return quarterMap[month] ?? 'FY';
  }

  /**
   * Converte uma linha do Drizzle (decimal como string, date como string)
   * para a entidade de domínio CompanyFundamentals.
   */
  private mapRowToFundamentals(
    row: {
      cnpj: string;
      fiscalYear: number;
      period: string;
      referenceDate: string;
      source: string;
      netIncome: string | number;
      netIncomeParent: string | number;
      equity?: string | number | null;
      extractedAt: Date | null;
      ticker?: string | null;
      companyName?: string | null;
    },
    ticker: string,
  ): CompanyFundamentals {
    return {
      cnpj: row.cnpj,
      ticker: ticker || row.ticker || '',
      companyName: row.companyName ?? '',
      referenceDate: String(row.referenceDate).slice(0, 10),
      netIncome: Number(row.netIncome ?? 0),
      netIncomeAttributableToParent: Number(row.netIncomeParent ?? 0),
      fiscalYear: Number(row.fiscalYear),
      source: row.source as 'DFP' | 'ITR',
      extractedAt: row.extractedAt ? new Date(row.extractedAt) : new Date(),
    };
  }
}
