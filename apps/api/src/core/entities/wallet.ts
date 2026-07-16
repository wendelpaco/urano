import type { AssetRebalanceRecommendation } from './asset.ts';

export interface Wallet {
  id: string;
  ownerId: string;
  createdAt: Date;
}

export interface RebalanceResult {
  walletId: string;
  /** O endpoint permanece buy-only enquanto o motor completo não for validado. */
  mode: 'BUY_ONLY';
  availableAmount: number;
  currentPortfolioValue: number;
  targetPortfolioValue: number;
  totalEstimatedCost: number;
  remainingCash: number;
  executedAt: Date;
  recommendations: AssetRebalanceRecommendation[];
}
