/**
 * Presets de screener para o investidor mediano / primeiro aporte.
 * Valores viram query params da rota /market/screener.
 */

export type ScreenerPresetId =
  | "first_conservative"
  | "quality_value"
  | "dividend_focus"
  | "fii_income"
  | "fii_brick_quality"
  | "clear";

export type ScreenerSearchShape = {
  type: "stock" | "fii";
  sector?: string;
  peMin?: string;
  peMax?: string;
  pvpMin?: string;
  pvpMax?: string;
  roeMin?: string;
  roeMax?: string;
  dyMin?: string;
  dyMax?: string;
  marketCapMin?: string;
  marketCapMax?: string;
  liquidityMin?: string;
  scoreMin?: string;
  scoreMax?: string;
  vacancyMax?: string;
  classification?: string;
  sortBy?: string;
  order?: "asc" | "desc";
};

export type ScreenerPreset = {
  id: ScreenerPresetId;
  label: string;
  description: string;
  /** Perfil de risco sugerido no aporte (opcional). */
  suggestProfile?: "conservador" | "moderado" | "agressivo";
  search: ScreenerSearchShape;
};

export const SCREENER_PRESETS: ScreenerPreset[] = [
  {
    id: "first_conservative",
    label: "Primeiro aporte",
    description: "Score alto, liquidez, sem caçar pechincha extrema — bom ponto de partida.",
    suggestProfile: "conservador",
    search: {
      type: "stock",
      scoreMin: "70",
      peMax: "25",
      roeMin: "12",
      liquidityMin: "2000000",
      sortBy: "score",
      order: "desc",
    },
  },
  {
    id: "quality_value",
    label: "Qualidade com preço",
    description: "P/L e P/VP moderados + ROE — filtro clássico de value com qualidade.",
    suggestProfile: "moderado",
    search: {
      type: "stock",
      scoreMin: "60",
      peMax: "15",
      pvpMax: "2.5",
      roeMin: "15",
      liquidityMin: "1000000",
      sortBy: "score",
      order: "desc",
    },
  },
  {
    id: "dividend_focus",
    label: "Renda (ações)",
    description: "DY atrativo com score mínimo — triagem, não garantia de provento futuro.",
    suggestProfile: "moderado",
    search: {
      type: "stock",
      scoreMin: "55",
      dyMin: "5",
      peMax: "20",
      liquidityMin: "1000000",
      sortBy: "score",
      order: "desc",
    },
  },
  {
    id: "fii_income",
    label: "FII renda",
    description: "FIIs com DY e P/VP razoáveis + score experimental.",
    suggestProfile: "moderado",
    search: {
      type: "fii",
      scoreMin: "55",
      dyMin: "8",
      pvpMax: "1.15",
      liquidityMin: "500000",
      sortBy: "score",
      order: "desc",
    },
  },
  {
    id: "fii_brick_quality",
    label: "FII tijolo",
    description: "Tijolo, vacância controlada (se houver cache), score e P/VP.",
    suggestProfile: "conservador",
    search: {
      type: "fii",
      classification: "tijolo",
      scoreMin: "60",
      pvpMax: "1.1",
      vacancyMax: "12",
      liquidityMin: "300000",
      sortBy: "score",
      order: "desc",
    },
  },
];

/** Defaults limpos da rota (sem filtros). */
export const SCREENER_CLEAR: ScreenerSearchShape = {
  type: "stock",
  sector: "",
  peMin: "",
  peMax: "",
  pvpMin: "",
  pvpMax: "",
  roeMin: "",
  roeMax: "",
  dyMin: "",
  dyMax: "",
  marketCapMin: "",
  marketCapMax: "",
  liquidityMin: "",
  scoreMin: "",
  scoreMax: "",
  vacancyMax: "",
  classification: "",
  sortBy: "score",
  order: "desc",
};

/** Mescla preset em cima do clear (evita lixo de filtros anteriores). */
export function applyScreenerPreset(preset: ScreenerPreset): ScreenerSearchShape {
  return {
    ...SCREENER_CLEAR,
    ...preset.search,
    type: preset.search.type,
  };
}
