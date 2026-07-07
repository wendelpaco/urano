import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ExecuteRebalanceUseCase } from '../../../core/use-cases/execute-rebalance.ts';

const rebalanceBodySchema = z.object({
  walletId: z.string().uuid(),
  availableAmount: z.number().positive(),
});

export async function rebalanceController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parseResult = rebalanceBodySchema.safeParse(request.body);

  if (!parseResult.success) {
    reply.status(400).send({
      error: 'ValidationError',
      message: 'Payload inválido para rebalanceamento.',
      details: parseResult.error.format(),
    });
    return;
  }

  try {
    const { walletId, availableAmount } = parseResult.data;

    const useCase = new ExecuteRebalanceUseCase();
    const result = useCase.execute({ walletId, availableAmount });

    reply.status(200).send(result);
  } catch (error) {
    request.log.error(error, 'Erro ao executar rebalanceamento');

    reply.status(500).send({
      error: 'InternalServerError',
      message: 'Falha interna ao processar o rebalanceamento.',
    });
  }
}
