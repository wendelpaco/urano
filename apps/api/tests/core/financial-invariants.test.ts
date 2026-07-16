import { describe, expect, it } from 'bun:test';
import {
  allocateWholeUnits,
  resolveAllocationPercentages,
  summarizeAllocation,
  validateAllocationConfig,
  type AllocationConfig,
} from '../../src/core/services/allocation-engine.ts';
import {
  calculateBuyOnlyRebalance,
  ExecuteRebalanceUseCase,
  MAX_REBALANCE_POSITION_QUANTITY,
  MAX_REBALANCE_POSITIONS,
  RebalanceValidationError,
} from '../../src/core/use-cases/execute-rebalance.ts';

const baseConfig: AllocationConfig = {
  totalAmount: 1_000,
  riskProfile: 'moderado',
  stockPercent: 50,
  fiiPercent: 50,
  minScore: 50,
  maxAssets: 10,
};

const candidate = (
  ticker: string,
  score: number,
  price: number,
) => ({
  ticker,
  name: ticker,
  score,
  price,
  reasons: [],
  alerts: [],
});

describe('invariantes da alocacao', () => {
  it('rejeita percentuais globais que nao somam 100%', () => {
    expect(() => validateAllocationConfig({
      ...baseConfig,
      stockPercent: 70,
      fiiPercent: 70,
    })).toThrow('somar 100%');
  });

  it('resolve o percentual omitido como complemento', () => {
    expect(resolveAllocationPercentages(65, undefined, baseConfig)).toEqual({
      stockPercent: 65,
      fiiPercent: 35,
    });
    expect(resolveAllocationPercentages(undefined, 25, baseConfig)).toEqual({
      stockPercent: 75,
      fiiPercent: 25,
    });
  });

  it('contabiliza somente quantidade inteira vezes preco e remove quantidade zero', () => {
    const allocations = allocateWholeUnits(
      [candidate('AAAA3', 80, 100), candidate('CARA3', 20, 2_000)],
      1_000,
      1_000,
      'stock',
    );

    expect(allocations.map((item) => item.ticker)).toEqual(['AAAA3']);
    for (const item of allocations) {
      expect(item.quantity).toBeGreaterThan(0);
      expect(item.allocationAmount).toBeCloseTo(item.quantity * item.price, 2);
    }
    expect(allocations.reduce((sum, item) => sum + item.allocationAmount, 0))
      .toBeLessThanOrEqual(1_000);
  });

  it('percentual publicado e global, baseado no custo executavel', () => {
    const stocks = allocateWholeUnits(
      [candidate('AAAA3', 50, 100)],
      500,
      1_000,
      'stock',
    );
    const fiis = allocateWholeUnits(
      [candidate('FFFF11', 50, 100)],
      500,
      1_000,
      'fii',
    );

    expect(stocks[0]?.allocationPercent).toBe(50);
    expect(fiis[0]?.allocationPercent).toBe(50);
    expect([...stocks, ...fiis].reduce((sum, item) => sum + item.allocationPercent, 0))
      .toBe(100);
  });

  it('score filtra e ordena, mas nao aumenta o peso financeiro do selecionado', () => {
    const allocations = allocateWholeUnits(
      [candidate('ALTO3', 95, 10), candidate('BAIX3', 50, 10)],
      1_000,
      1_000,
      'stock',
    );

    expect(allocations).toHaveLength(2);
    expect(allocations[0]?.quantity).toBe(50);
    expect(allocations[1]?.quantity).toBe(50);
    expect(allocations[0]?.allocationAmount).toBe(allocations[1]?.allocationAmount);
  });

  it('mantem em caixa o orcamento da classe sem ativos elegiveis', () => {
    const stocks = allocateWholeUnits([], 500, 1_000, 'stock');
    const fiis = allocateWholeUnits(
      [candidate('FFFF11', 80, 100)],
      500,
      1_000,
      'fii',
    );
    const summary = summarizeAllocation(1_000, stocks, fiis);

    expect(summary.stocks).toBe(0);
    expect(summary.fiis).toBe(1);
    expect(summary.totalInvested).toBe(500);
    expect(summary.remainingCash).toBe(500);
    expect(summary.totalInvested + summary.remainingCash).toBe(1_000);
    expect(summary.estimatedDividendYield).toBeNull();
  });
});

describe('rebalanceamento buy-only', () => {
  const targets = [
    { ticker: 'AAAA3', targetPercent: 50 },
    { ticker: 'BBBB3', targetPercent: 50 },
  ];
  const prices = new Map([
    ['AAAA3', 10],
    ['BBBB3', 10],
    ['FORA3', 20],
  ]);

  it('considera o patrimonio final, mantem sobrepeso e nunca sugere SELL', () => {
    const result = calculateBuyOnlyRebalance(
      targets,
      200,
      [{ ticker: 'AAAA3', quantity: 80 }],
      prices,
    );

    expect(result.currentPortfolioValue).toBe(800);
    expect(result.targetPortfolioValue).toBe(1_000);
    expect(result.recommendations.find((item) => item.ticker === 'AAAA3'))
      .toMatchObject({ suggestedAction: 'HOLD', suggestedQuantity: 0, estimatedCost: 0 });
    expect(result.recommendations.find((item) => item.ticker === 'BBBB3'))
      .toMatchObject({ suggestedAction: 'BUY', suggestedQuantity: 20, estimatedCost: 200 });
    expect(result.recommendations.every((item) => item.suggestedAction !== ('SELL' as never)))
      .toBe(true);
  });

  it('inclui posicoes fora da carteira alvo no patrimonio total', () => {
    const result = calculateBuyOnlyRebalance(
      targets,
      100,
      [{ ticker: 'FORA3', quantity: 10 }],
      prices,
    );

    expect(result.currentPortfolioValue).toBe(200);
    expect(result.targetPortfolioValue).toBe(300);
    expect(result.totalEstimatedCost).toBeLessThanOrEqual(100);
    expect(result.totalEstimatedCost + result.remainingCash).toBeCloseTo(100, 2);
  });

  it('rejeita metas invalidas e cotacao ausente em vez de fabricar resultado', () => {
    expect(() => calculateBuyOnlyRebalance(
      [{ ticker: 'AAAA3', targetPercent: 80 }],
      100,
      [],
      prices,
    )).toThrow(RebalanceValidationError);

    expect(() => calculateBuyOnlyRebalance(
      targets,
      100,
      [{ ticker: 'SEMPR', quantity: 1 }],
      prices,
    )).toThrow('Cotacao indisponivel');

    expect(() => calculateBuyOnlyRebalance(
      [
        { ticker: 'AAAA3', targetPercent: 50 },
        { ticker: 'AAAA3', targetPercent: 50 },
      ],
      100,
      [],
      prices,
    )).toThrow('ticker duplicado');
  });

  it('rejeita Infinity, quantidade e lista excessivas antes de DB ou cotacoes', async () => {
    let databaseCalls = 0;
    let quoteCalls = 0;
    const database = {
      select: () => {
        databaseCalls++;
        throw new Error('database não deveria ser consultado');
      },
    };
    const quoteService = {
      getQuotes: async () => {
        quoteCalls++;
        return new Map();
      },
    };
    const useCase = new ExecuteRebalanceUseCase(
      database as never,
      quoteService as never,
    );
    const invalidInputs = [
      { walletId: 'wallet', availableAmount: Number.POSITIVE_INFINITY },
      {
        walletId: 'wallet',
        availableAmount: 100,
        currentPositions: [{
          ticker: 'AAAA3',
          quantity: MAX_REBALANCE_POSITION_QUANTITY + 1,
        }],
      },
      {
        walletId: 'wallet',
        availableAmount: 100,
        currentPositions: Array.from(
          { length: MAX_REBALANCE_POSITIONS + 1 },
          () => ({ ticker: 'AAAA3', quantity: 1 }),
        ),
      },
    ];

    for (const input of invalidInputs) {
      await expect(useCase.execute(input)).rejects.toBeInstanceOf(RebalanceValidationError);
    }
    expect(databaseCalls).toBe(0);
    expect(quoteCalls).toBe(0);
  });

  it('valida metas persistidas antes de buscar cotacoes', async () => {
    let selectCall = 0;
    let quoteCalls = 0;
    const database = {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCall++;
            if (selectCall === 1) return [{ id: 'wallet', name: 'Teste' }];
            return [{ ticker: 'AAAA3', targetPercent: '80' }];
          },
        }),
      }),
    };
    const quoteService = {
      getQuotes: async () => {
        quoteCalls++;
        return new Map();
      },
    };
    const useCase = new ExecuteRebalanceUseCase(
      database as never,
      quoteService as never,
    );

    await expect(useCase.execute({
      walletId: 'wallet',
      availableAmount: 100,
      currentPositions: [],
    })).rejects.toBeInstanceOf(RebalanceValidationError);
    expect(selectCall).toBe(2);
    expect(quoteCalls).toBe(0);
  });
});
