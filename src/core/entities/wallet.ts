import type { AssetRebalanceRecommendation } from './asset.ts';

export interface Wallet {
  id: string;
  ownerId: string;
  createdAt: Date;
}

export interface RebalanceResult {
  walletId: string;
  availableAmount: number;
  totalEstimatedCost: number;
  remainingCash: number;
  executedAt: Date;
  recommendations: AssetRebalanceRecommendation[];
}
