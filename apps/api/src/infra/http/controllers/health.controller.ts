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
      // Until extraction telemetry is stored per source, do not present the
      // time of this HTTP request as if it were the CVM update time.
      lastUpdate: null,
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
      // Quote providers are fetched on demand and currently have no durable
      // last-success metric. Unknown is safer than a fabricated green status.
      status: 'unknown',
      coverage: null,
      freshness: 'unknown',
      lastUpdate: null,
    },
  ];
  // 'unknown' = fonte sem telemetria durável (ex.: quotes on-demand). Não é uma
  // degradação observada, então não rebaixa o status global — senão o endpoint
  // ficaria preso em 'warn' para sempre e mascararia degradações reais ('warn'/'error').
  const hasDegradedSource = sources.some(
    (source) => source.status === 'warn' || source.status === 'error',
  );

  const response = {
    ...health,
    status: warnings.length > 0 || hasDegradedSource ? 'warn' : 'ok',
    sources,
    warnings,
  };

  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(response));
  } catch { /* sem cache */ }

  reply.send(response);
}
