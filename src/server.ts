import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import { env } from './config/env.ts';
import { routesPlugin } from './infra/http/routes/index.ts';

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

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`🚀 Urano API rodando em http://0.0.0.0:${env.PORT}`);
} catch (err) {
  app.log.error(err, 'Falha ao iniciar o servidor');
  process.exit(1);
}
