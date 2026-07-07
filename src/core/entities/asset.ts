export interface AssetRebalanceRecommendation {
  ticker: string;
  currentQuantity: number;
  currentPrice: number;
  targetAllocationPercent: number;
  suggestedAction: 'BUY' | 'SELL' | 'HOLD';
  suggestedQuantity: number;
  estimatedCost: number;
}
