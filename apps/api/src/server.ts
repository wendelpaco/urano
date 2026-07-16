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

// Camada 1 (pre-auth): sempre por IP. Nunca usa x-api-key não validada como
// identidade, portanto trocar valores aleatórios no header não cria buckets.
const ipRateLimiter = buildRateLimiter({
  identity: 'ip',
  limit: env.RATE_LIMIT_IP_PER_MINUTE,
  pathLimits: {
    '/v1/healthcheck': env.HEALTHCHECK_RATE_LIMIT_PER_MINUTE,
  },
  failClosed: env.RATE_LIMIT_FAIL_CLOSED,
});

// Camada 2 (post-auth): por ID interno da chave validada pelo authMiddleware.
// SSRF-2r: rotas que disparam live-scrape têm bucket separado mais restritivo
// (10 req/min default) para evitar que uma key válida amplifique custo/risco.
const scraperPathLimits: Record<string, number> = {
  '/v1/search': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/screener': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/fiis/screener': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/analysis/ranking': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/analysis/allocate': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/analysis/contribution': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
  '/v1/analysis/compare': env.SCRAPER_RATE_LIMIT_PER_MINUTE,
};

const authenticatedKeyRateLimiter = buildRateLimiter({
  identity: 'authenticatedKey',
  limit: env.RATE_LIMIT_KEY_PER_MINUTE,
  pathLimits: scraperPathLimits,
  failClosed: env.RATE_LIMIT_FAIL_CLOSED,
});

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
  // false by default; in production configure only known proxy IPs/CIDRs.
  trustProxy: env.TRUST_PROXY,
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

// CORS_ORIGIN aceita um host ou lista separada por vírgula
// (ex.: http://localhost:8080,http://10.4.20.13:8080).
const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // Chrome Private Network Access: front em localhost → API em IP privado
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-request-id', 'Authorization'],
});

// Chrome PNA preflight exige este header além do ACAO
app.addHook('onRequest', async (request, reply) => {
  if (request.headers['access-control-request-private-network'] === 'true') {
    void reply.header('Access-Control-Allow-Private-Network', 'true');
  }
});

// Request correlation id, security headers, rate limiting (does not touch CORS)
app.addHook('onRequest', requestIdHook);
app.addHook('onRequest', securityHeadersHook);
app.addHook('onRequest', ipRateLimiter);
// Executa após todos os hooks onRequest, inclusive o authMiddleware registrado
// nas rotas /v1. Rotas públicas não têm apiKeyId e são ignoradas nesta camada.
app.addHook('preHandler', authenticatedKeyRateLimiter);

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
  // Nunca vazamos mensagem interna/stack para o cliente em erro 5xx, em nenhum
  // ambiente — o default é NODE_ENV=development, então gatear por !isDev exporia
  // detalhes de infra (nomes de tabela, credenciais em mensagens de driver) no
  // fluxo padrão. Detalhe fica só no log do servidor.
  const message =
    status >= 500
      ? 'Erro interno.'
      : (fe.message ?? 'Erro interno.');
  reply.status(status).send({ error: 'InternalServerError', message });
});

// ─── Job Scheduler ──────────────────────────────────────────────────────
const jobStore = new JobStore();
const jobWorker = new JobWorker(jobStore);
const scheduler = new JobScheduler(jobStore, jobWorker, {
  // maxConcurrentJobs=2: menos pressão no StatusInvest (rate limit free ~0.5 rps)
  enabled: env.SCHEDULER_ENABLED, checkInterval: 30_000, maxConcurrentJobs: 2, staleTimeout: 300_000,
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

  // IMP-1: inicializa SELIC dinâmica (BCB) para o score de ações.
  // Fallback 14.0 se o provider falhar.
  import('./infra/services/selic-provider.ts').then(async ({ getSelicRate }) => {
    import('./core/services/stock-score.ts').then(({ setStockScoreSelic }) => {
      getSelicRate().then((rate) => {
        if (rate !== null) {
          setStockScoreSelic(rate);
          app.log.info(`   SELIC: ${rate}% a.a. (BCB)`);
        }
      });
    });
  });

  app.log.info(`🚀 Urano API rodando em http://0.0.0.0:${env.PORT}`);
  app.log.info(`   DB: ${dbOk ? '✅' : '❌'}  Redis: ${redisOk ? '✅' : '❌'}  Scheduler: ${scheduler.getStatus().running ? '✅' : '❌'}`);
} catch (err) {
  app.log.error(err, 'Falha ao iniciar o servidor');
  await scheduler.stop();
  process.exit(1);
}
