import { describe, it, expect } from 'bun:test';
import { deriveHealthWarnings, type DataHealth } from '../../src/core/services/data-health.ts';

function healthy(): DataHealth {
  return {
    fundamentals: {
      totalCompanies: 100,
      withFundamentals: 90,
      freshCompanies: 85,
      byFiscalYear: [{ fiscalYear: 2025, companies: 90 }],
    },
    jobs: { enabled: 50, failing: 0, lastRunAt: new Date().toISOString() },
    generatedAt: new Date().toISOString(),
  };
}

describe('deriveHealthWarnings', () => {
  it('base saudável → sem warnings', () => {
    expect(deriveHealthWarnings(healthy())).toEqual([]);
  });

  it('cobertura < 50% → warning de cobertura', () => {
    const h = healthy();
    h.fundamentals.withFundamentals = 40;
    expect(deriveHealthWarnings(h).some((w) => w.includes('cobertura'))).toBe(true);
  });

  it('menos de 70% com dados frescos → warning de dados velhos', () => {
    const h = healthy();
    h.fundamentals.freshCompanies = 50; // 50/90 = 55%
    expect(deriveHealthWarnings(h).some((w) => w.includes('12 meses'))).toBe(true);
  });

  it('jobs falhando → warning', () => {
    const h = healthy();
    h.jobs.failing = 3;
    expect(deriveHealthWarnings(h).some((w) => w.includes('job'))).toBe(true);
  });

  it('sync parado há mais de 7 dias → warning', () => {
    const h = healthy();
    h.jobs.lastRunAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    expect(deriveHealthWarnings(h).some((w) => w.includes('sincronização'))).toBe(true);
  });

  it('lastRunAt null → warning de sincronização', () => {
    const h = healthy();
    h.jobs.lastRunAt = null;
    expect(deriveHealthWarnings(h).some((w) => w.includes('sincronização'))).toBe(true);
  });
});
