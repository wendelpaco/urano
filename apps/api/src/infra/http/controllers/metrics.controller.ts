/**
 * GET /v1/metrics — authenticated process metrics (JSON, not Prometheus).
 *
 * Requires x-api-key via the shared auth middleware on the /v1 plugin.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export async function metricsController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { rss, heapUsed } = process.memoryUsage();

  reply.send({
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rss,
      heapUsed,
    },
    nodeEnv: process.env.NODE_ENV ?? 'development',
  });
}
