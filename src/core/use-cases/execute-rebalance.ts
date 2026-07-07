import type { RebalanceResult } from '../entities/wallet.ts';
import type { AssetRebalanceRecommendation } from '../entities/asset.ts';

export interface ExecuteRebalanceInput {
  walletId: string;
  availableAmount: number;
}

export class ExecuteRebalanceUseCase {
  /**
   * Executa o rebalanceamento da carteira com base no aporte disponível.
   *
   * Neste MVP, retorna um mock estruturado simulando recomendações de compra/venda.
   * Futuramente, integrará com serviços de cotação em tempo real e cálculo real de alocações.
   */
  execute(input: ExecuteRebalanceInput): RebalanceResult {
    const { walletId, availableAmount } = input;

    const mockRecommendations: AssetRebalanceRecommendation[] = [
      {
        ticker: 'PETR4',
        currentQuantity: 100,
        currentPrice: 36.42,
        targetAllocationPercent: 25,
        suggestedAction: 'BUY',
        suggestedQuantity: 37,
        estimatedCost: 1347.54,
      },
      {
        ticker: 'VALE3',
        currentQuantity: 50,
        currentPrice: 68.15,
        targetAllocationPercent: 20,
        suggestedAction: 'BUY',
        suggestedQuantity: 10,
        estimatedCost: 681.5,
      },
      {
        ticker: 'ITUB4',
        currentQuantity: 200,
        currentPrice: 32.8,
        targetAllocationPercent: 30,
        suggestedAction: 'BUY',
        suggestedQuantity: 27,
        estimatedCost: 885.6,
      },
      {
        ticker: 'WEGE3',
        currentQuantity: 80,
        currentPrice: 38.9,
        targetAllocationPercent: 15,
        suggestedAction: 'HOLD',
        suggestedQuantity: 0,
        estimatedCost: 0,
      },
      {
        ticker: 'BBDC4',
        currentQuantity: 150,
        currentPrice: 14.56,
        targetAllocationPercent: 10,
        suggestedAction: 'SELL',
        suggestedQuantity: 15,
        estimatedCost: -218.4,
      },
    ];

    const totalEstimatedCost = mockRecommendations.reduce(
      (sum, r) => sum + r.estimatedCost,
      0,
    );
    const remainingCash = availableAmount - totalEstimatedCost;

    return {
      walletId,
      availableAmount,
      totalEstimatedCost,
      remainingCash: Math.round(remainingCash * 100) / 100,
      executedAt: new Date(),
      recommendations: mockRecommendations,
    };
  }
}
