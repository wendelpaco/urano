/**
 * ScoreValidation — resultado da validação do score contra retornos históricos.
 * Preenchido a partir do relatório em docs/backtest/ e de `bun run freeze-verdict --apply`.
 * Consumido por GET /v1/analysis/validation e pela tool MCP explain_score.
 */

export interface ScoreValidation {
  scoreVersion: string;
  validatedAt: string | null; // "YYYY-MM-DD" ou null se pendente
  yearsTested: number[];
  verdict: 'edge' | 'quality-filter' | 'pending';
  summary: string; // 2-4 frases em português, linguagem de leigo
  topN: {
    n: number;
    avgPortfolio: number; // % média anual da estratégia
    avgMarket: number; // % média anual do universo coberto (não IBOV)
    winYears: number;
    totalYears: number;
  } | null;
  pillarCorrelations: Record<string, number> | null;
  /**
   * Benchmark de mercado real (IBOV). Preenchido em runtime via Yahoo ^BVSP
   * no controller de validation — campos estáticos documentam a fonte.
   */
  ibovBenchmark?: {
    source: string;
    symbol: string;
    note: string;
  };
  dataPolicy: {
    freeSourcesOnly: boolean;
    fundamentals: string;
    prices: string;
    macro: string;
    dividends: string;
  };
}

export const SCORE_VALIDATION: ScoreValidation = {
  scoreVersion: 'v1',
  validatedAt: '2026-07-15',
  yearsTested: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
  verdict: 'quality-filter',
  summary:
    'Comprando as 10 ações de maior score a cada ano entre 2015 e 2024, o retorno médio foi 23,2% ao ano contra 24,0% da média do universo coberto e 9,0% do IBOV — a estratégia ganhou do universo em 7/10 anos e do IBOV em 7/10. O score não ordena bem as melhores ações (correlação score×retorno ~0), mas a faixa mais baixa costuma ir pior; funciona melhor como filtro de qualidade do que como sinal de excess return. topN alinhado ao run persistido (docs/backtest/LATEST-RUN.json; freeze 2026-07-15).',
  topN: {
    n: 10,
    avgPortfolio: 23.18,
    avgMarket: 24.01,
    winYears: 7,
    totalYears: 10,
  },
  pillarCorrelations: {
    score: -0.099,
    valuation: -0.022,
    profitability: -0.182,
    growth: -0.094,
    dividends: 0,
    quality: -0.027,
    momentum: -0.002,
  },
  ibovBenchmark: {
    source: 'yahoo',
    symbol: '^BVSP',
    note: 'Retornos anuais civis calculados de closes reais Yahoo; ver campo ibov no response em runtime.',
  },
  dataPolicy: {
    freeSourcesOnly: true,
    fundamentals: 'CVM (DFP/ITR) — oficial',
    prices: 'Yahoo Finance + StatusInvest (fallback) — gratuitos, sem SLA',
    macro: 'BCB SGS — oficial e gratuito',
    dividends: 'StatusInvest → Postgres dividend_events; DMPL CVM como fallback anual',
  },
};
