import type { CompanyFundamentals } from '../entities/company-fundamentals.ts';

/**
 * Contrato para persistência de dados fundamentalistas de empresas.
 * A implementação concreta (ex: PostgreSQL, SQLite) ficará em infra/database.
 */
export interface ICompanyRepository {
  /**
   * Insere ou atualiza os dados fundamentalistas da empresa.
   * Retorna os dados persistidos.
   */
  upsertFundamentals(data: CompanyFundamentals): Promise<CompanyFundamentals>;

  /**
   * Busca os dados fundamentalistas mais recentes de uma empresa pelo CNPJ.
   */
  findLatestByCnpj(cnpj: string): Promise<CompanyFundamentals | null>;

  /**
   * Busca o histórico de lucro líquido dos últimos N trimestres para cálculo TTM.
   */
  findQuarterlyNetIncomeHistory(
    cnpj: string,
    limit: number,
  ): Promise<Array<{ referenceDate: string; netIncome: number }>>;
}
