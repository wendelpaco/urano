import type { FastifyReply, FastifyRequest } from 'fastify';
import { fetchDataHealth } from '../../database/health-queries.ts';
import { deriveHealthWarnings } from '../../../core/services/data-health.ts';
import { redis } from '../../services/redis.ts';

const CACHE_KEY = 'health:data';
const CACHE_TTL = 300;

export async function getDataHealthController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch {
    // Redis offline — segue sem cache
  }

  const health = await fetchDataHealth();
  const warningStrings = deriveHealthWarnings(health);
  const warnings = warningStrings.map((message) => ({
    level: 'warn' as const,
    message,
    source: 'system',
  }));

  const total = health.fundamentals.totalCompanies;
  const withF = health.fundamentals.withFundamentals;
  const fresh = health.fundamentals.freshCompanies;
  const coverage = total > 0 ? withF / total : 0;
  const freshnessRatio = total > 0 ? fresh / total : 0;

  const sources = [
    {
      name: 'CVM Fundamentals',
      status: coverage >= 0.7 ? 'ok' : coverage >= 0.4 ? 'warn' : 'error',
      coverage,
      freshness: freshnessRatio >= 0.5 ? 'ok' : 'stale',
      lastUpdate: health.generatedAt,
    },
    {
      name: 'Job Scheduler',
      status: health.jobs.failing > 0 ? 'warn' : 'ok',
      coverage: health.jobs.enabled > 0 ? 1 : 0,
      freshness: health.jobs.lastRunAt ? 'ok' : 'unknown',
      lastUpdate: health.jobs.lastRunAt,
    },
    {
      name: 'Market Quotes (I10/Yahoo)',
      status: 'ok',
      coverage: null,
      freshness: 'live-cache',
      lastUpdate: health.generatedAt,
    },
  ];

  const response = {
    ...health,
    status: warnings.length > 0 ? 'warn' : 'ok',
    sources,
    warnings,
  };

  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(response));
  } catch { /* sem cache */ }

  reply.send(response);
}
