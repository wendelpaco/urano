import { db } from './connection.ts';
import type { DataHealth, FiscalYearCoverage } from '../../core/services/data-health.ts';

export async function fetchDataHealth(): Promise<DataHealth> {
  const [companiesRows, withRows, freshRows, byYearRows, jobsRows] = await Promise.all([
    db.execute(`SELECT COUNT(*)::int AS total FROM companies`),
    db.execute(`SELECT COUNT(DISTINCT company_cnpj)::int AS total FROM company_fundamentals`),
    db.execute(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT company_cnpj, MAX(reference_date) AS latest
         FROM company_fundamentals GROUP BY company_cnpj
       ) t WHERE t.latest >= (CURRENT_DATE - INTERVAL '12 months')`,
    ),
    db.execute(
      `SELECT fiscal_year, COUNT(DISTINCT company_cnpj)::int AS companies
       FROM company_fundamentals GROUP BY fiscal_year
       ORDER BY fiscal_year DESC LIMIT 8`,
    ),
    db.execute(
      `SELECT
         COUNT(*) FILTER (WHERE enabled)::int AS enabled,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failing,
         MAX(last_run_at) AS last_run
       FROM jobs`,
    ),
  ]);

  const one = <T>(rows: unknown): T => (rows as T[])[0] as T;
  const jobs = one<{ enabled: number; failing: number; last_run: string | Date | null }>(jobsRows);

  return {
    fundamentals: {
      totalCompanies: Number(one<{ total: number }>(companiesRows)?.total ?? 0),
      withFundamentals: Number(one<{ total: number }>(withRows)?.total ?? 0),
      freshCompanies: Number(one<{ total: number }>(freshRows)?.total ?? 0),
      byFiscalYear: (byYearRows as unknown as Array<{ fiscal_year: number; companies: number }>).map(
        (r): FiscalYearCoverage => ({ fiscalYear: Number(r.fiscal_year), companies: Number(r.companies) }),
      ),
    },
    jobs: {
      enabled: Number(jobs?.enabled ?? 0),
      failing: Number(jobs?.failing ?? 0),
      lastRunAt: jobs?.last_run ? new Date(jobs.last_run).toISOString() : null,
    },
    generatedAt: new Date().toISOString(),
  };
}
