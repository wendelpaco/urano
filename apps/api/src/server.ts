import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.ts';
import { routesPlugin } from './infra/http/routes/index.ts';
import { JobStore } from './infra/jobs/job-store.ts';
import { JobWorker } from './infra/jobs/worker.ts';
import { JobScheduler } from './infra/jobs/scheduler.ts';
import { checkRedisConnection, redis } from './infra/services/redis.ts';
import { checkDatabaseConnection, closeDatabaseConnection } from './infra/database/connection.ts';
import { buildRateLimiter } from './infra/http/middleware/rate-limit.ts';
import { createGenReqId, requestIdHook } from './infra/http/middleware/request-id.ts';
import { securityHeadersHook } from './infra/http/middleware/security-headers.ts';

const rateLimiter = buildRateLimiter({ failClosed: env.RATE_LIMIT_FAIL_CLOSED });

// ─── Timestamp GMT-3 (horário de Brasília) ─────────────────────────────
function brt(d = new Date()): string {
  const t = new Date(d.getTime() - 3 * 3600000);
  const date = [String(t.getUTCDate()).padStart(2, '0'), String(t.getUTCMonth() + 1).padStart(2, '0'), t.getUTCFullYear()].join('/');
  const time = [String(t.getUTCHours()).padStart(2, '0'), String(t.getUTCMinutes()).padStart(2, '0'), String(t.getUTCSeconds()).padStart(2, '0')].join(':');
  return `${date} ${time}`;
}

// Aplica timestamp GMT-3 em todos os console.*
const _c = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a: unknown[]) => _c.log(`[${brt()}]`, ...a);
console.warn = (...a: unknown[]) => _c.warn(`[${brt()}]`, ...a);
console.error = (...a: unknown[]) => _c.error(`[${brt()}]`, ...a);

// ─── Fastify ────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';

const app = Fastify({
  // Correlation id: honor incoming x-request-id or generate UUID (request.id).
  genReqId: createGenReqId(),
  bodyLimit: env.BODY_LIMIT_BYTES,
  connectionTimeout: 10_000,
  requestTimeout: env.REQUEST_TIMEOUT_MS,
  // When behind a reverse proxy that terminates TLS
  trustProxy: true,
  logger: {
    timestamp: () => `,"time":"${brt()}"`,
    ...(isDev ? {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', translateTime: false },
      },
    } : {}),
  },
});

await app.register(cors, { origin: [env.CORS_ORIGIN], methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });

// Request correlation id, security headers, rate limiting (does not touch CORS)
app.addHook('onRequest', requestIdHook);
app.addHook('onRequest', securityHeadersHook);
app.addHook('onRequest', rateLimiter);

// Light access log: method, url, status, duration — reqId comes from Fastify logger bindings
app.addHook('onResponse', async (request, reply) => {
  request.log.info(
    {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    },
    'request completed',
  );
});

// Compressão gzip (Bun nativo)
app.addHook('onSend', async (request, reply, payload) => {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  const body = typeof payload === 'string' ? payload : payload.toString('utf-8');
  if (body.length < 1024) return payload;
  const accept = request.headers['accept-encoding'] || '';
  if (accept.includes('gzip')) {
    // Bun.gzipSync retorna Uint8Array puro; Fastify só aceita string/Buffer/Stream
    // (Buffer.isBuffer(Uint8Array) === false), por isso envolvemos em Buffer.from().
    const compressed = Buffer.from(Bun.gzipSync(new TextEncoder().encode(body)));
    reply.header('Content-Encoding', 'gzip');
    reply.header('Content-Length', compressed.byteLength);
    return compressed;
  }
  return payload;
});

await app.register(routesPlugin, { prefix: '/v1' });

// ─── Error handling ─────────────────────────────────────────────────────
app.setErrorHandler((error: FastifyError | Error, _request, reply) => {
  const e = error as unknown as Record<string, unknown>;
  if (e?.name === 'ZodError' || Array.isArray(e?.issues)) {
    reply.status(400).send({
      error: 'ValidationError', message: 'Parâmetros da requisição inválidos.',
      details: (e.issues as Array<{ path: (string | number)[]; message: string }>).map(
        ({ path, message }) => ({ path: (Array.isArray(path) ? path : [String(path)]).join('.'), message }),
      ),
    });
    return;
  }
  const fe = error as FastifyError;
  if (fe.validation) {
    reply.status(400).send({ error: 'ValidationError', message: 'Parâmetros da requisição inválidos.', details: fe.validation });
    return;
  }
  app.log.error(error);
  const status = fe.statusCode ?? 500;
  // Em produção nunca vazamos mensagem interna/stack para o cliente.
  const message =
    status >= 500 && !isDev
      ? 'Erro interno.'
      : (fe.message ?? 'Erro interno.');
  reply.status(status).send({ error: 'InternalServerError', message });
});

// ─── Job Scheduler ──────────────────────────────────────────────────────
const jobStore = new JobStore();
const jobWorker = new JobWorker(jobStore);
const scheduler = new JobScheduler(jobStore, jobWorker, {
  enabled: env.SCHEDULER_ENABLED, checkInterval: 30_000, maxConcurrentJobs: 3, staleTimeout: 300_000,
});
scheduler.start().catch((err) => console.warn('[scheduler] Falha ao iniciar:', err.message));

async function shutdown(signal: string) {
  app.log.info(`[shutdown] ${signal} recebido — encerrando…`);
  try {
    await scheduler.stop();
    await app.close();
    await closeDatabaseConnection().catch(() => {});
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

// ─── Start ──────────────────────────────────────────────────────────────
try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  const dbOk = await checkDatabaseConnection().then(() => true).catch(() => false);
  const redisOk = await checkRedisConnection();
  app.log.info(`🚀 Urano API rodando em http://0.0.0.0:${env.PORT}`);
  app.log.info(`   DB: ${dbOk ? '✅' : '❌'}  Redis: ${redisOk ? '✅' : '❌'}  Scheduler: ${scheduler.getStatus().running ? '✅' : '❌'}`);
} catch (err) {
  app.log.error(err, 'Falha ao iniciar o servidor');
  await scheduler.stop();
  process.exit(1);
}
