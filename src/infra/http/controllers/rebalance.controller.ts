import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ExecuteRebalanceUseCase } from '../../../core/use-cases/execute-rebalance.ts';

const bodySchema = z.object({
  availableAmount: z.number().positive(),
});

const paramsSchema = z.object({
  walletId: z.string().uuid(),
});

/**
 * POST /v1/wallets/:walletId/rebalance
 *
 * Executa o rebalanceamento da carteira com base no valor disponível para aporte.
 * O walletId vem da rota; availableAmount do body.
 */
export async function rebalanceController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsResult = paramsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'walletId inválido na rota.',
      details: paramsResult.error.format(),
    });
    return;
  }

  const bodyResult = bodySchema.safeParse(request.body);
  if (!bodyResult.success) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Payload inválido. availableAmount deve ser um número positivo.',
      details: bodyResult.error.format(),
    });
    return;
  }

  try {
    const { walletId } = paramsResult.data;
    const { availableAmount } = bodyResult.data;

    const useCase = new ExecuteRebalanceUseCase();
    const result = await useCase.execute({ walletId, availableAmount });

    reply.status(200).send(result);
  } catch (error) {
    request.log.error(error, 'Erro ao executar rebalanceamento');

    reply.status(500).send({
      error: 'InternalServerError',
      message: 'Falha interna ao processar o rebalanceamento.',
    });
  }
}
