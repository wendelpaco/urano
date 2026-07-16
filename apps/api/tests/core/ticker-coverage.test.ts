import { describe, expect, test } from 'bun:test';
import { TICKER_TO_CNPJ } from '../../src/core/use-cases/sync-company-fundamentals.ts';
import { ALL_STOCK_TICKERS } from '../../src/shared/tickers-master-list.ts';

describe('universo CVM de acoes', () => {
  test('nao contem tickers duplicados', () => {
    expect(new Set(ALL_STOCK_TICKERS).size).toBe(ALL_STOCK_TICKERS.length);
  });

  test('todo ticker possui CNPJ numerico de 14 digitos', () => {
    const missing = ALL_STOCK_TICKERS.filter(
      (ticker) => !/^\d{14}$/.test(TICKER_TO_CNPJ[ticker] ?? ''),
    );

    expect(missing).toEqual([]);
  });
});
