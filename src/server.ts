import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import { env } from './config/env.ts';
import { routesPlugin } from './infra/http/routes/index.ts';
import { JobStore } from './infra/jobs/job-store.ts';
import { JobWorker } from './infra/jobs/worker.ts';
import { JobScheduler } from './infra/jobs/scheduler.ts';
import { checkRedisConnection } from './infra/services/redis.ts';
import { checkDatabaseConnection } from './infra/database/connection.ts';

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
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
