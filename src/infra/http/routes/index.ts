import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { healthcheckController } from '../controllers/healthcheck.controller.ts';
import { rebalanceController } from '../controllers/rebalance.controller.ts';

export async function routesPlugin(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // Healthcheck
  app.get('/healthcheck', healthcheckController);

  // Wallet
  app.post('/wallet/rebalance', rebalanceController);
}
