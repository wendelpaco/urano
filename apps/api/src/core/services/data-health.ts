/**
 * DataHealth — contrato de saúde dos dados + derivação pura de warnings.
 * O preenchimento (SQL) fica em infra/database/health-queries.ts.
 */

export interface FiscalYearCoverage { fiscalYear: number; companies: number; }

export interface DataHealth {
  fundamentals: {
    totalCompanies: number;
    withFundamentals: number;
    /** empresas cujo fundamentals mais recente tem <= 12 meses */
    freshCompanies: number;
    byFiscalYear: FiscalYearCoverage[];
  };
  jobs: {
    enabled: number;
    failing: number;
    lastRunAt: string | null;
  };
  generatedAt: string;
}

const STALE_SYNC_DAYS = 7;

export function deriveHealthWarnings(h: DataHealth): string[] {
  const warnings: string[] = [];
  const f = h.fundamentals;

  if (f.totalCompanies > 0 && f.withFundamentals / f.totalCompanies < 0.5) {
    warnings.push(
      `Baixa cobertura de fundamentals: ${f.withFundamentals} de ${f.totalCompanies} empresas (${Math.round((f.withFundamentals / f.totalCompanies) * 100)}%)`,
    );
  }

  if (f.withFundamentals > 0 && f.freshCompanies / f.withFundamentals < 0.7) {
    const stalePct = Math.round((1 - f.freshCompanies / f.withFundamentals) * 100);
    warnings.push(
      `${stalePct}% das empresas com fundamentals mais velhos que 12 meses — scores podem estar defasados`,
    );
  }

  if (h.jobs.failing > 0) {
    warnings.push(`${h.jobs.failing} job(s) de sincronização em estado de falha`);
  }

  const last = h.jobs.lastRunAt ? new Date(h.jobs.lastRunAt).getTime() : null;
  if (last === null || Date.now() - last > STALE_SYNC_DAYS * 86400_000) {
    warnings.push(
      `Nenhuma sincronização de dados nos últimos ${STALE_SYNC_DAYS} dias — rode o worker:sync`,
    );
  }

  return warnings;
}
