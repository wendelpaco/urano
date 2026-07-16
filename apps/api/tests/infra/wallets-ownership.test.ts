import { and, eq, or } from 'drizzle-orm';
import { describe, expect, mock, test } from 'bun:test';
import { wallets } from '../../src/infra/database/schema.ts';

// Estas controllers consultam o módulo real de `db` diretamente; esta suíte
// troca `db` por um fake instrumentado por teste (mesmo padrão usado em
// auth-key-id.test.ts) e verifica DUAS coisas para cada rota:
//
//   1. Comportamento: quando o db (que na vida real já filtraria por
//      eq(wallets.userId, apiKeyId)) não devolve linha, a controller responde
//      404 — nunca vaza a existência da carteira de outra chave.
//   2. Forma da query: a controller de fato CONSTRÓI o predicado de
//      ownership (eq(wallets.userId, request.apiKeyId)) — não apenas que ela
//      se comportaria bem SE o banco filtrasse. Isso é feito inspecionando a
//      árvore SQL que o drizzle monta internamente para o argumento passado a
//      `.where(...)`, extraindo os pares coluna=valor de cada `eq(...)`
//      combinado por `and(...)`. Isso garante que o teste FALHARIA caso o
//      guard de ownership fosse removido do código, mesmo que o fake db
//      sempre devolvesse uma linha.

const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WALLET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ASSET_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ─── Helper: extrai pares coluna=valor de uma árvore SQL do drizzle ────────
// Um `and(eq(colA, valA), eq(colB, valB))` produz um objeto SQL cujo
// `queryChunks` contém, em sequência, o PgColumn de cada lado e um `Param`
// com o valor do bind. Percorremos recursivamente para achar todos os pares.
interface EqPair {
  column: string;
  value: unknown;
}

function extractEqPairs(node: unknown, pairs: EqPair[] = []): EqPair[] {
  if (!node || typeof node !== 'object') return pairs;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as { name?: string; constructor?: { name?: string } };
      const ctorName = chunk?.constructor?.name ?? '';
      const looksLikeColumn = ctorName.startsWith('Pg') && typeof chunk?.name === 'string';
      if (looksLikeColumn) {
        for (let j = i + 1; j < chunks.length; j++) {
          const maybeParam = chunks[j] as { value?: unknown; constructor?: { name?: string } };
          if (maybeParam?.constructor?.name === 'Param') {
            pairs.push({ column: chunk.name as string, value: maybeParam.value });
            break;
          }
        }
      }
      extractEqPairs(chunk, pairs);
    }
  }
  return pairs;
}

// ─── Helper: extrai os combinadores booleanos (`and`/`or`) de uma árvore SQL ──
// `extractEqPairs` sozinho não basta: `and(eq(wallets.id, X), eq(wallets.userId, Y))`
// e `or(eq(wallets.id, X), eq(wallets.userId, Y))` produzem exatamente os
// mesmos pares coluna=valor — só o combinador na árvore muda. Um `or` aqui
// permitiria que qualquer chamador que adivinhasse um walletId passasse pelo
// guard de ownership (o match do id sozinho já satisfaria o `or`), então o
// combinador precisa ser verificado explicitamente. No drizzle-orm@0.45.2
// (versão pinada no bun.lock deste repo) o `and`/`or` aparece como um
// `StringChunk` cujo `.value` é `[" and "]` ou `[" or "]`, como irmão dos dois
// sub-nós `SQL` de cada `eq(...)` dentro de `queryChunks`.
function extractCombinators(node: unknown, combinators: string[] = []): string[] {
  if (!node || typeof node !== 'object') return combinators;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const ctorName = (chunk as { constructor?: { name?: string } })?.constructor?.name ?? '';
      if (ctorName === 'StringChunk') {
        const value = (chunk as { value?: unknown[] }).value;
        const text = Array.isArray(value) ? String(value[0] ?? '').trim().toLowerCase() : '';
        if (text === 'and' || text === 'or') combinators.push(text);
      }
      extractCombinators(chunk, combinators);
    }
  }
  return combinators;
}

function expectOwnershipPredicate(whereArg: unknown, expectedWalletId: string, expectedApiKeyId: string): void {
  const pairs = extractEqPairs(whereArg);
  expect(pairs).toContainEqual({ column: 'id', value: expectedWalletId });
  expect(pairs).toContainEqual({ column: 'user_id', value: expectedApiKeyId });

  // Regressão V-02: garante que as duas condições acima estão combinadas por
  // `and`, não `or` — os pares coluna=valor por si só não distinguem os dois
  // casos (veja o comentário de `extractCombinators`).
  const combinators = extractCombinators(whereArg);
  expect(combinators).toContain('and');
  expect(combinators).not.toContain('or');
}

// ─── Fake db instrumentado ──────────────────────────────────────────────────
// Cada chamada a `.where(...)` (via select/update/delete) é registrada em
// `captured`, na ordem em que ocorre, e devolve o próximo item de
// `returnsQueue` (ou `[]` se a fila acabou).
interface Captured {
  op: 'select' | 'update' | 'delete';
  whereArg: unknown;
}

function makeInstrumentedDb(returnsQueue: unknown[][]) {
  const captured: Captured[] = [];
  let i = 0;
  const next = () => returnsQueue[i++] ?? [];

  const db = {
    select: () => ({
      from: () => ({
        // `where()` is used both as a directly-awaited terminal (most
        // queries) and chained with `.orderBy()` (listWalletsController).
        // Return a thenable that also exposes `.orderBy()` so both styles
        // work against the same fake.
        where: (whereArg: unknown) => {
          captured.push({ op: 'select', whereArg });
          const rows = next();
          return {
            then: (resolve: (v: unknown) => void) => resolve(rows),
            orderBy: async () => rows,
          };
        },
        leftJoin: () => ({ where: () => ({ orderBy: async () => next() }) }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => next() }) }),
    update: () => ({
      set: () => ({
        where: (whereArg: unknown) => ({
          returning: async () => {
            captured.push({ op: 'update', whereArg });
            return next();
          },
        }),
      }),
    }),
    delete: () => ({
      where: (whereArg: unknown) => ({
        returning: async () => {
          captured.push({ op: 'delete', whereArg });
          return next();
        },
      }),
    }),
  };

  return { db, captured };
}

function mockConnectionWith(db: unknown) {
  mock.module('../../src/infra/database/connection.ts', () => ({
    db,
    checkDatabaseConnection: async () => {},
    closeDatabaseConnection: async () => {},
  }));
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeReply() {
  let captured: CapturedResponse | null = null;
  const reply = {
    status(code: number) {
      return {
        send(body: unknown) {
          captured = { status: code, body };
        },
      };
    },
    send(body: unknown) {
      captured = { status: 200, body };
    },
  };
  return { reply, getCaptured: () => captured };
}

describe('getWalletController — ownership guard', () => {
  test('builds a where predicate scoped to (walletId, apiKeyId) and returns 404 when nothing matches', async () => {
    const { db, captured } = makeInstrumentedDb([[]]); // select().where() -> no row
    mockConnectionWith(db);
    const { getWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await getWalletController({ params: { walletId: WALLET_ID }, apiKeyId: OTHER } as never, reply as never);

    expect(getCaptured()?.status).toBe(404);
    expect(captured.length).toBeGreaterThan(0);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });

  test('returns 200 with the wallet and its assets when the caller owns it', async () => {
    const walletRow = { id: WALLET_ID, userId: OWNER, name: 'Minha carteira' };
    const { db, captured } = makeInstrumentedDb([[walletRow], []]);
    mockConnectionWith(db);
    const { getWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await getWalletController({ params: { walletId: WALLET_ID }, apiKeyId: OWNER } as never, reply as never);

    expect(getCaptured()?.status).toBe(200);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OWNER);
  });
});

describe('updateWalletController — ownership guard', () => {
  test('scopes the UPDATE to (walletId, apiKeyId) and returns 404 when it matches no row', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { updateWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await updateWalletController(
      { params: { walletId: WALLET_ID }, body: { name: 'novo nome' }, apiKeyId: OTHER } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(404);
    expect(captured[0]!.op).toBe('update');
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });

  test('returns 200 when the caller owns the wallet', async () => {
    const updated = { id: WALLET_ID, userId: OWNER, name: 'novo nome' };
    const { db, captured } = makeInstrumentedDb([[updated]]);
    mockConnectionWith(db);
    const { updateWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await updateWalletController(
      { params: { walletId: WALLET_ID }, body: { name: 'novo nome' }, apiKeyId: OWNER } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(200);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OWNER);
  });
});

describe('deleteWalletController — ownership guard', () => {
  test('scopes the DELETE to (walletId, apiKeyId) and returns 404 when it matches no row', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { deleteWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await deleteWalletController({ params: { walletId: WALLET_ID }, apiKeyId: OTHER } as never, reply as never);

    expect(getCaptured()?.status).toBe(404);
    expect(captured[0]!.op).toBe('delete');
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });

  test('returns 200 when the caller owns the wallet', async () => {
    const { db, captured } = makeInstrumentedDb([[{ id: WALLET_ID }]]);
    mockConnectionWith(db);
    const { deleteWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await deleteWalletController({ params: { walletId: WALLET_ID }, apiKeyId: OWNER } as never, reply as never);

    expect(getCaptured()?.status).toBe(200);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OWNER);
  });
});

describe('addAssetToWalletController — ownership guard', () => {
  test('the wallet-existence check is scoped to (walletId, apiKeyId); 404 when caller is not the owner', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { addAssetToWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await addAssetToWalletController(
      {
        params: { walletId: WALLET_ID },
        body: { ticker: 'PETR4', targetAllocationPercent: 10 },
        apiKeyId: OTHER,
      } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(404);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });
});

describe('removeAssetFromWalletController — ownership guard', () => {
  test('checks wallet ownership before deleting the asset; 404 when caller is not the owner (never touches walletAssets)', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { removeAssetFromWalletController } = await import(
      '../../src/infra/http/controllers/wallets.controller.ts'
    );
    const { reply, getCaptured } = fakeReply();

    await removeAssetFromWalletController(
      { params: { walletId: WALLET_ID, assetId: ASSET_ID }, apiKeyId: OTHER } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(404);
    // Apenas UMA operação deve ter ocorrido: o select de ownership. O
    // delete do asset não deve ter sido alcançado.
    expect(captured.length).toBe(1);
    expect(captured[0]!.op).toBe('select');
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });

  test('deletes the asset once wallet ownership is confirmed', async () => {
    const { db, captured } = makeInstrumentedDb([[{ id: WALLET_ID }], [{ id: ASSET_ID }]]);
    mockConnectionWith(db);
    const { removeAssetFromWalletController } = await import(
      '../../src/infra/http/controllers/wallets.controller.ts'
    );
    const { reply, getCaptured } = fakeReply();

    await removeAssetFromWalletController(
      { params: { walletId: WALLET_ID, assetId: ASSET_ID }, apiKeyId: OWNER } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(200);
    expect(captured[0]!.op).toBe('select');
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OWNER);
    expect(captured[1]!.op).toBe('delete');
  });
});

describe('listWalletsController — always scoped to the caller', () => {
  test('ignores any client-supplied userId and filters by request.apiKeyId only', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { listWalletsController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    // Um client tentando se passar por outra chave via query string.
    await listWalletsController({ query: { userId: OTHER }, apiKeyId: OWNER } as never, reply as never);

    expect(getCaptured()?.status).toBe(200);
    const pairs = extractEqPairs(captured[0]!.whereArg);
    expect(pairs).toContainEqual({ column: 'user_id', value: OWNER });
    expect(pairs).not.toContainEqual({ column: 'user_id', value: OTHER });
  });
});

describe('createWalletController — never trusts a client-supplied userId', () => {
  test('derives the wallet owner from request.apiKeyId, ignoring any userId in the body', async () => {
    const { db, captured } = makeInstrumentedDb([]);
    // Wallet create + security audit both call db.insert. Capture only the
    // wallet row (has userId); ignore audit_log inserts.
    let insertedValues: unknown;
    (db as { insert: unknown }).insert = () => ({
      values: (values: unknown) => {
        if (values && typeof values === 'object' && 'userId' in (values as object)) {
          insertedValues = values;
        }
        return { returning: async () => [{ id: WALLET_ID, ...(values as object) }] };
      },
    });
    mockConnectionWith(db);
    const { createWalletController } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await createWalletController(
      { body: { name: 'Carteira nova', userId: OTHER }, apiKeyId: OWNER } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(201);
    expect((insertedValues as { userId: string }).userId).toBe(OWNER);
    void captured;
  });
});

describe('rebalanceController — ownership guard', () => {
  test('rejeita limites não finitos/excessivos antes de consultar a carteira', async () => {
    const { db, captured } = makeInstrumentedDb([]);
    mockConnectionWith(db);
    const { rebalanceController } = await import('../../src/infra/http/controllers/rebalance.controller.ts');

    const invalidBodies = [
      { availableAmount: Number.POSITIVE_INFINITY },
      {
        availableAmount: 1_000,
        currentPositions: [{ ticker: 'AAAA3', quantity: 1_000_000_001 }],
      },
      {
        availableAmount: 1_000,
        currentPositions: Array.from(
          { length: 101 },
          () => ({ ticker: 'AAAA3', quantity: 1 }),
        ),
      },
    ];

    for (const body of invalidBodies) {
      const { reply, getCaptured } = fakeReply();
      await rebalanceController(
        {
          params: { walletId: WALLET_ID },
          body,
          apiKeyId: OWNER,
          log: { error: () => {} },
        } as never,
        reply as never,
      );
      expect(getCaptured()?.status).toBe(400);
    }

    expect(captured).toHaveLength(0);
  });

  test('returns 404 before executing any rebalance when the wallet is not owned by the caller', async () => {
    const { db, captured } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { rebalanceController } = await import('../../src/infra/http/controllers/rebalance.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await rebalanceController(
      {
        params: { walletId: WALLET_ID },
        body: { availableAmount: 1000 },
        apiKeyId: OTHER,
        log: { error: () => {} },
      } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(404);
    expect(captured.length).toBe(1);
    expectOwnershipPredicate(captured[0]!.whereArg, WALLET_ID, OTHER);
  });

  test('returns 404 when the wallet does not exist at all (previously fell through to a 500)', async () => {
    const { db } = makeInstrumentedDb([[]]);
    mockConnectionWith(db);
    const { rebalanceController } = await import('../../src/infra/http/controllers/rebalance.controller.ts');
    const { reply, getCaptured } = fakeReply();

    await rebalanceController(
      {
        params: { walletId: WALLET_ID },
        body: { availableAmount: 1000 },
        apiKeyId: OWNER,
        log: { error: () => {} },
      } as never,
      reply as never,
    );

    expect(getCaptured()?.status).toBe(404);
  });
});

describe('expectOwnershipPredicate — combinator hardening (regressão V-02)', () => {
  test('accepts a genuine and(...) predicate combining wallet id and owner', () => {
    const predicate = and(eq(wallets.id, WALLET_ID), eq(wallets.userId, OWNER));
    expect(() => expectOwnershipPredicate(predicate, WALLET_ID, OWNER)).not.toThrow();
  });

  test('rejects an or(...) predicate even though both column=value pairs are present', () => {
    // Um `and(...)` trocado por `or(...)` num controller faria qualquer
    // requisição que apenas acertasse o walletId passar pelo guard de
    // ownership, sem precisar ser o dono de fato — o match do id sozinho já
    // satisfaz o `or`. `extractEqPairs` sozinho não pegaria essa regressão:
    // os pares extraídos de `or(eq(wallets.id, X), eq(wallets.userId, Y))`
    // são idênticos aos de `and(...)`. Este teste prova que o helper
    // reforçado (via `extractCombinators`) de fato rejeita esse caso.
    const predicate = or(eq(wallets.id, WALLET_ID), eq(wallets.userId, OWNER));
    expect(() => expectOwnershipPredicate(predicate, WALLET_ID, OWNER)).toThrow();
  });
});
