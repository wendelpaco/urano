import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseStatusInvestHtml,
  extractNumber,
  extractPercent,
  extractNullablePercent,
} from '../../src/infra/services/scrapers/statusinvest-parse.ts';

const fixturePath = join(import.meta.dir, '../fixtures/statusinvest-stock-wege3.html');
const html = readFileSync(fixturePath, 'utf-8');

describe('extractNumber / extractPercent', () => {
  it('parses BR decimal and thousands', () => {
    expect(extractNumber('36,50')).toBe(36.5);
    expect(extractNumber('1.234,56')).toBe(1234.56);
  });

  it('applies M/K/B multipliers', () => {
    expect(extractNumber('85,3 M')).toBeCloseTo(85_300_000, 0);
    expect(extractNumber('1,5 K')).toBe(1500);
    expect(extractNumber('2 B')).toBe(2_000_000_000);
  });

  it('preserves negative sign', () => {
    expect(extractNumber('-0,15')).toBeCloseTo(-0.15, 5);
  });

  it('extractPercent strips %', () => {
    expect(extractPercent('27,50%')).toBeCloseTo(27.5, 5);
    expect(extractPercent('-')).toBe(0);
  });

  it('extractNullablePercent treats blank/- as null', () => {
    expect(extractNullablePercent('-')).toBeNull();
    expect(extractNullablePercent('')).toBeNull();
    expect(extractNullablePercent('14,30%')).toBeCloseTo(14.3, 5);
  });
});

describe('parseStatusInvestHtml (golden fixture, no network)', () => {
  const r = parseStatusInvestHtml(html, 'wege3');

  it('normalizes ticker and name/price/sector', () => {
    expect(r.ticker).toBe('WEGE3');
    expect(r.name).toBe('WEG S.A.');
    expect(r.price).toBeCloseTo(36.5, 5);
    expect(r.sector).toBe('Bens Industriais');
  });

  it('maps valuation indicators from data-name cards', () => {
    expect(r.dy).toBeCloseTo(1.52, 5);
    expect(r.pl).toBeCloseTo(28.4, 5);
    expect(r.pvp).toBeCloseTo(7.85, 5);
    expect(r.evEbitda).toBeCloseTo(18.2, 5);
    expect(r.evEbit).toBeCloseTo(20.1, 5);
    expect(r.pebit).toBeCloseTo(19.5, 5);
    expect(r.vpa).toBeCloseTo(4.65, 5);
    expect(r.lpa).toBeCloseTo(1.28, 5);
    expect(r.psr).toBeCloseTo(5.1, 5);
    expect(r.pegRatio).toBeCloseTo(2.3, 5);
  });

  it('maps profitability and growth', () => {
    expect(r.roe).toBeCloseTo(27.5, 5);
    expect(r.roa).toBeCloseTo(15.2, 5);
    expect(r.roic).toBeCloseTo(22.1, 5);
    expect(r.grossMargin).toBeCloseTo(32.4, 5);
    expect(r.ebitdaMargin).toBeCloseTo(24, 5);
    expect(r.ebitMargin).toBeCloseTo(21.5, 5);
    expect(r.netMargin).toBeCloseTo(17.8, 5);
    expect(r.cagrRevenue5y).toBeCloseTo(14.3, 5);
    expect(r.cagrEarnings5y).toBeCloseTo(18.7, 5);
  });

  it('maps debt, efficiency, liquidity and ibov', () => {
    expect(r.netDebtToEquity).toBeCloseTo(-0.15, 5);
    expect(r.netDebtToEbitda).toBeCloseTo(-0.4, 5);
    expect(r.currentRatio).toBeCloseTo(2.1, 5);
    expect(r.assetTurnover).toBeCloseTo(0.85, 5);
    expect(r.avgDailyLiquidity).toBeCloseTo(85_300_000, 0);
    expect(r.ibovParticipation).toBeCloseTo(2.45, 5);
  });

  it('extracts DY 12m from title attribute', () => {
    expect(r.dy12m).toBeCloseTo(1.48, 5);
  });

  it('does not fetch dividends (history empty)', () => {
    expect(r.dividendsHistory).toEqual([]);
  });

  it('falls back to ticker when name missing', () => {
    const empty = parseStatusInvestHtml('<html><body></body></html>', 'PETR4');
    expect(empty.ticker).toBe('PETR4');
    expect(empty.name).toBe('PETR4');
    expect(empty.price).toBe(0);
  });
});
