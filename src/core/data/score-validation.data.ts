/**
 * ScoreValidation — resultado da validação do score contra retornos históricos.
 * Preenchido manualmente a partir do relatório em docs/backtest/.
 * Consumido por GET /v1/analysis/validation e pela tool MCP explain_score.
 */

export interface ScoreValidation {
  scoreVersion: string;
  validatedAt: string | null;          // "YYYY-MM-DD" ou null se pendente
  yearsTested: number[];
  verdict: 'edge' | 'quality-filter' | 'pending';
  summary: string;                     // 2-4 frases em português, linguagem de leigo
  topN: {
    n: number;
    avgPortfolio: number;              // % média anual da estratégia
    avgMarket: number;                 // % média anual do universo
    winYears: number;
    totalYears: number;
  } | null;
  pillarCorrelations: Record<string, number> | null;
}

export const SCORE_VALIDATION: ScoreValidation = {
  scoreVersion: 'v1',
  validatedAt: '2026-07-08',
  yearsTested: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
  verdict: 'quality-filter',
  summary:
    'Comprando as 10 ações de maior score a cada ano entre 2015 e 2024, o retorno médio foi 28,4% ao ano contra 25,4% da média do mercado (universo coberto) — uma vantagem pequena, e a estratégia só ganhou em 6 dos 10 anos testados. O score não ordena bem as melhores ações (os decis de score mais alto não renderam mais que os intermediários), mas a faixa de score mais baixa teve retorno nitidamente pior que as demais, então ele funciona melhor como filtro de empresas fracas do que como sinal de retorno esperado.',
  topN: {
    n: 10,
    avgPortfolio: 28.4,
    avgMarket: 25.4,
    winYears: 6,
    totalYears: 10,
  },
  pillarCorrelations: {
    score: -0.047,
    valuation: 0.017,
    profitability: -0.179,
    growth: -0.094,
    dividends: 0,
    quality: -0.026,
    momentum: 0,
  },
};
