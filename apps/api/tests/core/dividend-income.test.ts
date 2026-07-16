import { describe, expect, test } from 'bun:test';
import {
  aggregateMonthlyIncome,
  incomeDistributionsSince,
  monthlyIncomeSeries,
  sumIncomeDistributions,
} from '../../src/core/services/dividend-income.ts';

describe('renda de proventos', () => {
  const events = [
    { date: '2026-06-10', value: 0.4, type: 'RENDIMENTO' },
    { date: '2026-06-20', value: 0.6, type: 'DIVIDENDO' },
    { date: '2026-06-25', value: 10, type: 'AMORTIZAÇÃO' },
    { date: '2026-04-15', value: 0.8, type: 'RENDIMENTO' },
  ];

  test('amortizacao nao compoe renda nem DY', () => {
    const income = incomeDistributionsSince(events, '2026-01-01');
    expect(income).toHaveLength(3);
    expect(sumIncomeDistributions(income)).toBeCloseTo(1.8, 10);
  });

  test('eventos da mesma competencia viram uma observacao mensal', () => {
    const monthly = aggregateMonthlyIncome(events);
    expect(monthly).toHaveLength(2);
    expect(monthly[0]).toMatchObject({ month: '2026-06', value: 1 });
  });

  test('serie mensal representa lacunas explicitamente como zero', () => {
    const series = monthlyIncomeSeries(events, 3, '2026-06-30');
    expect(series.map((event) => [event.month, event.value])).toEqual([
      ['2026-06', 1],
      ['2026-05', 0],
      ['2026-04', 0.8],
    ]);
  });

  test('ancora na data da decisão e explicita meses recentes sem pagamento', () => {
    const series = monthlyIncomeSeries(events, 3, '2026-08-15');
    expect(series.map((event) => [event.month, event.value])).toEqual([
      ['2026-08', 0],
      ['2026-07', 0],
      ['2026-06', 1],
    ]);
  });
});
