import type { RebalanceResult } from '../entities/wallet.ts';
import type { AssetRebalanceRecommendation } from '../entities/asset.ts';
import { db } from '../../infra/database/connection.ts';
import { wallets, walletAssets } from '../../infra/database/schema.ts';
import { eq } from 'drizzle-orm';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';

export interface ExecuteRebalanceInput {
  walletId: string;
  availableAmount: number;
  currentPositions?: Array<{ ticker: string; quantity: number }>;
}

export interface RebalanceTarget {
  ticker: string;
  targetPercent: number;
}

export interface BuyOnlyRebalanceCalculation {
  recommendations: AssetRebalanceRecommendation[];
  currentPortfolioValue: number;
  targetPortfolioValue: number;
  totalEstimatedCost: number;
  remainingCash: number;
}

export class RebalanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebalanceValidationError';
  }
}

/** Limites de contenção também usados pela validação HTTP. */
export const MAX_REBALANCE_AMOUNT = 100_000_000;
export const MAX_REBALANCE_POSITION_QUANTITY = 1_000_000_000;
export const MAX_REBALANCE_POSITIONS = 100;
export const MAX_REBALANCE_TARGETS = 100;

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

export function validateRebalanceRequest(
  availableAmount: number,
  currentPositions: Array<{ ticker: string; quantity: number }>,
): Array<{ ticker: string; quantity: number }> {
  if (
    !Number.isFinite(availableAmount)
    || availableAmount <= 0
    || availableAmount > MAX_REBALANCE_AMOUNT
  ) {
    throw new RebalanceValidationError(
      `Valor disponivel deve ser finito, positivo e no maximo ${MAX_REBALANCE_AMOUNT}.`,
    );
  }
  if (!Array.isArray(currentPositions) || currentPositions.length > MAX_REBALANCE_POSITIONS) {
    throw new RebalanceValidationError(
      `No maximo ${MAX_REBALANCE_POSITIONS} posicoes atuais podem ser informadas.`,
    );
  }

  return currentPositions.map((position) => {
    const ticker = typeof position?.ticker === 'string'
      ? position.ticker.trim().toUpperCase()
      : '';
    const quantity = typeof position?.quantity === 'number'
      ? position.quantity
      : Number.NaN;
    if (!/^[A-Z0-9]{4,10}$/.test(ticker)) {
      throw new RebalanceValidationError(`Ticker invalido: ${ticker || 'vazio'}.`);
    }
    if (
      !Number.isFinite(quantity)
      || quantity < 0
      || quantity > MAX_REBALANCE_POSITION_QUANTITY
    ) {
      throw new RebalanceValidationError(`Quantidade invalida para ${ticker}.`);
    }
    return { ticker, quantity };
  });
}

export function validateRebalanceTargets(
  targets: RebalanceTarget[],
): RebalanceTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new RebalanceValidationError('Carteira nao possui ativos configurados.');
  }
  if (targets.length > MAX_REBALANCE_TARGETS) {
    throw new RebalanceValidationError(
      `Carteira excede o limite de ${MAX_REBALANCE_TARGETS} ativos-alvo.`,
    );
  }

  const normalizedTargets = targets.map((target) => ({
    ticker: typeof target?.ticker === 'string'
      ? target.ticker.trim().toUpperCase()
      : '',
    targetPercent: Number(target?.targetPercent),
  }));
  if (
    normalizedTargets.some((target) => !/^[A-Z0-9]{4,10}$/.test(target.ticker))
  ) {
    throw new RebalanceValidationError('Carteira possui ticker-alvo invalido.');
  }
  if (new Set(normalizedTargets.map((target) => target.ticker)).size !== normalizedTargets.length) {
    throw new RebalanceValidationError('Carteira possui ticker duplicado nas metas de alocacao.');
  }

  const totalTargetPercent = normalizedTargets.reduce(
    (sum, target) => sum + target.targetPercent,
    0,
  );
  if (
    normalizedTargets.some(
      (target) =>
        !Number.isFinite(target.targetPercent)
        || target.targetPercent < 0
        || target.targetPercent > 100,
    )
    || !Number.isFinite(totalTargetPercent)
    || Math.abs(totalTargetPercent - 100) > 0.01
  ) {
    throw new RebalanceValidationError(
      `Metas de alocacao devem ser validas e somar 100% (recebido: ${totalTargetPercent}).`,
    );
  }

  return normalizedTargets;
}

/**
 * Calcula um aporte buy-only sobre o patrimonio final (posicoes atuais + caixa).
 *
 * Ativos acima do alvo nunca geram venda: ficam em HOLD. Quando a soma dos
 * deficits supera o caixa disponivel, todos os deficits sao reduzidos pela
 * mesma proporcao antes do arredondamento para unidades inteiras.
 */
export function calculateBuyOnlyRebalance(
  targets: RebalanceTarget[],
  availableAmount: number,
  currentPositions: Array<{ ticker: string; quantity: number }>,
  prices: ReadonlyMap<string, number>,
): BuyOnlyRebalanceCalculation {
  const normalizedPositions = validateRebalanceRequest(availableAmount, currentPositions);
  const normalizedTargets = validateRebalanceTargets(targets);

  const quantities = new Map<string, number>();
  for (const position of normalizedPositions) {
    const ticker = position.ticker;
    quantities.set(ticker, (quantities.get(ticker) ?? 0) + position.quantity);
  }

  const readPrice = (ticker: string): number => {
    const price = prices.get(ticker);
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new RebalanceValidationError(`Cotacao indisponivel para ${ticker}.`);
    }
    return price;
  };

  let currentPortfolioValue = 0;
  for (const [ticker, quantity] of quantities) {
    if (quantity === 0) continue;
    currentPortfolioValue += quantity * readPrice(ticker);
  }

  const targetPortfolioValue = currentPortfolioValue + availableAmount;
  const deficits = normalizedTargets.map((target) => {
    const price = readPrice(target.ticker);
    const currentQuantity = quantities.get(target.ticker) ?? 0;
    const currentValue = currentQuantity * price;
    const targetValue = targetPortfolioValue * (target.targetPercent / 100);
    return {
      ...target,
      price,
      currentQuantity,
      deficit: Math.max(0, targetValue - currentValue),
    };
  });

  const totalDeficit = deficits.reduce((sum, item) => sum + item.deficit, 0);
  const scale = totalDeficit > availableAmount && totalDeficit > 0
    ? availableAmount / totalDeficit
    : 1;

  const recommendations = deficits.map((item): AssetRebalanceRecommendation => {
    const buyBudget = item.deficit * scale;
    const suggestedQuantity = Math.max(0, Math.floor(buyBudget / item.price));
    const estimatedCost = roundMoney(suggestedQuantity * item.price);

    return {
      ticker: item.ticker,
      currentQuantity: item.currentQuantity,
      currentPrice: roundMoney(item.price),
      targetAllocationPercent: item.targetPercent,
      suggestedAction: suggestedQuantity > 0 ? 'BUY' : 'HOLD',
      suggestedQuantity,
      estimatedCost,
    };
  });

  const totalEstimatedCost = roundMoney(
    recommendations.reduce((sum, item) => sum + item.estimatedCost, 0),
  );
  const remainingCash = roundMoney(availableAmount - totalEstimatedCost);

  if (totalEstimatedCost > availableAmount + 0.01 || remainingCash < -0.01) {
    throw new RebalanceValidationError('Calculo de aporte excedeu o caixa disponivel.');
  }

  return {
    recommendations,
    currentPortfolioValue: roundMoney(currentPortfolioValue),
    targetPortfolioValue: roundMoney(targetPortfolioValue),
    totalEstimatedCost,
    remainingCash: Math.max(0, remainingCash),
  };
}

export class ExecuteRebalanceUseCase {
  constructor(
    private readonly database: typeof db = db,
    private readonly quoteService: Pick<typeof stockQuoteService, 'getQuotes'> = stockQuoteService,
  ) {}

  /**
   * Executa um aporte buy-only da carteira:
   *  1. Lê os ativos e metas de alocação do banco
   *  2. Busca cotações em tempo real (com cache Redis)
   *  3. Calcula deficits sobre o patrimonio final, sem sugerir vendas
   */
  async execute(input: ExecuteRebalanceInput): Promise<RebalanceResult> {
    const { walletId, availableAmount } = input;
    // Valida tudo que já veio do cliente antes de DB/rede. O controller aplica
    // Zod, mas o use case também é uma fronteira pública para CLI/MCP/testes.
    const currentPositions = validateRebalanceRequest(
      availableAmount,
      input.currentPositions ?? [],
    );

    // 1. Busca a carteira e seus ativos-alvo
    const [wallet] = await this.database
      .select({ id: wallets.id, name: wallets.name })
      .from(wallets)
      .where(eq(wallets.id, walletId));

    if (!wallet) {
      throw new Error(`Carteira ${walletId} não encontrada`);
    }

    const assets = await this.database
      .select({
        ticker: walletAssets.ticker,
        targetPercent: walletAssets.targetAllocationPercent,
      })
      .from(walletAssets)
      .where(eq(walletAssets.walletId, walletId));

    // Validação financeira da configuração persistida também precede cotações.
    const targets = validateRebalanceTargets(
      assets.map((asset) => ({
        ticker: asset.ticker,
        targetPercent: Number(asset.targetPercent),
      })),
    );

    // 2. Busca cotacoes de todos os ativos que participam do patrimonio.
    const tickers = [
      ...new Set([
        ...targets.map((target) => target.ticker),
        ...currentPositions.map((position) => position.ticker),
      ]),
    ];
    const quotes = await this.quoteService.getQuotes(tickers);

    const prices = new Map(
      [...quotes].map(([ticker, quote]) => [ticker.toUpperCase(), quote.price]),
    );
    const calculation = calculateBuyOnlyRebalance(
      targets,
      availableAmount,
      currentPositions,
      prices,
    );

    return {
      walletId,
      mode: 'BUY_ONLY',
      availableAmount,
      currentPortfolioValue: calculation.currentPortfolioValue,
      targetPortfolioValue: calculation.targetPortfolioValue,
      totalEstimatedCost: calculation.totalEstimatedCost,
      remainingCash: calculation.remainingCash,
      executedAt: new Date(),
      recommendations: calculation.recommendations,
    };
  }
}
