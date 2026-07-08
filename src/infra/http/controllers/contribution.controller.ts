import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AllocationEngine } from '../../../core/services/allocation-engine.ts';
import {
  suggestContribution,
  type AdvisorAsset,
} from '../../../core/services/contribution-advisor.ts';
import { deriveHealthWarnings } from '../../../core/services/data-health.ts';
import { fetchDataHealth } from '../../database/health-queries.ts';
import { redis } from '../../services/redis.ts';

const UNIVERSE_CACHE_KEY = 'advisor:universe';
const UNIVERSE_CACHE_TTL = 1800;

const bodySchema = z.object({
  amount: z.number().positive(),
  profile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado'),
  positions: z
    .array(z.object({ ticker: z.string().min(4), quantity: z.number().positive() }))
    .default([]),
  onlyTypes: z.array(z.enum(['stock', 'fii'])).min(1).optional(),
  excludeSectors: z.array(z.string()).optional(),
});

async function loadUniverse(): Promise<AdvisorAsset[]> {
  try {
    const cached = await redis.get(UNIVERSE_CACHE_KEY);
    if (cached) return JSON.parse(cached) as AdvisorAsset[];
  } catch { /* Redis offline — segue sem cache */ }

  const engine = new AllocationEngine();
  const [stocks, fiis] = [await engine.analyzeAllStocks(), await engine.analyzeAllFiis()];
  const universe: AdvisorAsset[] = [
    ...stocks.map((s) => ({ ...s, assetType: 'stock' as const })),
    ...fiis.map((f) => ({ ...f, assetType: 'fii' as const })),
  ];

  try {
    await redis.setex(UNIVERSE_CACHE_KEY, UNIVERSE_CACHE_TTL, JSON.stringify(universe));
  } catch { /* sem cache */ }

  return universe;
}

export async function contributionController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'BadRequest', message: parsed.error.issues[0]?.message });
    return;
  }
  const { amount, profile, positions, onlyTypes, excludeSectors } = parsed.data;

  // Data health primeiro: recomendação nunca sai silenciosa sobre base degradada
  let healthWarnings: string[] = [];
  try {
    healthWarnings = deriveHealthWarnings(await fetchDataHealth());
  } catch {
    healthWarnings = ['Não foi possível verificar a saúde dos dados — trate a sugestão com cautela'];
  }

  const universe = await loadUniverse();
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
