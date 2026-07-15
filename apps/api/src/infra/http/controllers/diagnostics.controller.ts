/**
 * Diagnostics Controller — Status completo do sistema de scraping.
 *
 * Endpoints:
 *   GET /v1/health/scraper  — Jobs, runs, dados recentes, rate limiters
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { JobStore } from '../../jobs/job-store.ts';
import { rateLimiterRegistry } from '../../services/rate-limiter.ts';
import {
  statusInvestCircuitBreaker,
  yahooCircuitBreaker,
  cvmCircuitBreaker,
} from '../../services/circuit-breaker.ts';
import { userAgentPool } from '../../services/user-agent-pool.ts';

const jobStore = new JobStore();

export async function scraperDiagnosticsController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const start = Date.now();

  const [
    jobStats,
    recentRuns,
    recentCompanies,
    recentFundamentals,
    siState,
    yhState,
    cvmState,
  ] = await Promise.all([
    jobStore.getStats(),
    jobStore.getRecentRuns(20),
    db.execute(sql`
      SELECT ticker, name, sector, updated_at
      FROM companies
      ORDER BY updated_at DESC
      LIMIT 10
    `),
    db.execute(sql`
      SELECT cf.company_cnpj, c.ticker, cf.source, cf.reference_date, cf.extracted_at
      FROM company_fundamentals cf
      JOIN companies c ON c.cnpj = cf.company_cnpj
      ORDER BY cf.extracted_at DESC
      LIMIT 10
    `),
    statusInvestCircuitBreaker.currentState(),
    yahooCircuitBreaker.currentState(),
    cvmCircuitBreaker.currentState(),
  ]);

  // Jobs que estão rodando agora ou falharam recentemente
  const recentFailed = (await db.execute(sql`
    SELECT ticker, asset_type, status, last_error, last_run_at, retry_count
    FROM jobs
    WHERE status IN ('failed', 'running')
    ORDER BY last_run_at DESC NULLS LAST
    LIMIT 10
  `)) as unknown as Record<string, unknown>[];

  // Próximos jobs a rodar
  const nextJobs = (await db.execute(sql`
    SELECT ticker, asset_type, next_run_at
    FROM jobs
    WHERE enabled = true AND status = 'pending'
    ORDER BY next_run_at ASC
    LIMIT 10
  `)) as unknown as Record<string, unknown>[];

  // Contagem por source (CVM vs StatusInvest)
  const sourceCounts = (await db.execute(sql`
    SELECT source, COUNT(*)::int as count, MAX(extracted_at) as last_extraction
    FROM company_fundamentals
    GROUP BY source
  `)) as unknown as Record<string, unknown>[];

  reply.send({
    status: 'ok',
    elapsedMs: Date.now() - start,
    timestamp: new Date().toISOString(),

    jobs: {
      ...jobStats.jobs,
      nextToRun: nextJobs,
      recentFailed,
    },

    runs: {
      ...jobStats.runs,
      recent: (recentRuns as unknown[]).slice(0, 20),
    },

    data: {
      companies: {
        recent: recentCompanies,
      },
      fundamentals: {
        bySource: sourceCounts,
        recent: recentFundamentals,
      },
    },

    rateLimiters: rateLimiterRegistry.getStats(),

    circuitBreakers: {
      statusinvest: siState,
      yahoo: yhState,
      cvm: cvmState,
    },

    userAgentPool: userAgentPool.getStats(),
  });
}
