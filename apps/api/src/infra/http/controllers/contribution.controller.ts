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

/** Reusa ranking em cache (rápido) antes de reanalisar o universo inteiro. */
async function universeFromRankingCache(): Promise<AdvisorAsset[] | null> {
  try {
    const [stockRaw, fiiRaw] = await Promise.all([
      redis.get('analysis:ranking:stock:100:none:score:desc'),
      redis.get('analysis:ranking:fii:100:none:score:desc'),
    ]);
    if (!stockRaw && !fiiRaw) return null;

    const mapRow = (
      r: Record<string, unknown>,
      assetType: 'stock' | 'fii',
    ): AdvisorAsset => ({
      ticker: String(r.ticker),
      name: String(r.name ?? r.ticker),
      score: Number(r.score ?? 0),
      price: Number(r.price ?? 0),
      reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
      alerts: Array.isArray(r.alerts) ? (r.alerts as string[]) : [],
      sector: (r.sector as string) ?? null,
      assetType,
    });

    const stocks = stockRaw
      ? ((JSON.parse(stockRaw) as { data?: Record<string, unknown>[] }).data ?? []).map((r) =>
          mapRow(r, 'stock'),
        )
      : [];
    const fiis = fiiRaw
      ? ((JSON.parse(fiiRaw) as { data?: Record<string, unknown>[] }).data ?? []).map((r) =>
          mapRow(r, 'fii'),
        )
      : [];

    const universe = [...stocks, ...fiis].filter((a) => a.price > 0 && a.score > 0);
    return universe.length > 0 ? universe : null;
  } catch {
    return null;
  }
}

async function loadUniverse(): Promise<AdvisorAsset[]> {
  try {
    const cached = await redis.get(UNIVERSE_CACHE_KEY);
    if (cached) return JSON.parse(cached) as AdvisorAsset[];
  } catch { /* Redis offline — segue sem cache */ }

  // Preferir ranking já aquecido (evita 502 por cold path pesado)
  const fromRanking = await universeFromRankingCache();
  if (fromRanking) {
    try {
      await redis.setex(UNIVERSE_CACHE_KEY, UNIVERSE_CACHE_TTL, JSON.stringify(fromRanking));
    } catch { /* ok */ }
    return fromRanking;
  }

  const engine = new AllocationEngine();
  const [stocks, fiis] = await Promise.all([
    engine.analyzeAllStocks(),
    engine.analyzeAllFiis(),
  ]);
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
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');
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
