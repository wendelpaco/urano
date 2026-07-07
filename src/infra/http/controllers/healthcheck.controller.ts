import type { FastifyReply, FastifyRequest } from 'fastify';

export async function healthcheckController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const uptimeSeconds = process.uptime();

  reply.send({
    status: 'ok',
    uptime: {
      seconds: Math.round(uptimeSeconds * 100) / 100,
      formatted: formatUptime(uptimeSeconds),
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
