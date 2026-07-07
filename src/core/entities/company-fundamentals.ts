/**
 * Representa os dados fundamentalistas extraídos da DRE consolidada da CVM.
 * Valores financeiros já estão em Reais (R$), após conversão da escala monetária.
 */
export interface CompanyFundamentals {
  cnpj: string;
  ticker: string;
  companyName: string;
  referenceDate: string; // YYYY-MM-DD (data de referência do demonstrativo)
  netIncome: number; // Lucro/Prejuízo Consolidado do Período (em R$)
  netIncomeAttributableToParent: number; // Atribuído aos sócios controladores (em R$)
  fiscalYear: number;
  source: 'DFP' | 'ITR'; // Origem: Demonstração Financeira Padronizada ou Trimestral
  extractedAt: Date;
}

/**
 * Resultado do cálculo TTM (Trailing Twelve Months) de lucro líquido.
 */
export interface TTMNetIncome {
  ttmNetIncome: number;
  periods: number; // Quantidade de trimestres considerados (4 para TTM completo)
  latestQuarter: string; // Data do trimestre mais recente
  quarters: Array<{ referenceDate: string; netIncome: number }>;
}
