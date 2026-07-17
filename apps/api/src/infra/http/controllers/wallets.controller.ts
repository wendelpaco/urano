import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tickerParamSchema } from '../../../shared/ticker-utils.ts';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { wallets, walletAssets, companies } from '../../database/schema.ts';
import { logSecurityEvent } from '../audit-log.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({
      path: path.join('.'),
      message: m,
    })),
  });
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const createWalletSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateWalletSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

const addAssetSchema = z.object({
  ticker: tickerParamSchema,
  targetAllocationPercent: z.number().min(0).max(100).optional().default(0),
  /** Quantidade em custódia (cotas/ações). Opcional. */
  quantity: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
});

const updateAssetSchema = z.object({
  targetAllocationPercent: z.number().min(0).max(100).optional(),
  quantity: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
}).refine(
  (v) => v.targetAllocationPercent !== undefined || v.quantity !== undefined,
  { message: 'Informe targetAllocationPercent e/ou quantity.' },
);

const paramsSchema = z.object({
  walletId: z.string().uuid(),
});

const assetParamsSchema = z.object({
  walletId: z.string().uuid(),
  assetId: z.string().uuid(),
});

function qtyToDb(q: number | null | undefined): string | null | undefined {
  if (q === undefined) return undefined;
  if (q === null) return null;
  return String(q);
}

function qtyFromDb(q: string | null | undefined): number | null {
  if (q == null || q === '') return null;
  const n = Number(q);
  return Number.isFinite(n) ? n : null;
}

// ─── Controllers ────────────────────────────────────────────────────────────

/** POST /v1/wallets */
export async function createWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createWalletSchema.safeParse(request.body);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Payload inválido.');

  const { name } = parsed.data;

  const [row] = await db
    .insert(wallets)
    .values({ userId: request.apiKeyId!, name })
    .returning();

  logSecurityEvent('wallet.create', { walletId: row!.id, apiKeyId: request.apiKeyId });

  reply.status(201).send(row);
}

/** GET /v1/wallets */
export async function listWalletsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rows = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, request.apiKeyId!))
    .orderBy(desc(wallets.createdAt));
  reply.send({ total: rows.length, data: rows });
}

/** GET /v1/wallets/:walletId */
export async function getWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'walletId inválido.');

  const { walletId } = parsed.data;

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));

  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  // Busca os ativos da carteira com nome da empresa + quantidade
  const rows = await db
    .select({
      id: walletAssets.id,
      ticker: walletAssets.ticker,
      targetAllocationPercent: walletAssets.targetAllocationPercent,
      quantity: walletAssets.quantity,
      companyName: companies.name,
      cnpj: companies.cnpj,
    })
    .from(walletAssets)
    .leftJoin(companies, eq(walletAssets.ticker, companies.ticker))
    .where(eq(walletAssets.walletId, walletId))
    .orderBy(walletAssets.ticker);

  const assets = rows.map((r) => ({
    ...r,
    quantity: qtyFromDb(r.quantity as string | null),
    targetAllocationPercent: r.targetAllocationPercent != null
      ? Number(r.targetAllocationPercent)
      : 0,
  }));

  reply.send({ ...wallet, assets, positions: assets });
}

/** PUT /v1/wallets/:walletId */
export async function updateWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'walletId inválido.');

  const bodyParsed = updateWalletSchema.safeParse(request.body);
  if (!bodyParsed.success) return sendZodError(reply, bodyParsed.error, 'Payload inválido.');

  const { walletId } = paramsParsed.data;
  const updates = bodyParsed.data;

  const [row] = await db
    .update(wallets)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)))
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
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'walletId inválido.');

  const { walletId } = parsed.data;

  const [deleted] = await db
    .delete(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)))
    .returning({ id: wallets.id });

  if (!deleted) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  logSecurityEvent('wallet.delete', { walletId: deleted.id, apiKeyId: request.apiKeyId });

  reply.send({ message: 'Carteira removida.', id: deleted.id });
}

/** POST /v1/wallets/:walletId/assets */
export async function addAssetToWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'walletId inválido.');

  const bodyParsed = addAssetSchema.safeParse(request.body);
  if (!bodyParsed.success) return sendZodError(reply, bodyParsed.error, 'Payload inválido.');

  const { walletId } = paramsParsed.data;
  const { ticker, targetAllocationPercent, quantity } = bodyParsed.data;

  // Verifica se a carteira existe e pertence à chave autenticada
  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

  try {
    const qtyDb = qtyToDb(quantity);
    const setOnConflict: {
      targetAllocationPercent: string;
      updatedAt: Date;
      quantity?: string | null;
    } = {
      targetAllocationPercent: String(targetAllocationPercent),
      updatedAt: new Date(),
    };
    if (qtyDb !== undefined) setOnConflict.quantity = qtyDb;

    const [row] = await db
      .insert(walletAssets)
      .values({
        walletId,
        ticker,
        targetAllocationPercent: String(targetAllocationPercent),
        ...(qtyDb !== undefined ? { quantity: qtyDb } : {}),
      })
      .onConflictDoUpdate({
        target: [walletAssets.walletId, walletAssets.ticker],
        set: setOnConflict,
      })
      .returning();

    reply.status(201).send({
      ...row,
      quantity: qtyFromDb(row?.quantity as string | null),
      targetAllocationPercent: row?.targetAllocationPercent != null
        ? Number(row.targetAllocationPercent)
        : 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('chk_allocation_range')) {
      reply.status(400).send({ error: 'ValidationError', message: 'targetAllocationPercent deve estar entre 0 e 100.' });
      return;
    }
    if (message.includes('chk_wallet_asset_quantity_nonneg')) {
      reply.status(400).send({ error: 'ValidationError', message: 'quantity deve ser >= 0.' });
      return;
    }
    throw err;
  }
}

/**
 * PATCH /v1/wallets/:walletId/assets/:assetId
 * Atualiza % alvo e/ou quantidade de custódia.
 */
export async function updateAssetInWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = assetParamsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Parâmetros de rota inválidos.');

  const bodyParsed = updateAssetSchema.safeParse(request.body);
  if (!bodyParsed.success) return sendZodError(reply, bodyParsed.error, 'Payload inválido.');

  const { walletId, assetId } = paramsParsed.data;
  const { targetAllocationPercent, quantity } = bodyParsed.data;

  // Ownership: join via wallet
  const [owned] = await db
    .select({ assetId: walletAssets.id })
    .from(walletAssets)
    .innerJoin(wallets, eq(walletAssets.walletId, wallets.id))
    .where(and(
      eq(walletAssets.id, assetId),
      eq(walletAssets.walletId, walletId),
      eq(wallets.userId, request.apiKeyId!),
    ));

  if (!owned) {
    reply.status(404).send({ error: 'NotFound', message: 'Ativo ou carteira não encontrado.' });
    return;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (targetAllocationPercent !== undefined) {
    patch.targetAllocationPercent = String(targetAllocationPercent);
  }
  if (quantity !== undefined) {
    patch.quantity = qtyToDb(quantity);
  }

  try {
    const [row] = await db
      .update(walletAssets)
      .set(patch)
      .where(and(eq(walletAssets.id, assetId), eq(walletAssets.walletId, walletId)))
      .returning();

    reply.send({
      ...row,
      quantity: qtyFromDb(row?.quantity as string | null),
      targetAllocationPercent: row?.targetAllocationPercent != null
        ? Number(row.targetAllocationPercent)
        : 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('chk_allocation_range')) {
      reply.status(400).send({ error: 'ValidationError', message: 'targetAllocationPercent deve estar entre 0 e 100.' });
      return;
    }
    if (message.includes('chk_wallet_asset_quantity_nonneg')) {
      reply.status(400).send({ error: 'ValidationError', message: 'quantity deve ser >= 0.' });
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
  const parsed = assetParamsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Parâmetros de rota inválidos.');

  const { walletId, assetId } = parsed.data;

  // Verifica se a carteira existe e pertence à chave autenticada antes de
  // tocar no ativo — nunca vaza a existência da carteira de outra chave.
  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }

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
