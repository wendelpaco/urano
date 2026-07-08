import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import { env } from './config/env.ts';
import { routesPlugin } from './infra/http/routes/index.ts';
import { JobStore } from './infra/jobs/job-store.ts';
import { JobWorker } from './infra/jobs/worker.ts';
import { JobScheduler } from './infra/jobs/scheduler.ts';
import { checkRedisConnection } from './infra/services/redis.ts';
import { checkDatabaseConnection } from './infra/database/connection.ts';
import { rateLimiter } from './infra/http/middleware/rate-limit.ts';

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

// Rate limiting
app.addHook('onRequest', rateLimiter);

// Compressão gzip (Bun nativo)
app.addHook('onSend', async (request, reply, payload) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (body.length < 1024) return payload;
  const accept = request.headers['accept-encoding'] || '';
  if (accept.includes('gzip')) {
    reply.header('Content-Encoding', 'gzip');
    return Bun.gzipSync(new TextEncoder().encode(body));
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
  reply.status(fe.statusCode ?? 500).send({ error: 'InternalServerError', message: fe.message ?? 'Erro interno.' });
});

// ─── Job Scheduler ──────────────────────────────────────────────────────
const jobStore = new JobStore();
const jobWorker = new JobWorker(jobStore);
const scheduler = new JobScheduler(jobStore, jobWorker, {
  enabled: true, checkInterval: 30_000, maxConcurrentJobs: 3, staleTimeout: 300_000,
});
scheduler.start().catch((err) => console.warn('[scheduler] Falha ao iniciar:', err.message));

process.on('SIGINT', async () => { await scheduler.stop(); await app.close(); process.exit(0); });
process.on('SIGTERM', async () => { await scheduler.stop(); await app.close(); process.exit(0); });

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
