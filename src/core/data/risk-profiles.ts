/** Perfis de risco compartilhados por AllocationEngine e ContributionAdvisor. */

export type RiskProfile = 'conservador' | 'moderado' | 'agressivo';

export interface RiskProfileConfig {
  stockPercent: number;
  fiiPercent: number;
  minScore: number;
  maxAssets: number;
}

export const RISK_CONFIGS: Record<RiskProfile, RiskProfileConfig> = {
  conservador: { stockPercent: 30, fiiPercent: 70, minScore: 65, maxAssets: 5 },
  moderado: { stockPercent: 50, fiiPercent: 50, minScore: 55, maxAssets: 8 },
  agressivo: { stockPercent: 70, fiiPercent: 30, minScore: 45, maxAssets: 12 },
};
