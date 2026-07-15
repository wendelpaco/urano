import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkDatabaseConnection } from '../../database/connection.ts';
import { checkRedisConnection } from '../../services/redis.ts';

/**
 * GET /v1/healthcheck — público (liveness/readiness mínimo).
 *
 * Não expõe circuit breakers, rate limiters internos nem janelas de ETL:
 * isso ficou em rotas autenticadas (/health/data, /health/scraper).
 */
export async function healthcheckController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const [dbOk, redisOk] = await Promise.all([
    checkDatabaseConnection().then(() => true).catch(() => false),
    checkRedisConnection(),
  ]);

  const ready = dbOk && redisOk;
  reply.status(ready ? 200 : 503).send({
    status: ready ? 'ok' : 'degraded',
    checks: {
      database: dbOk ? 'up' : 'down',
      redis: redisOk ? 'up' : 'down',
    },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
