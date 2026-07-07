import type { RebalanceResult } from '../entities/wallet.ts';
import type { AssetRebalanceRecommendation } from '../entities/asset.ts';
import { db } from '../../infra/database/connection.ts';
import { wallets, walletAssets, companies } from '../../infra/database/schema.ts';
import { eq } from 'drizzle-orm';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';

export interface ExecuteRebalanceInput {
  walletId: string;
  availableAmount: number;
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

      recommendations.push({
        ticker: asset.ticker,
        currentQuantity: 0, // MVP: não rastreamos posição atual
        currentPrice: Math.round(currentPrice * 100) / 100,
        targetAllocationPercent: targetPercent,
        suggestedAction: suggestedQuantity > 0 ? 'BUY' : 'HOLD',
        suggestedQuantity,
        estimatedCost: Math.round(estimatedCost * 100) / 100,
      });

      totalEstimatedCost += estimatedCost;
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
