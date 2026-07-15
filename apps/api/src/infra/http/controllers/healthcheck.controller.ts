import type { FastifyReply, FastifyRequest } from 'fastify';
import { rateLimiterRegistry } from '../../services/rate-limiter.ts';
import {
  statusInvestCircuitBreaker,
  yahooCircuitBreaker,
  cvmCircuitBreaker,
} from '../../services/circuit-breaker.ts';
import { userAgentPool } from '../../services/user-agent-pool.ts';
import { etlWindow, snapshotWindow } from '../../jobs/time-window.ts';

export async function healthcheckController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const uptimeSeconds = process.uptime();

  const [siState, yhState, cvmState] = await Promise.all([
    statusInvestCircuitBreaker.currentState(),
    yahooCircuitBreaker.currentState(),
    cvmCircuitBreaker.currentState(),
  ]);

  reply.send({
    status: 'ok',
    uptime: {
      seconds: Math.round(uptimeSeconds * 100) / 100,
      formatted: formatUptime(uptimeSeconds),
    },
    rateLimiters: rateLimiterRegistry.getStats(),
    circuitBreakers: {
      statusinvest: siState,
      yahoo: yhState,
      cvm: cvmState,
    },
    userAgentPool: userAgentPool.getStats(),
    timeWindows: {
      etl: etlWindow.getStatus(),
      snapshot: snapshotWindow.getStatus(),
    },
    timestamp: new Date().toISOString(),
  });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}
