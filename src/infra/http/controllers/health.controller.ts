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
  const response = { ...health, warnings: deriveHealthWarnings(health) };

  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(response));
  } catch { /* sem cache */ }

  reply.send(response);
}
