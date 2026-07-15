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
  const netIncome = Number(f.netIncomeParent ?? f.netIncome ?? 0);
  const revenue = Number(f.revenue ?? 0);
  const cogs = Math.abs(Number(f.cogs ?? 0)); // CVM reporta COGS negativo
  const ebit = Number(f.ebit ?? 0);
  const totalAssets = Number(f.totalAssets ?? 0);
  const totalLiabilities = Number(f.totalLiabilities ?? 0);
  const cash = Number(f.cash ?? 0);
  const equity = Number(f.equity ?? 0);
  const ocf = Number(f.operatingCashFlow ?? 0);
  const shares = Number(f.sharesOutstanding ?? f.shares_outstanding ?? 0);

  const eps = shares > 0 ? netIncome / shares : 0;
  const bvps = shares > 0 ? equity / shares : 0;
  const marketCap = shares > 0 ? shares * price : 0;
  const grossProfit = revenue - cogs;
  const netDebt = totalLiabilities - cash;
  // Enterprise Value = market cap + net debt. Requires a price (marketCap > 0);
  // total liabilities is the only debt figure the schema carries, so it proxies debt.
  const enterpriseValue = marketCap + netDebt;

  // DY a partir de DMPL CVM (dividendos + JCP do ano) / (cotação × ações) — dado real oficial
  const divPaid = Number(f.dividendsPaid ?? f.dividends_paid ?? 0);
  const jcpPaid = Number(f.jcpPaid ?? f.jcp_paid ?? 0);
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
    evEbit: ebit > 0 && marketCap > 0 && enterpriseValue > 0 ? +(enterpriseValue / ebit).toFixed(2) : null,
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
    dividendYield,
  };
}
