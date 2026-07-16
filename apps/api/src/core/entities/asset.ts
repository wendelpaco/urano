export interface AssetRebalanceRecommendation {
  ticker: string;
  currentQuantity: number;
  currentPrice: number;
  targetAllocationPercent: number;
  /** Sprint 1 containment: rebalanceamento opera somente com compras. */
  suggestedAction: 'BUY' | 'HOLD';
  suggestedQuantity: number;
  estimatedCost: number;
}
