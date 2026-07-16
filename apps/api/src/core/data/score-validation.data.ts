/**
 * ScoreValidation — resultado da validação do score contra retornos históricos.
 * Preenchido a partir do relatório em docs/backtest/ e de `bun run freeze-verdict --apply`.
 * Consumido por GET /v1/analysis/validation e pela tool MCP explain_score.
 */

export interface ScoreValidation {
  scoreVersion: string;
  /** False bloqueia qualquer uso do score para gerar ordens/alocação. */
  decisionUseAllowed: boolean;
  decisionBlockers: string[];
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
  decisionUseAllowed: false,
  decisionBlockers: [
    'backtest sem datas de publicação e universo histórico ponto-no-tempo',
    'taxonomia de dívida financeira ainda não separada de passivos operacionais',
    'quantidade de ações e proventos CVM exigem reconciliação por emissor',
  ],
  validatedAt: null,
  yearsTested: [],
  verdict: 'pending',
  summary:
    'A validação anterior foi invalidada: os fundamentos foram associados à data de referência contábil, embora só tenham se tornado públicos depois, e o universo histórico não foi reconstruído ponto no tempo. Até um novo backtest usar datas de publicação, universo histórico e custos observáveis, o score é apenas uma heurística experimental e não sustenta alegações de filtro validado, retorno ou recomendação.',
  topN: null,
  pillarCorrelations: null,
  ibovBenchmark: {
    source: 'yahoo',
    symbol: '^BVSP',
    note: 'Retornos anuais civis calculados de closes reais Yahoo; ver campo ibov no response em runtime.',
  },
  dataPolicy: {
    freeSourcesOnly: true,
    fundamentals:
      'CVM (DFP/ITR) — oficial; revalidação deve respeitar a data de publicação',
    prices: 'Yahoo Finance + StatusInvest (fallback) — gratuitos, sem SLA',
    macro: 'BCB SGS — oficial e gratuito',
    dividends: 'StatusInvest → Postgres dividend_events; DMPL CVM como fallback anual',
  },
};
