/**
 * indicators.ts — Cálculo de indicadores financeiros a partir de fundamentos + cotação.
 *
 * Extraído de fundamentals.controller.ts para reuso sem duplicação (Onda 2b).
 * Função pura: zero dependências de banco ou rede.
 */

import type { FinancialIndicators } from '../entities/company-fundamentals.ts';

/**
 * Calcula todos os indicadores financeiros a partir de um registro de fundamentos
 * (formato row do Drizzle) e o preço atual da ação.
 *
 * @param f     Linha do banco (Record com campos snake_case do company_fundamentals + companies)
 * @param price Preço atual da ação (0 se indisponível)
 */
export function calcAllIndicators(
  f: Record<string, unknown>,
  price: number,
): FinancialIndicators {
  // Aceita camelCase (screener/ranking) e snake_case (rows cruas do Postgres).
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = f[k];
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
      }
    }
    return 0;
  };

  const netIncome = num('netIncomeParent', 'net_income_parent', 'netIncome', 'net_income');
  const revenue = num('revenue');
  const cogs = Math.abs(num('cogs')); // CVM reporta COGS negativo
  const ebit = num('ebit');
  const totalAssets = num('totalAssets', 'total_assets');
  const equity = num('equity');
  const ocf = num('operatingCashFlow', 'operating_cash_flow');
  const shares = num('sharesOutstanding', 'shares_outstanding');

  const eps = shares > 0 ? netIncome / shares : 0;
  const bvps = shares > 0 ? equity / shares : 0;
  const marketCap = shares > 0 ? shares * price : 0;
  const grossProfit = revenue - cogs;
  // Passivo total inclui fornecedores, impostos, provisões e outras obrigações;
  // não é dívida financeira. Até o ETL mapear empréstimos/debêntures por conta,
  // EV e índices de dívida permanecem indisponíveis em vez de usar um proxy falso.

  // DY a partir de DMPL CVM (dividendos + JCP do ano) / (cotação × ações) — dado real oficial
  const divPaid = num('dividendsPaid', 'dividends_paid');
  const jcpPaid = num('jcpPaid', 'jcp_paid');
  const totalDiv = divPaid + jcpPaid;
  const dividendYield =
    price > 0 && shares > 0 && totalDiv > 0
      ? +((totalDiv / (shares * price)) * 100).toFixed(2)
      : null;

  return {
    ticker: String(f.ticker ?? ''),
    referenceDate: String(f.referenceDate ?? f.reference_date ?? '').slice(0, 10),
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
    evEbit: null,
    // Endividamento
    debtToEquity: null,
    netDebtToEquity: null,
    // Per-share
    eps: +eps.toFixed(2),
    bvps: +bvps.toFixed(2),
    // Eficiência
    assetTurnover: totalAssets > 0 ? +(revenue / totalAssets).toFixed(2) : null,
    fcoToNetIncome: netIncome !== 0 ? +(ocf / Math.abs(netIncome)).toFixed(2) : null,
    // Mercado
    marketCap,
    dividendYield,
  };
}
