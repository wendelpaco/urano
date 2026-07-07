import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { wallets, walletAssets, companies } from '../../database/schema.ts';

// ─── Schemas ────────────────────────────────────────────────────────────────

const createWalletSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().min(1).max(100),
});

const updateWalletSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

const addAssetSchema = z.object({
  ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
  targetAllocationPercent: z.number().min(0).max(100),
});

const paramsSchema = z.object({
  walletId: z.string().uuid(),
});

const assetParamsSchema = z.object({
  walletId: z.string().uuid(),
  assetId: z.string().uuid(),
});

// ─── Controllers ────────────────────────────────────────────────────────────

/** POST /v1/wallets */
export async function createWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { userId, name } = createWalletSchema.parse(request.body);

  const [row] = await db
    .insert(wallets)
    .values({ userId, name })
    .returning();

  reply.status(201).send(row);
}

/** GET /v1/wallets?userId= */
export async function listWalletsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const querySchema = z.object({
    userId: z.string().uuid().optional(),
  });
  const { userId } = querySchema.parse(request.query);

  const rows = userId
    ? await db
        .select()
        .from(wallets)
        .where(eq(wallets.userId, userId))
        .orderBy(desc(wallets.createdAt))
    : await db
        .select()
        .from(wallets)
        .orderBy(desc(wallets.createdAt));
  reply.send({ total: rows.length, data: rows });
}

/** GET /v1/wallets/:walletId */
export async function getWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { walletId } = paramsSchema.parse(request.params);

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.id, walletId));

  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  // Busca os ativos da carteira com nome da empresa
  const assets = await db
    .select({
      id: walletAssets.id,
      ticker: walletAssets.ticker,
      targetAllocationPercent: walletAssets.targetAllocationPercent,
      companyName: companies.name,
      cnpj: companies.cnpj,
    })
    .from(walletAssets)
    .leftJoin(companies, eq(walletAssets.ticker, companies.ticker))
    .where(eq(walletAssets.walletId, walletId))
    .orderBy(walletAssets.ticker);

  reply.send({ ...wallet, assets });
}

/** PUT /v1/wallets/:walletId */
export async function updateWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { walletId } = paramsSchema.parse(request.params);
  const updates = updateWalletSchema.parse(request.body);

  const [row] = await db
    .update(wallets)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(wallets.id, walletId))
    .returning();

  if (!row) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  reply.send(row);
}

/** DELETE /v1/wallets/:walletId */
export async function deleteWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { walletId } = paramsSchema.parse(request.params);

  const [deleted] = await db
    .delete(wallets)
    .where(eq(wallets.id, walletId))
    .returning({ id: wallets.id });

  if (!deleted) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  reply.send({ message: 'Carteira removida.', id: deleted.id });
}

/** POST /v1/wallets/:walletId/assets */
export async function addAssetToWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { walletId } = paramsSchema.parse(request.params);
  const { ticker, targetAllocationPercent } = addAssetSchema.parse(request.body);

  // Verifica se a carteira existe
  const [wallet] = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, walletId));
  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  try {
    const [row] = await db
      .insert(walletAssets)
      .values({
        walletId,
        ticker,
        targetAllocationPercent: String(targetAllocationPercent),
      })
      .onConflictDoUpdate({
        target: [walletAssets.walletId, walletAssets.ticker],
        set: {
          targetAllocationPercent: String(targetAllocationPercent),
          updatedAt: new Date(),
        },
      })
      .returning();

    reply.status(201).send(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('chk_allocation_range')) {
      reply.status(400).send({ error: 'ValidationError', message: 'targetAllocationPercent deve estar entre 0 e 100.' });
      return;
    }
    throw err;
  }
}

/** DELETE /v1/wallets/:walletId/assets/:assetId */
export async function removeAssetFromWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { walletId, assetId } = assetParamsSchema.parse(request.params);

  const [deleted] = await db
    .delete(walletAssets)
    .where(and(eq(walletAssets.id, assetId), eq(walletAssets.walletId, walletId)))
    .returning({ id: walletAssets.id });

  if (!deleted) {
    reply.status(404).send({ error: 'NotFound', message: 'Ativo não encontrado na carteira.' });
    return;
  }

  reply.send({ message: 'Ativo removido da carteira.', id: deleted.id });
}
