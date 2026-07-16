/**
 * Mapeamento Explícito de Classificação de FIIs
 * Fonte: StatusInvest + Documentos Oficiais dos Fundos
 *
 * REGRAS:
 * - PAPEL: Investe majoritariamente em CRI, CRA, LCI, títulos de crédito
 * - TIJOLO: Investe em imóveis físicos (logística, shopping, lajes, etc)
 * - HÍBRIDO: Mistura títulos e imóveis físicos
 */

export interface FIIClassification {
  ticker: string;
  type: "papel" | "tijolo" | "hibrido";
  subtype?: string;
  source: "official_docs" | "status_invest" | "inferred";
  confidence: "high" | "medium" | "low";
  last_updated: string;
}

/**
 * Mapeamento explícito e determinístico
 * Atualizado em: 2025-12-29
 */
export const FII_CLASSIFICATION_MAP: Record<string, FIIClassification> = {
  // ========== PAPEL (CRI/CRA/Recebíveis) ==========
  MXRF11: {
    ticker: "MXRF11",
    type: "papel",
    subtype: "cri",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  VGIR11: {
    ticker: "VGIR11",
    type: "papel",
    subtype: "cri_cdi",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  KNCR11: {
    ticker: "KNCR11",
    type: "papel", // ✅ CORREÇÃO: Era 'tijolo', agora está correto
    subtype: "cri",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  BCFF11: {
    ticker: "BCFF11",
    type: "hibrido",
    subtype: "fundo_de_fundos",
    source: "status_invest",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  VCRI11: {
    ticker: "VCRI11",
    type: "papel",
    subtype: "cri",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  RBRF11: {
    ticker: "RBRF11",
    type: "papel",
    subtype: "cri_cra",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  // ========== TIJOLO (Imóveis Físicos) ==========

  // Logística
  HGLG11: {
    ticker: "HGLG11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  LVBI11: {
    ticker: "LVBI11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  RZTR11: {
    ticker: "RZTR11",
    type: "tijolo",
    subtype: "logistica_agro",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  VILG11: {
    ticker: "VILG11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  GALG11: {
    ticker: "GALG11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  // Shopping
  VISC11: {
    ticker: "VISC11",
    type: "tijolo",
    subtype: "shopping",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  XPML11: {
    ticker: "XPML11",
    type: "tijolo",
    subtype: "shopping",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  BRCO11: {
    ticker: "BRCO11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  // Lajes Corporativas
  HGRE11: {
    ticker: "HGRE11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  HGRU11: {
    ticker: "HGRU11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  HGBS11: {
    ticker: "HGBS11",
    type: "tijolo",
    subtype: "shopping",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  CPTS11: {
    ticker: "CPTS11",
    type: "papel",
    subtype: "titulos_e_valores_mobiliarios",
    source: "status_invest",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  // Outros Tijolos
  TRXF11: {
    ticker: "TRXF11",
    type: "tijolo",
    subtype: "residencial",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  BTLG11: {
    ticker: "BTLG11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  KNRI11: {
    ticker: "KNRI11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  PVBI11: {
    ticker: "PVBI11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  RECT11: {
    ticker: "RECT11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  RBVA11: {
    ticker: "RBVA11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  JSRE11: {
    ticker: "JSRE11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  ALZR11: {
    ticker: "ALZR11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  TGAR11: {
    ticker: "TGAR11",
    type: "tijolo",
    subtype: "agronegocio",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  RBRR11: {
    ticker: "RBRR11",
    type: "papel",
    subtype: "titulos_e_valores_mobiliarios",
    source: "status_invest",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  XPLG11: {
    ticker: "XPLG11",
    type: "tijolo",
    subtype: "logistica",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  GGRC11: {
    ticker: "GGRC11",
    type: "tijolo",
    subtype: "lajes_corporativas",
    source: "official_docs",
    confidence: "high",
    last_updated: "2025-12-29",
  },

  // ========== HÍBRIDOS ==========
  // (Adicionar quando identificados)
};

/**
 * Função para obter classificação de um FII
 */
export function getFIIClassification(ticker: string): FIIClassification | null {
  const normalized = ticker.toUpperCase();
  return FII_CLASSIFICATION_MAP[normalized] || null;
}

/**
 * Função para validar se classificação está mapeada
 */
export function isFIIMapped(ticker: string): boolean {
  return ticker.toUpperCase() in FII_CLASSIFICATION_MAP;
}

/**
 * Função para obter estatísticas do mapeamento
 */
export function getClassificationStats() {
  const all = Object.values(FII_CLASSIFICATION_MAP);

  return {
    total: all.length,
    papel: all.filter((f) => f.type === "papel").length,
    tijolo: all.filter((f) => f.type === "tijolo").length,
    hibrido: all.filter((f) => f.type === "hibrido").length,
    highConfidence: all.filter((f) => f.confidence === "high").length,
    lastUpdated: "2025-12-29",
  };
}
