import { describe, expect, test } from 'bun:test';
import { withRetry, withTimeout, batchWithConcurrency, TimeoutError } from '../../src/shared/retry.ts';

describe('withRetry', () => {
  test('retorna na primeira tentativa quando fn resolve', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 42; });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test('tenta novamente após falha e retorna sucesso', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
      { maxRetries: 1, initialDelay: 1, maxDelay: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('lança o último erro após esgotar tentativas', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('sempre falha'); },
        { maxRetries: 1, initialDelay: 1, maxDelay: 2 }),
    ).rejects.toThrow('sempre falha');
    expect(calls).toBe(2); // 2 tentativas totais (spec §5)
  });

  test('chama onRetry a cada nova tentativa', async () => {
    const attempts: number[] = [];
    await withRetry(
      async () => { if (attempts.length === 0) throw new Error('x'); return 1; },
      { maxRetries: 1, initialDelay: 1, maxDelay: 2, onRetry: (a) => attempts.push(a) },
    );
    expect(attempts).toEqual([1]);
  });
});

describe('withTimeout', () => {
  test('resolve quando promise termina antes do timeout', async () => {
    const result = await withTimeout(Promise.resolve('rápido'), 100);
    expect(result).toBe('rápido');
  });

  test('rejeita com TimeoutError quando estoura', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('tarde'), 200));
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('batchWithConcurrency', () => {
  test('processa todos os itens', async () => {
    const results = await batchWithConcurrency([1, 2, 3, 4, 5], async (n) => n * 2, 2);
    expect(results.toSorted((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
  });

  test('respeita o limite de concorrência', async () => {
    let active = 0;
    let peak = 0;
    await batchWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
      2,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
