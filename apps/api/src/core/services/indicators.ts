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
  const totalLiabilities = num('totalLiabilities', 'total_liabilities');
  const cash = num('cash');
  const shares = num('sharesOutstanding', 'shares_outstanding');

  // ENG-8: shares ausente → eps/bvps null, não zero (empresa no prejuízo escapava de penalidade)
  const eps = shares > 0 ? netIncome / shares : null;
  const bvps = shares > 0 ? equity / shares : null;
  const marketCap = shares > 0 ? shares * price : null;
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
    peRatio: eps !== null && eps > 0 && price > 0 ? +(price / eps).toFixed(2) : null,
    pbRatio: bvps !== null && bvps > 0 && price > 0 ? +(price / bvps).toFixed(2) : null,
    psRatio: revenue > 0 && shares > 0 && marketCap !== null ? +(marketCap / revenue).toFixed(2) : null,
    pebit: ebit > 0 && shares > 0 && marketCap !== null ? +(marketCap / ebit).toFixed(2) : null,
    evEbit: null,
    // Endividamento
    debtToEquity: null,
    netDebtToEquity: null,
    // Per-share
    eps: eps !== null ? +eps.toFixed(2) : null,
    bvps: bvps !== null ? +bvps.toFixed(2) : null,
    // ROIC: NOPAT / Capital Investido. NOPAT = EBIT * (1 - 0.34) (taxa BR aproximada).
    // Capital investido = Equity + Total Liabilities - Cash (aproximação conservadora).
    // UX-4: retorna null se não houver EBIT ou capital investido.
    // IMP-2: refinar quando o ETL mapear dívida financeira real.
    roic: ebit > 0 && totalLiabilities > 0 && equity + totalLiabilities - cash > 0
      ? +((ebit * 0.66) / (equity + totalLiabilities - cash) * 100).toFixed(2)
      : null,
    // Eficiência
    assetTurnover: totalAssets > 0 ? +(revenue / totalAssets).toFixed(2) : null,
    // ENG-8: empresa no prejuízo → FCO/NetIncome é indefinido (não creditar qualidade com |netIncome|)
    fcoToNetIncome: netIncome > 0 && ocf > 0 ? +(ocf / netIncome).toFixed(2) : null,
    // Mercado
    marketCap: marketCap ?? 0,
    dividendYield,
  };
}
