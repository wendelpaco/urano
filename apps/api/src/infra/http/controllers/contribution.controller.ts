import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AllocationDataUnavailableError,
  loadCanonicalDecisionUniverse,
} from '../../../core/services/allocation-engine.ts';
import {
  MAX_CONTRIBUTION_AMOUNT,
  suggestContribution,
  type AdvisorAsset,
} from '../../../core/services/contribution-advisor.ts';
import { deriveHealthWarnings } from '../../../core/services/data-health.ts';
import { fetchDataHealth } from '../../database/health-queries.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendZodError(
  reply: FastifyReply,
  error: z.ZodError,
  message: string,
): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({
      path: path.join('.'),
      message: m,
    })),
  });
}

const bodySchema = z.object({
  amount: z.number().finite().positive().max(MAX_CONTRIBUTION_AMOUNT),
  profile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado'),
  positions: z
    .array(z.object({
      ticker: z.string().min(4).max(20),
      quantity: z.number().finite().positive().max(1_000_000_000),
    }))
    .max(1_000)
    .default([]),
  onlyTypes: z.array(z.enum(['stock', 'fii'])).min(1).optional(),
  excludeSectors: z.array(z.string()).optional(),
});

async function loadUniverse(): Promise<{
  universe: AdvisorAsset[];
  warnings: string[];
}> {
  // Contenção de latência: jamais inicia centenas de chamadas externas
  // dentro da requisição. Rankings HTTP parciais não são fonte de decisão;
  // sem snapshot canônico completo, responde 503 rapidamente.
  const { stocks, fiis, availability } = await loadCanonicalDecisionUniverse();
  const universe: AdvisorAsset[] = [
    ...stocks.map((s) => ({ ...s, assetType: 'stock' as const })),
    ...fiis.map((f) => ({ ...f, assetType: 'fii' as const })),
  ];

  return { universe, warnings: availability.warnings };
}

export async function contributionController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');
  const { amount, profile, positions, onlyTypes, excludeSectors } = parsed.data;

  // Data health primeiro: recomendação nunca sai silenciosa sobre base degradada
  let healthWarnings: string[] = [];
  try {
    healthWarnings = deriveHealthWarnings(await fetchDataHealth());
  } catch {
    healthWarnings = ['Não foi possível verificar a saúde dos dados — trate a sugestão com cautela'];
  }

  let universe: AdvisorAsset[];
  try {
    const canonical = await loadUniverse();
    universe = canonical.universe;
    healthWarnings.push(...canonical.warnings);
  } catch (error) {
    if (error instanceof AllocationDataUnavailableError) {
      reply.status(503).send({
        error: 'CanonicalDataUnavailable',
        message: error.message,
      });
      return;
    }
    throw error;
  }
  const suggestion = suggestContribution(
    universe,
    positions,
    { amount, profile, onlyTypes, excludeSectors },
    healthWarnings,
  );

  reply.send({
    amount,
    profile,
    generatedAt: new Date().toISOString(),
    ...suggestion,
  });
}
