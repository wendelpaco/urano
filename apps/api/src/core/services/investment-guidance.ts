/**
 * Investment Guidance — orientação em português para o investidor mediano.
 *
 * Transforma score + reasons + alerts + cobertura em uma postura clara:
 * estudar para aportar, manter, evitar entrada, ou considerar redução.
 *
 * NÃO é recomendação de investimento regulada (CVM 19/20). É leitura do
 * filtro de qualidade fundamentalista (quality-filter), com linguagem
 * acionável para quem está montando a primeira carteira.
 *
 * Pure functions — sem I/O.
 */

export type GuidanceStance =
  | 'study_to_buy'
  | 'accumulate'
  | 'hold_watch'
  | 'avoid_entry'
  | 'consider_reduce';

export type GuidanceConfidence = 'alta' | 'media' | 'baixa';

export type AssetKind = 'stock' | 'fii';

export interface GuidanceInput {
  ticker: string;
  assetType: AssetKind;
  score: number;
  /** Pontos fortes do motor (já em PT). */
  reasons: string[];
  /** Alertas / pontos fracos (já em PT). */
  alerts: string[];
  /** Diagnóstico curto do score, se houver. */
  diagnosis?: string | null;
  /** Explicação FII, se houver. */
  explanation?: string | null;
  dataCoveragePercent?: number | null;
  criticalComplete?: boolean | null;
  anomalyCount?: number;
  /** Divergências de fontes (ex.: CVM vs Fundamentus). */
  sourceDivergences?: string[];
  /** Rating FII (excelente…evitar), se aplicável. */
  qualityRating?: string | null;
  /** FII ainda experimental no backtest. */
  experimental?: boolean;
}

export interface InvestmentGuidance {
  stance: GuidanceStance;
  /** Rótulo curto para UI (ex.: "Vale estudar para aportar"). */
  stanceLabel: string;
  /** Cor semântica: positive | warning | negative | muted */
  stanceTone: 'positive' | 'warning' | 'negative' | 'muted';
  /** Uma frase que o iniciante lê primeiro. */
  headline: string;
  /** Por que o Urano aponta nesta direção (máx. ~5). */
  why: string[];
  /** Riscos e o que pode dar errado. */
  risks: string[];
  /** O que fazer se ainda NÃO tem o ativo (primeiro aporte). */
  ifNotHolding: string;
  /** O que fazer se JÁ tem o ativo na carteira. */
  ifHolding: string;
  /** Passos práticos para o iniciante. */
  nextSteps: string[];
  /** Quando reavaliar. */
  whenToRevisit: string;
  confidence: GuidanceConfidence;
  confidenceNote: string;
  disclaimers: string[];
  /** Motivos estruturados para o painel Reasons. */
  structuredReasons: Array<{ kind: 'pro' | 'con' | 'info'; text: string }>;
}

const STANCE_LABELS: Record<GuidanceStance, string> = {
  study_to_buy: 'Vale estudar para aportar',
  accumulate: 'Perfil forte — aporte se encaixar',
  hold_watch: 'Neutro — acompanhar com critério',
  avoid_entry: 'Evite iniciar posição agora',
  consider_reduce: 'Considere reduzir ou não aumentar',
};

const STANCE_TONES: Record<GuidanceStance, InvestmentGuidance['stanceTone']> = {
  study_to_buy: 'positive',
  accumulate: 'positive',
  hold_watch: 'warning',
  avoid_entry: 'negative',
  consider_reduce: 'negative',
};

const BASE_DISCLAIMERS = [
  'Isto não é recomendação de investimento nem de timing de mercado.',
  'O score Urano é um filtro de qualidade fundamentalista: score alto não garante retorno acima do mercado.',
  'Diversifique, defina horizonte e só invista o que pode manter no longo prazo.',
];

/**
 * Postura leve só a partir do score (ranking/screener — sem I/O).
 * Preferir buildInvestmentGuidance na ficha completa.
 */
export function stanceFromScore(
  score: number,
  opts: {
    experimental?: boolean;
    qualityRating?: string | null;
    criticalComplete?: boolean;
    alertCount?: number;
  } = {},
): Pick<InvestmentGuidance, 'stance' | 'stanceLabel' | 'stanceTone'> {
  const s = clampScore(score);
  const experimental = opts.experimental === true;
  const criticalOk = opts.criticalComplete ?? true;
  const confidence: GuidanceConfidence = experimental ? 'baixa' : criticalOk ? 'alta' : 'media';
  const alerts = Array.from({ length: opts.alertCount ?? 0 }, () => 'alerta');
  const stance = resolveStance({
    score: s,
    alerts,
    criticalOk,
    confidence,
    qualityRating: opts.qualityRating,
  });
  return {
    stance,
    stanceLabel: STANCE_LABELS[stance],
    stanceTone: STANCE_TONES[stance],
  };
}

/**
 * Gera orientação acionável a partir do resultado de análise.
 */
export function buildInvestmentGuidance(input: GuidanceInput): InvestmentGuidance {
  const score = clampScore(input.score);
  const coverage = input.dataCoveragePercent ?? null;
  const criticalOk = input.criticalComplete ?? (coverage === null || coverage >= 80);
  const anomalies = input.anomalyCount ?? 0;
  const divergences = input.sourceDivergences ?? [];
  const reasons = uniqNonEmpty(input.reasons).slice(0, 8);
  const alerts = uniqNonEmpty(input.alerts).slice(0, 8);
  const experimental = input.experimental === true || input.assetType === 'fii';

  const confidence = resolveConfidence({
    coverage,
    criticalOk,
    anomalyCount: anomalies,
    divergenceCount: divergences.length,
    experimental,
  });

  const stance = resolveStance({
    score,
    alerts,
    criticalOk,
    confidence,
    qualityRating: input.qualityRating,
  });

  const why = buildWhy(stance, score, reasons, alerts, input);
  const risks = buildRisks(stance, alerts, divergences, anomalies, experimental, input.assetType);
  const headline = buildHeadline(input.ticker, stance, score, input.assetType, experimental);
  const { ifNotHolding, ifHolding } = buildHoldingAdvice(stance, input.assetType, experimental);
  const nextSteps = buildNextSteps(stance, input.assetType, input.ticker);
  const whenToRevisit = buildWhenToRevisit(stance, input.assetType);

  const structuredReasons: InvestmentGuidance['structuredReasons'] = [
    ...reasons.map((text) => ({ kind: 'pro' as const, text })),
    ...alerts.map((text) => ({ kind: 'con' as const, text })),
    ...divergences.map((text) => ({ kind: 'info' as const, text: `Fontes divergem: ${text}` })),
  ];

  if (input.diagnosis) {
    structuredReasons.unshift({ kind: 'info', text: input.diagnosis });
  } else if (input.explanation) {
    structuredReasons.unshift({ kind: 'info', text: input.explanation });
  }

  const disclaimers = [...BASE_DISCLAIMERS];
  if (experimental) {
    disclaimers.unshift(
      'Score de FII é experimental e ainda não tem o mesmo backtest histórico das ações.',
    );
  }

  return {
    stance,
    stanceLabel: STANCE_LABELS[stance],
    stanceTone: STANCE_TONES[stance],
    headline,
    why: why.slice(0, 5),
    risks: risks.slice(0, 5),
    ifNotHolding,
    ifHolding,
    nextSteps,
    whenToRevisit,
    confidence,
    confidenceNote: confidenceNote(confidence, coverage, experimental),
    disclaimers,
    structuredReasons: structuredReasons.slice(0, 12),
  };
}

// ─── Stance ──────────────────────────────────────────────────────────────────

function resolveStance(opts: {
  score: number;
  alerts: string[];
  criticalOk: boolean;
  confidence: GuidanceConfidence;
  qualityRating?: string | null;
}): GuidanceStance {
  const { score, alerts, criticalOk, confidence, qualityRating } = opts;
  const severeAlerts = alerts.filter((a) =>
    /preju[ií]zo|extrem|invi[aá]vel|fal[eê]ncia|absurdo|cobertura de dados/i.test(a),
  ).length;

  // Rating FII explícito "evitar" / "ruim"
  if (qualityRating === 'evitar' || qualityRating === 'ruim') {
    return score < 40 ? 'consider_reduce' : 'avoid_entry';
  }

  if (score >= 75 && criticalOk && severeAlerts === 0) {
    return confidence === 'baixa' ? 'study_to_buy' : 'accumulate';
  }
  if (score >= 65 && severeAlerts === 0) {
    return 'study_to_buy';
  }
  if (score >= 50) {
    return 'hold_watch';
  }
  if (score >= 35) {
    return 'avoid_entry';
  }
  return 'consider_reduce';
}

// ─── Copy ────────────────────────────────────────────────────────────────────

function buildHeadline(
  ticker: string,
  stance: GuidanceStance,
  score: number,
  assetType: AssetKind,
  experimental: boolean,
): string {
  const kind = assetType === 'fii' ? 'FII' : 'ação';
  const exp = experimental ? ' (leitura experimental)' : '';
  switch (stance) {
    case 'accumulate':
      return `${ticker} passa no filtro de qualidade com score ${score}/100 — perfil sólido para quem busca ${kind} de fundamentos mais robustos${exp}.`;
    case 'study_to_buy':
      return `${ticker} tem score ${score}/100 e sinais positivos o bastante para entrar na sua lista de estudo antes do primeiro aporte${exp}.`;
    case 'hold_watch':
      return `${ticker} está no meio do caminho (score ${score}/100): não é prioridade para quem está começando, mas pode fazer sentido com critério${exp}.`;
    case 'avoid_entry':
      return `${ticker} mostra fundamentos fracos ou caros demais (score ${score}/100) — evite como primeiro investimento${exp}.`;
    case 'consider_reduce':
      return `${ticker} acumula alertas relevantes (score ${score}/100). Se já tiver, planeje redução; se não tiver, não inicie${exp}.`;
  }
}

function buildWhy(
  stance: GuidanceStance,
  score: number,
  reasons: string[],
  alerts: string[],
  input: GuidanceInput,
): string[] {
  const out: string[] = [];
  out.push(`Score de qualidade ${score}/100 no filtro fundamentalista Urano.`);

  if (reasons.length > 0) {
    out.push(...reasons.slice(0, 3));
  } else if (stance === 'study_to_buy' || stance === 'accumulate') {
    out.push('Indicadores de valuation, rentabilidade e qualidade estão no conjunto mais saudável da amostra.');
  }

  if (stance === 'hold_watch' && alerts[0]) {
    out.push(`Ponto de atenção: ${alerts[0]}`);
  }
  if ((stance === 'avoid_entry' || stance === 'consider_reduce') && alerts.length > 0) {
    out.push(...alerts.slice(0, 2));
  }
  if (input.qualityRating) {
    out.push(`Classificação de qualidade: ${input.qualityRating}.`);
  }
  return uniqNonEmpty(out);
}

function buildRisks(
  stance: GuidanceStance,
  alerts: string[],
  divergences: string[],
  anomalies: number,
  experimental: boolean,
  assetType: AssetKind,
): string[] {
  const risks: string[] = [];
  risks.push(...alerts.slice(0, 3));
  if (divergences.length > 0) {
    risks.push('Indicadores divergem entre fontes — confira o balanço CVM antes de decidir.');
  }
  if (anomalies > 0) {
    risks.push('Há anomalias numéricas (métricas absurdas) — trate os números com cautela.');
  }
  if (experimental) {
    risks.push(
      assetType === 'fii'
        ? 'Score FII ainda não foi validado ponto-no-tempo como o de ações.'
        : 'Leitura experimental — use como triagem, não como sinal de compra/venda.',
    );
  }
  if (stance === 'accumulate' || stance === 'study_to_buy') {
    risks.push('Empresa boa pode estar cara no curto prazo; score alto ≠ retorno garantido.');
  }
  if (risks.length === 0) {
    risks.push('Risco de mercado e de negócio sempre existem, mesmo com fundamentos sólidos.');
  }
  return uniqNonEmpty(risks);
}

function buildHoldingAdvice(
  stance: GuidanceStance,
  assetType: AssetKind,
  experimental: boolean,
): { ifNotHolding: string; ifHolding: string } {
  const fiiNote = experimental
    ? ' Como FII, trate como triagem e leia o informe/CVM.'
    : '';

  switch (stance) {
    case 'accumulate':
      return {
        ifNotHolding: `Pode entrar na shortlist de primeiro aporte se encaixar no seu perfil de risco e diversificação.${fiiNote}`,
        ifHolding: 'Manter e, se houver caixa e o peso na carteira permitir, aportar aos poucos (não de uma vez).',
      };
    case 'study_to_buy':
      return {
        ifNotHolding: `Estude 10–15 minutos (pilares, dívidas, proventos) e só então decida um aporte pequeno de teste.${fiiNote}`,
        ifHolding: 'Manter. Novos aportes só se o peso não ficar concentrado demais.',
      };
    case 'hold_watch':
      return {
        ifNotHolding: 'Não priorize como primeiro investimento — há opções com score e cobertura melhores no ranking.',
        ifHolding: 'Manter com paciência e revisar no próximo balanço. Evite aumentar a posição sem motivo novo.',
      };
    case 'avoid_entry':
      return {
        ifNotHolding: 'Não inicie posição com este papel enquanto o filtro de qualidade estiver fraco.',
        ifHolding: 'Não aumente. Acompanhe resultados e, se a tese original quebrou, planeje saída gradual.',
      };
    case 'consider_reduce':
      return {
        ifNotHolding: 'Não compre. Procure ativos com score mais alto e menos alertas no screener/ranking.',
        ifHolding: 'Considere reduzir exposição (venda parcial) e realocar para nomes com fundamentos mais sólidos.',
      };
  }
}

function buildNextSteps(stance: GuidanceStance, assetType: AssetKind, ticker: string): string[] {
  const steps: string[] = [
    `Leia os pilares e os alertas de ${ticker} nesta página.`,
    'Compare com 2–3 peers do mesmo setor no Comparador.',
  ];
  if (assetType === 'fii') {
    steps.push('Confira P/VP (preferir CVM), vacância e histórico de proventos.');
  } else {
    steps.push('Confira P/L, ROE, dívida e se o lucro tem caixa (FCO).');
  }
  if (stance === 'study_to_buy' || stance === 'accumulate') {
    steps.push('Defina % máximo da carteira (ex.: 3–5% por ativo) antes de comprar.');
    steps.push('Faça o primeiro aporte pequeno e registre a tese no Journal.');
  } else if (stance === 'hold_watch') {
    steps.push('Se for aportar, só com sobra de caixa e após o ranking mostrar opções piores que este.');
  } else {
    steps.push('Use o Ranking/Screener para achar alternativas com score ≥ 65 e menos alertas.');
  }
  return steps;
}

function buildWhenToRevisit(stance: GuidanceStance, assetType: AssetKind): string {
  if (assetType === 'fii') {
    return 'Reavalie após o próximo informe mensal CVM ou mudança grande de vacância/DY.';
  }
  switch (stance) {
    case 'accumulate':
    case 'study_to_buy':
      return 'Reavalie no próximo balanço trimestral ou se o preço disparar (valuation piora).';
    case 'hold_watch':
      return 'Reavalie no próximo resultado trimestral ou se surgir novo alerta de endividamento/prejuízo.';
    case 'avoid_entry':
    case 'consider_reduce':
      return 'Reavalie só se houver melhora clara de lucro, dívida ou cobertura de dados — não por movimento de preço sozinho.';
  }
}

function confidenceNote(
  confidence: GuidanceConfidence,
  coverage: number | null,
  experimental: boolean,
): string {
  const cov = coverage != null ? ` Cobertura de dados: ${coverage}%.` : '';
  if (experimental) {
    return `Confiança ${confidence} — motor experimental.${cov}`;
  }
  if (confidence === 'alta') {
    return `Confiança alta nos dados usados no score.${cov}`;
  }
  if (confidence === 'media') {
    return `Confiança média — alguns campos ou fontes estão incompletos.${cov}`;
  }
  return `Confiança baixa — faltam dados críticos ou há divergências/anomalias.${cov}`;
}

function resolveConfidence(opts: {
  coverage: number | null;
  criticalOk: boolean;
  anomalyCount: number;
  divergenceCount: number;
  experimental: boolean;
}): GuidanceConfidence {
  if (opts.experimental) return 'baixa';
  if (opts.anomalyCount > 0 || !opts.criticalOk || (opts.coverage != null && opts.coverage < 60)) {
    return 'baixa';
  }
  if (opts.divergenceCount > 0 || (opts.coverage != null && opts.coverage < 85)) {
    return 'media';
  }
  return 'alta';
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function uniqNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw?.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
