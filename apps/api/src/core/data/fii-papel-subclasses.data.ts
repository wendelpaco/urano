/**
 * Subclassificação de FIIs de Papel com Faixas de DY Normalizado
 *
 * OBJETIVO:
 * - Evitar convergência artificial de DY normalizado (~12%)
 * - Preservar granularidade entre FIIs de papel diferentes
 * - Mapear risco de crédito/estrutura de forma determinística
 *
 * FAIXAS DE DY NORMALIZADO POR SUBCLASSE:
 * - high_grade: 9.0% - 11.0% (CRI/CRA de baixíssimo risco, mais sensíveis a CDI)
 * - middle_risk: 10.0% - 12.0% (CRI/CRA com risco moderado de crédito)
 * - high_yield: 11.0% - 13.0% (CRI estruturados, high yield, risco elevado)
 */

export type PapelSubclass =
  | 'high_grade'
  | 'middle_risk'
  | 'high_yield'
  | 'cdi_high_grade_juros_sensitive';

export interface PapelSubclassification {
  ticker: string;
  subclass: PapelSubclass;
  dy_min: number; // DY normalizado mínimo permitido
  dy_max: number; // DY normalizado máximo permitido
  risco_credito: 'baixo' | 'medio' | 'alto';
  risco_juros: 'baixo' | 'medio' | 'alto'; // Sensibilidade à variação da Selic
  limitador_esperado: 'risco_credito' | 'risco_juros' | 'risco_estrutura';
  justificativa: string;
  last_updated: string;
}

/**
 * Mapeamento determinístico de subclasses de FIIs de papel
 * Baseado em análise de estrutura, qualidade de crédito e sensibilidade a juros
 */
export const PAPEL_SUBCLASS_MAP: Record<string, PapelSubclassification> = {
  // ========== HIGH GRADE (DY: 9.0% - 11.0%) ==========
  // FIIs com CRI/CRA de altíssima qualidade, menor risco de crédito
  // Mais sensíveis a variações do CDI/Selic

  VGIR11: {
    ticker: 'VGIR11',
    subclass: 'high_grade',
    dy_min: 9.0,
    dy_max: 11.0,
    risco_credito: 'baixo',
    risco_juros: 'alto', // CRI indexado a CDI, alta sensibilidade
    limitador_esperado: 'risco_juros',
    justificativa:
      'CRI de alta qualidade indexado a CDI. DY elevado reflete apenas CDI alto, não risco de crédito.',
    last_updated: '2025-12-29',
  },

  VCRI11: {
    ticker: 'VCRI11',
    subclass: 'high_grade',
    dy_min: 9.0,
    dy_max: 11.0,
    risco_credito: 'baixo',
    risco_juros: 'alto',
    limitador_esperado: 'risco_juros',
    justificativa: 'Valora CRI com carteira diversificada e baixo risco de crédito.',
    last_updated: '2025-12-29',
  },

  // ========== MIDDLE RISK (DY: 10.0% - 12.0%) ==========
  // FIIs com CRI/CRA de qualidade boa, risco moderado de crédito
  // Balanço entre risco de crédito e sensibilidade a juros

  MXRF11: {
    ticker: 'MXRF11',
    subclass: 'middle_risk',
    dy_min: 10.0,
    dy_max: 12.0,
    risco_credito: 'medio',
    risco_juros: 'medio',
    limitador_esperado: 'risco_credito',
    justificativa:
      'Maxi Renda com CRI diversificados. Risco de crédito moderado devido a exposição a diferentes setores.',
    last_updated: '2025-12-29',
  },

  KNCR11: {
    ticker: 'KNCR11',
    subclass: 'cdi_high_grade_juros_sensitive',
    dy_min: 8.5,
    dy_max: 10.5,
    risco_credito: 'baixo',
    risco_juros: 'alto',
    limitador_esperado: 'risco_juros',
    justificativa:
      'Fundo CRI high-grade extremamente pulverizado. Risco dominante: queda do CDI e compressão de spread.',
    last_updated: '2025-12-29',
  },

  RBRF11: {
    ticker: 'RBRF11',
    subclass: 'middle_risk',
    dy_min: 10.0,
    dy_max: 12.0,
    risco_credito: 'medio',
    risco_juros: 'medio',
    limitador_esperado: 'risco_credito',
    justificativa: 'RB Capital com mix de CRI/CRA. Diversificação setorial com risco moderado.',
    last_updated: '2025-12-29',
  },

  // ========== HIGH YIELD (DY: 11.0% - 13.0%) ==========
  // FIIs com CRI estruturados, maior risco de crédito ou complexidade
  // DY elevado compensa risco real (não apenas CDI)

  // Placeholder para FIIs high yield quando identificados
  // Ex: CRI de desenvolvimento imobiliário, crédito pulverizado de maior risco, etc.
};

/**
 * Obter subclassificação de um FII de papel
 */
export function getPapelSubclass(ticker: string): PapelSubclassification | null {
  const normalized = ticker.toUpperCase();
  return PAPEL_SUBCLASS_MAP[normalized] || null;
}

/**
 * Verificar se FII de papel está mapeado em subclasse
 */
export function isPapelSubclassMapped(ticker: string): boolean {
  return ticker.toUpperCase() in PAPEL_SUBCLASS_MAP;
}

/**
 * Obter estatísticas das subclasses
 */
export function getPapelSubclassStats() {
  const all = Object.values(PAPEL_SUBCLASS_MAP);

  return {
    total: all.length,
    high_grade: all.filter((f) => f.subclass === 'high_grade').length,
    middle_risk: all.filter((f) => f.subclass === 'middle_risk').length,
    high_yield: all.filter((f) => f.subclass === 'high_yield').length,
    lastUpdated: '2025-12-29',
  };
}

/**
 * Normalizar DY com base na subclasse
 *
 * Aplica clamp dinâmico baseado na faixa permitida para cada subclasse
 */
export function normalizeDYBySubclass(
  ticker: string,
  dyBruto: number
): {
  dy_normalizado: number;
  subclass: PapelSubclass | null;
  applied: boolean;
  reason: string;
} {
  const subclass = getPapelSubclass(ticker);

  // Se não tem subclasse mapeada, não normaliza
  if (!subclass) {
    return {
      dy_normalizado: dyBruto,
      subclass: null,
      applied: false,
      reason: 'FII de papel sem subclasse mapeada - usando DY bruto',
    };
  }

  // Clamp DY dentro da faixa permitida
  const dyNormalizado = Math.max(subclass.dy_min, Math.min(dyBruto, subclass.dy_max));

  const applied = dyNormalizado !== dyBruto;

  let reason = '';
  if (applied) {
    if (dyNormalizado < dyBruto) {
      reason = `DY ajustado de ${dyBruto.toFixed(2)}% para ${dyNormalizado.toFixed(2)}% (limite máximo ${subclass.subclass}: ${subclass.dy_max}%)`;
    } else {
      reason = `DY ajustado de ${dyBruto.toFixed(2)}% para ${dyNormalizado.toFixed(2)}% (limite mínimo ${subclass.subclass}: ${subclass.dy_min}%)`;
    }
  } else {
    reason = `DY ${dyBruto.toFixed(2)}% dentro da faixa ${subclass.subclass} (${subclass.dy_min}%-${subclass.dy_max}%)`;
  }

  return {
    dy_normalizado: dyNormalizado,
    subclass: subclass.subclass,
    applied,
    reason,
  };
}
