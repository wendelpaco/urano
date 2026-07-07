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

// Tratamento global de erros
app.setErrorHandler((error: FastifyError, _request, reply) => {
  app.log.error(error);

  if (error.validation) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Parâmetros da requisição inválidos.',
      details: error.validation,
    });
    return;
  }

  reply.status(error.statusCode ?? 500).send({
    error: 'InternalServerError',
    message: error.message ?? 'Erro interno do servidor.',
  });
});

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`🚀 Urano API rodando em http://0.0.0.0:${env.PORT}`);
} catch (err) {
  app.log.error(err, 'Falha ao iniciar o servidor');
  process.exit(1);
}
