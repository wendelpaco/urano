/**
 * Dados fundamentalistas completos extraídos da CVM (DRE + BPA + BPP + DFC).
 */
export interface CompanyFundamentals {
  cnpj: string;
  ticker: string;
  companyName: string;
  referenceDate: string;
  netIncome: number;
  netIncomeAttributableToParent: number;
  revenue?: number;
  cogs?: number;
  ebit?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  cash?: number;
  operatingCashFlow?: number;
  equity?: number;
  sharesOutstanding?: number;
  dividendsPaid?: number;
  jcpPaid?: number;
  fiscalYear: number;
  source: 'DFP' | 'ITR';
  extractedAt: Date;
}

/** Indicadores financeiros calculados a partir dos fundamentos + cotação */
export interface FinancialIndicators {
  ticker: string;
  referenceDate: string;
  grossMargin: number | null;
  ebitMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roa: number | null;
  roic: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  psRatio: number | null;
  pebit: number | null;
  evEbit: number | null;
  debtToEquity: number | null;
  netDebtToEquity: number | null;
  eps: number | null;
  bvps: number | null;
  assetTurnover: number | null;
  fcoToNetIncome: number | null;
  marketCap: number;
  dividendYield: number | null;
}

export interface TTMNetIncome {
  ttmNetIncome: number;
  periods: number;
  latestQuarter: string;
  quarters: Array<{ referenceDate: string; netIncome: number }>;
}
