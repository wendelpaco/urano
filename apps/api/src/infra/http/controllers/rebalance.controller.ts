import { z } from 'zod';
import { tickerParamSchema } from '../../../shared/ticker-utils.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { wallets } from '../../database/schema.ts';
import {
  ExecuteRebalanceUseCase,
  MAX_REBALANCE_AMOUNT,
  MAX_REBALANCE_POSITION_QUANTITY,
  MAX_REBALANCE_POSITIONS,
  RebalanceValidationError,
} from '../../../core/use-cases/execute-rebalance.ts';

const bodySchema = z.object({
  availableAmount: z.number().finite().positive().max(MAX_REBALANCE_AMOUNT),
  currentPositions: z
    .array(
      z.object({
        ticker: tickerParamSchema,
        quantity: z
          .number()
          .finite()
          .nonnegative()
          .max(MAX_REBALANCE_POSITION_QUANTITY),
      }),
    )
    .max(MAX_REBALANCE_POSITIONS)
    .optional(),
});

const paramsSchema = z.object({
  walletId: z.string().uuid(),
});

/**
 * POST /v1/wallets/:walletId/rebalance
 *
 * Simula um aporte buy-only com base no valor disponivel.
 * Ativos acima da meta ficam em HOLD; este endpoint nao sugere vendas.
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
      message: 'Payload inválido para simulação de aporte.',
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

    if (error instanceof RebalanceValidationError) {
      reply.status(422).send({
        error: 'FinancialInvariantError',
        message: error.message,
      });
      return;
    }

    reply.status(500).send({
      error: 'InternalServerError',
      message: 'Falha interna ao processar o rebalanceamento.',
    });
  }
}
