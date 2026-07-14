import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { wallets } from '../../database/schema.ts';
import { ExecuteRebalanceUseCase } from '../../../core/use-cases/execute-rebalance.ts';

const bodySchema = z.object({
  availableAmount: z.number().positive(),
  currentPositions: z
    .array(
      z.object({
        ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
        quantity: z.number().nonnegative(),
      }),
    )
    .optional(),
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

  const { walletId } = paramsResult.data;

  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  try {
    const { availableAmount, currentPositions } = bodyResult.data;

    const useCase = new ExecuteRebalanceUseCase();
    const result = await useCase.execute({ walletId, availableAmount, currentPositions });

    reply.status(200).send(result);
  } catch (error) {
    request.log.error(error, 'Erro ao executar rebalanceamento');

    reply.status(500).send({
      error: 'InternalServerError',
      message: 'Falha interna ao processar o rebalanceamento.',
    });
  }
}
