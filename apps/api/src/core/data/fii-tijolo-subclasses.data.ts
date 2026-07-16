/**
 * Subclassificação de FIIs de Tijolo
 *
 * OBJETIVO V4.1:
 * - Enriquecer análise de FIIs de tijolo com subclasses determinísticas
 * - Influenciar: risco_macro, risco_ciclo, explanation_short
 * - NÃO alterar DY diretamente
 * - Ajuste fino de score: máximo +/-2 pontos
 *
 * SUBCLASSES:
 * - shopping_prime_ciclico: Shoppings de qualidade em localizações prime, expostos a ciclos de consumo
 * - logistica_defensiva: Galpões logísticos com contratos longos, menor sensibilidade a ciclos
 * - lajes_corporativas_volatil: Lajes em centros urbanos, alta volatilidade de demanda
 * - hibrido_diversificado: Múltiplos segmentos, risco diluído
 */

export type TijoloSubclass =
  | 'shopping_prime_ciclico'
  | 'logistica_defensiva'
  | 'lajes_corporativas_volatil'
  | 'hibrido_diversificado';

export interface TijoloSubclassification {
  ticker: string;
  subclass: TijoloSubclass;
  risco_macro: 'baixo' | 'medio' | 'alto'; // Sensibilidade a ciclos econômicos
  risco_ciclo: 'baixo' | 'medio' | 'alto'; // Volatilidade de demanda
  score_adjustment: number; // Ajuste fino: -2 a +2
  adjustment_reason: string; // Justificativa do ajuste
  justificativa: string;
  last_updated: string;
}

/**
 * Mapeamento determinístico de subclasses de FIIs de tijolo
 */
export const TIJOLO_SUBCLASS_MAP: Record<string, TijoloSubclassification> = {
  // ========== SHOPPING - PRIME CÍCLICO ==========

  XPML11: {
    ticker: 'XPML11',
    subclass: 'shopping_prime_ciclico',
    risco_macro: 'medio',
    risco_ciclo: 'alto',
    score_adjustment: +1,
    adjustment_reason: 'Localização prime compensa exposição a ciclo de consumo',
    justificativa:
      'Shopping prime bem localizado, porém exposto a ciclos de consumo e mudanças no varejo.',
    last_updated: '2025-12-29',
  },

  VISC11: {
    ticker: 'VISC11',
    subclass: 'shopping_prime_ciclico',
    risco_macro: 'medio',
    risco_ciclo: 'alto',
    score_adjustment: 0,
    adjustment_reason: 'Equilíbrio entre qualidade e risco cíclico',
    justificativa: 'Portfólio de shoppings com boa qualidade, mas sensível a variações no consumo.',
    last_updated: '2025-12-29',
  },

  BRCO11: {
    ticker: 'BRCO11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Portfólio logístico com contratos de prazo longo',
    justificativa: 'Galpões logísticos; não é fundo de shopping.',
    last_updated: '2025-12-29',
  },

  // ========== LOGÍSTICA - DEFENSIVA ==========

  RZTR11: {
    ticker: 'RZTR11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +2,
    adjustment_reason: 'Contratos longos (WAULT) + setor defensivo (agro/logística)',
    justificativa:
      'Galpões logísticos com contratos longos e inquilinos do setor agrícola (defensivo).',
    last_updated: '2025-12-29',
  },

  HGLG11: {
    ticker: 'HGLG11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +2,
    adjustment_reason: 'Alta qualidade, contratos estruturados, baixa vacância histórica',
    justificativa: 'Portfólio logístico de alta qualidade com inquilinos sólidos.',
    last_updated: '2025-12-29',
  },

  LVBI11: {
    ticker: 'LVBI11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Setor defensivo com demanda estrutural',
    justificativa: 'Logística com demanda estrutural do e-commerce e distribuição.',
    last_updated: '2025-12-29',
  },

  VILG11: {
    ticker: 'VILG11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Diversificação geográfica + setor defensivo',
    justificativa: 'Portfólio logístico diversificado geograficamente.',
    last_updated: '2025-12-29',
  },

  GALG11: {
    ticker: 'GALG11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Exposição ao agronegócio (defensivo)',
    justificativa: 'Foco em logística para agronegócio, setor estruturalmente forte.',
    last_updated: '2025-12-29',
  },

  BTLG11: {
    ticker: 'BTLG11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Gestão BTG + contratos estruturados',
    justificativa: 'Gestão institucional com contratos bem estruturados.',
    last_updated: '2025-12-29',
  },

  PVBI11: {
    ticker: 'PVBI11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Portfólio focado em logística last-mile',
    justificativa: 'Foco em logística last-mile, segmento em crescimento estrutural.',
    last_updated: '2025-12-29',
  },

  ALZR11: {
    ticker: 'ALZR11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Setor logístico com demanda estrutural',
    justificativa: 'Portfólio logístico com inquilinos diversificados.',
    last_updated: '2025-12-29',
  },

  XPLG11: {
    ticker: 'XPLG11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Exposição a logística moderna',
    justificativa: 'Galpões logísticos modernos com boa localização.',
    last_updated: '2025-12-29',
  },

  // ========== LAJES CORPORATIVAS - VOLÁTIL ==========

  HGRE11: {
    ticker: 'HGRE11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Alta exposição a ciclos corporativos e trabalho híbrido',
    justificativa: 'Lajes corporativas com risco de vacância em cenário de trabalho remoto.',
    last_updated: '2025-12-29',
  },

  HGRU11: {
    ticker: 'HGRU11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Segmento sob pressão estrutural (home office)',
    justificativa: 'Lajes corporativas enfrentando mudanças estruturais no modelo de trabalho.',
    last_updated: '2025-12-29',
  },

  HGBS11: {
    ticker: 'HGBS11',
    subclass: 'shopping_prime_ciclico',
    risco_macro: 'medio',
    risco_ciclo: 'alto',
    score_adjustment: 0,
    adjustment_reason: 'Exposição ao ciclo de consumo em shopping centers',
    justificativa: 'Portfólio de shopping centers; não é fundo de lajes.',
    last_updated: '2025-12-29',
  },

  KNRI11: {
    ticker: 'KNRI11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Segmento corporativo volátil',
    justificativa: 'Lajes corporativas com risco de vacância elevado.',
    last_updated: '2025-12-29',
  },

  RECT11: {
    ticker: 'RECT11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Ciclo corporativo incerto',
    justificativa: 'Exposição a lajes corporativas em momento de transformação do setor.',
    last_updated: '2025-12-29',
  },

  RBVA11: {
    ticker: 'RBVA11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Risco de modelo híbrido afetar ocupação',
    justificativa: 'Lajes corporativas sob pressão de novos modelos de trabalho.',
    last_updated: '2025-12-29',
  },

  JSRE11: {
    ticker: 'JSRE11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Volatilidade do setor corporativo',
    justificativa: 'Portfólio corporativo exposto a mudanças estruturais.',
    last_updated: '2025-12-29',
  },

  GGRC11: {
    ticker: 'GGRC11',
    subclass: 'lajes_corporativas_volatil',
    risco_macro: 'alto',
    risco_ciclo: 'alto',
    score_adjustment: -1,
    adjustment_reason: 'Exposição a ciclos de demanda corporativa',
    justificativa: 'Lajes corporativas sujeitas a volatilidade econômica.',
    last_updated: '2025-12-29',
  },

  // ========== OUTROS ==========

  TRXF11: {
    ticker: 'TRXF11',
    subclass: 'hibrido_diversificado',
    risco_macro: 'medio',
    risco_ciclo: 'medio',
    score_adjustment: 0,
    adjustment_reason: 'Diversificação reduz risco concentrado',
    justificativa: 'Portfólio residencial com diversificação regional.',
    last_updated: '2025-12-29',
  },

  TGAR11: {
    ticker: 'TGAR11',
    subclass: 'logistica_defensiva',
    risco_macro: 'baixo',
    risco_ciclo: 'baixo',
    score_adjustment: +1,
    adjustment_reason: 'Exposição ao agronegócio',
    justificativa: 'Armazéns agrícolas com demanda estrutural forte.',
    last_updated: '2025-12-29',
  },
};

/**
 * Obter subclassificação de um FII de tijolo
 */
export function getTijoloSubclass(ticker: string): TijoloSubclassification | null {
  const normalized = ticker.toUpperCase();
  return TIJOLO_SUBCLASS_MAP[normalized] || null;
}

/**
 * Verificar se FII de tijolo está mapeado
 */
export function isTijoloSubclassMapped(ticker: string): boolean {
  return ticker.toUpperCase() in TIJOLO_SUBCLASS_MAP;
}

/**
 * Obter estatísticas das subclasses
 */
export function getTijoloSubclassStats() {
  const all = Object.values(TIJOLO_SUBCLASS_MAP);

  return {
    total: all.length,
    shopping_prime_ciclico: all.filter((f) => f.subclass === 'shopping_prime_ciclico').length,
    logistica_defensiva: all.filter((f) => f.subclass === 'logistica_defensiva').length,
    lajes_corporativas_volatil: all.filter((f) => f.subclass === 'lajes_corporativas_volatil')
      .length,
    hibrido_diversificado: all.filter((f) => f.subclass === 'hibrido_diversificado').length,
    lastUpdated: '2025-12-29',
  };
}
