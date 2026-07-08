import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';

// ─── Console override para timestamp GMT-3 ────────────────────────────
const _orig = { log: console.log, warn: console.warn, error: console.error };
function brTs(): string {
  const d = new Date(new Date().getTime() - 3 * 3600000);
  return [String(d.getUTCDate()).padStart(2, '0'), String(d.getUTCMonth() + 1).padStart(2, '0'), d.getUTCFullYear(),
    String(d.getUTCHours()).padStart(2, '0'), String(d.getUTCMinutes()).padStart(2, '0'), String(d.getUTCSeconds()).padStart(2, '0')].join(' ');
}
console.log = (...a: unknown[]) => _orig.log(`${brTs()}`, ...a);
console.warn = (...a: unknown[]) => _orig.warn(`${brTs()}`, ...a);
console.error = (...a: unknown[]) => _orig.error(`${brTs()}`, ...a);
import { env } from './config/env.ts';
import { routesPlugin } from './infra/http/routes/index.ts';
import { JobStore } from './infra/jobs/job-store.ts';
import { JobWorker } from './infra/jobs/worker.ts';
import { JobScheduler } from './infra/jobs/scheduler.ts';
import { checkRedisConnection } from './infra/services/redis.ts';
import { checkDatabaseConnection } from './infra/database/connection.ts';
import { rateLimiter } from './infra/http/middleware/rate-limit.ts';

const isDev = process.env.NODE_ENV !== 'production';

// Timestamp GMT-3 (horário de Brasília) no formato dd mm yyyy hh mm ss
function brtTimestamp(): string {
  const now = new Date();
  // Ajusta para GMT-3 manualmente
  const brt = new Date(now.getTime() - 3 * 3600000);
  const dd = String(brt.getUTCDate()).padStart(2, '0');
  const mm = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = brt.getUTCFullYear();
  const hh = String(brt.getUTCHours()).padStart(2, '0');
  const min = String(brt.getUTCMinutes()).padStart(2, '0');
  const ss = String(brt.getUTCSeconds()).padStart(2, '0');
  return `${dd} ${mm} ${yyyy} ${hh} ${min} ${ss}`;
}

const app = Fastify({
  logger: {
    timestamp: () => `,"time":"${brtTimestamp()}"`,
    ...(isDev ? {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, ignore: 'pid,hostname', translateTime: false },
      },
    } : {}),
  },
});

// Rate limiting global (após auth, antes das rotas)
app.addHook('onRequest', rateLimiter);

// Compressão gzip para respostas JSON > 1KB (Bun nativo, zero overhead)
app.addHook('onSend', async (request, reply, payload) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (body.length < 1024) return payload; // não comprime respostas pequenas
  const accept = request.headers['accept-encoding'] || '';
  if (accept.includes('gzip')) {
    reply.header('Content-Encoding', 'gzip');
    return Bun.gzipSync(new TextEncoder().encode(body));
  }
  return payload;
});

// Registra rotas globais sob o prefixo /v1
await app.register(routesPlugin, { prefix: '/v1' });

// Verifica se um erro é de validação Zod (pelo nome ou propriedades)
function isZodLike(error: unknown): error is { issues: Array<{ path: (string | number)[]; message: string }> } {
  const e = error as Record<string, unknown>;
  return e?.name === 'ZodError' || Array.isArray(e?.issues);
}

// Tratamento global de erros
app.setErrorHandler((error: FastifyError | Error, _request, reply) => {
  // Zod validation error — retorna 400 com detalhes
  if (isZodLike(error)) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Parâmetros da requisição inválidos.',
      details: error.issues.map(({ path, message }) => ({
        path: (Array.isArray(path) ? path : [String(path)]).join('.'),
        message,
      })),
    });
    return;
  }

  // Fastify schema validation error
  const fastifyErr = error as FastifyError;
  if (fastifyErr.validation) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Parâmetros da requisição inválidos.',
      details: fastifyErr.validation,
    });
    return;
  }

  app.log.error(error);

  reply.status(fastifyErr.statusCode ?? 500).send({
    error: 'InternalServerError',
    message: fastifyErr.message ?? 'Erro interno do servidor.',
  });
});

// ─── Job Scheduler ──────────────────────────────────────────────────────
const jobStore = new JobStore();
const jobWorker = new JobWorker(jobStore);
const scheduler = new JobScheduler(jobStore, jobWorker, {
  enabled: true,
  checkInterval: 30_000,
  maxConcurrentJobs: 3,
  staleTimeout: 300_000,
});

// Não bloqueia o startup — scheduler roda em background
scheduler.start().catch((err) => {
  console.warn('[scheduler] Falha ao iniciar (modo sem jobs):', err.message);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\n⏸️  Encerrando...');
  await scheduler.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start server ───────────────────────────────────────────────────────
try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // Log de status da infra
  const dbOk = await checkDatabaseConnection().then(() => true).catch(() => false);
  const redisOk = await checkRedisConnection();

  app.log.info(`🚀 Urano API rodando em http://0.0.0.0:${env.PORT}`);
  app.log.info(`   DB: ${dbOk ? '✅' : '❌'}  Redis: ${redisOk ? '✅' : '❌'}  Scheduler: ${scheduler.getStatus().running ? '✅' : '❌'}`);
} catch (err) {
  app.log.error(err, 'Falha ao iniciar o servidor');
  await scheduler.stop();
  process.exit(1);
}
