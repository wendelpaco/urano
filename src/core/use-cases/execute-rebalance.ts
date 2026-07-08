import type { RebalanceResult } from '../entities/wallet.ts';
import type { AssetRebalanceRecommendation } from '../entities/asset.ts';
import { db } from '../../infra/database/connection.ts';
import { wallets, walletAssets, companies } from '../../infra/database/schema.ts';
import { eq } from 'drizzle-orm';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';

export interface ExecuteRebalanceInput {
  walletId: string;
  availableAmount: number;
  currentPositions?: Array<{ ticker: string; quantity: number }>;
}

export class ExecuteRebalanceUseCase {
  /**
   * Executa rebalanceamento REAL da carteira:
   *  1. Lê os ativos e metas de alocação do banco
   *  2. Busca cotações em tempo real (com cache Redis)
   *  3. Calcula quantas unidades de cada ativo comprar com base no aporte
   */
  async execute(input: ExecuteRebalanceInput): Promise<RebalanceResult> {
    const { walletId, availableAmount } = input;

    // 1. Busca a carteira e seus ativos-alvo
    const [wallet] = await db
      .select({ id: wallets.id, name: wallets.name })
      .from(wallets)
      .where(eq(wallets.id, walletId));

    if (!wallet) {
      throw new Error(`Carteira ${walletId} não encontrada`);
    }

    const assets = await db
      .select({
        ticker: walletAssets.ticker,
        targetPercent: walletAssets.targetAllocationPercent,
      })
      .from(walletAssets)
      .where(eq(walletAssets.walletId, walletId));

    if (assets.length === 0) {
      throw new Error('Carteira não possui ativos configurados');
    }

    // 2. Busca cotações em tempo real
    const tickers = assets.map((a) => a.ticker);
    const quotes = await stockQuoteService.getQuotes(tickers);

    // 3. Calcula alocação
    const recommendations: AssetRebalanceRecommendation[] = [];
    let totalEstimatedCost = 0;

    for (const asset of assets) {
      const targetPercent = Number(asset.targetPercent);
      const quote = quotes.get(asset.ticker);
      const currentPrice = quote?.price ?? 0;

      // Valor a alocar neste ativo = availableAmount * targetPercent
      const targetValue = availableAmount * (targetPercent / 100);

      // Quantidade de ações a comprar (arredondado para baixo, lote padrão)
      const suggestedQuantity = currentPrice > 0
        ? Math.floor(targetValue / currentPrice)
        : 0;

      const estimatedCost = suggestedQuantity * currentPrice;

      // Onda 3b: posição atual do usuário (se informada)
      const position = input.currentPositions?.find(
        (p: { ticker: string; quantity: number }) => p.ticker.toUpperCase() === asset.ticker.toUpperCase(),
      );
      const currentQty = position?.quantity ?? 0;

      // Determina ação: BUY, SELL, ou HOLD
      let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let finalQuantity = suggestedQuantity;
      let finalCost = estimatedCost;

      if (currentQty > 0 && currentPrice > 0) {
        // Calcula alocação atual em valor
        const currentValue = currentQty * currentPrice;

        // Se a alocação atual excede a alvo em mais de 20%, sugere SELL
        if (currentValue > targetValue * 1.2) {
          const excessValue = currentValue - targetValue;
          const sellQty = Math.floor(excessValue / currentPrice);
          if (sellQty > 0) {
            action = 'SELL';
            finalQuantity = sellQty;
            finalCost = sellQty * currentPrice;
          }
        } else if (suggestedQuantity > 0) {
          action = 'BUY';
        }
      } else if (suggestedQuantity > 0) {
        action = 'BUY';
      }

      recommendations.push({
        ticker: asset.ticker,
        currentQuantity: currentQty,
        currentPrice: Math.round(currentPrice * 100) / 100,
        targetAllocationPercent: targetPercent,
        suggestedAction: action,
        suggestedQuantity: finalQuantity,
        estimatedCost: Math.round(finalCost * 100) / 100,
      });

      totalEstimatedCost += finalCost;
    }

    const remainingCash = Math.round((availableAmount - totalEstimatedCost) * 100) / 100;

    return {
      walletId,
      availableAmount,
      totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100,
      remainingCash,
      executedAt: new Date(),
      recommendations,
    };
  }
}
