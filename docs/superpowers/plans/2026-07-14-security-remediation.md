# Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 13 findings from the 2026-07-14 security audit (`docs/superpowers/plans/../` audit artifact, referenced here as V-01..V-13), starting with the critical authentication/authorization bypass chain.

**Architecture:** No new services or dependencies. Fixes are: (a) tightening `apps/api`'s existing auth middleware and route handlers to enforce per-key ownership, (b) a schema change to make `wallets.userId` an authenticated-key-derived FK instead of client-supplied input, (c) hashing stored API keys, (d) hardening `docker-compose.yml`, (e) small frontend/CLI/CI hardening items.

**Tech Stack:** Fastify, Drizzle ORM/drizzle-kit (migrations), Bun test, Node `crypto` (sha256, timingSafeEqual), GitHub Actions (new CI workflow).

## Global Constraints

- Every finding fixed in this plan must keep `apps/api`'s existing 71 tests passing, plus new tests for the fixed behavior — never reduce coverage.
- Never require existing, already-issued API keys to be regenerated. V-06's hashing migration must accept currently-plaintext key values as-is (hash them in place), so no key holder is locked out.
- New authorization failures (caller authenticated but not the owner of the resource) return **404 Not Found** — the same shape already used in this codebase for missing resources (see `wallets.controller.ts`'s existing `reply.status(404).send({ error: 'NotFound', ... })` pattern) — never 403. This avoids confirming a given UUID exists to a caller who doesn't own it.
- `request.apiKeyId` (the authenticated key's `api_keys.id`, a UUID) is the single source of truth for "who is calling" everywhere in this plan — never trust a client-supplied `userId`/`ownerId`/key `id` in a body or query string for authorization decisions.
- The `apps/api/tests/infra/auth-fail-closed.test.ts` test (fail-closed-on-DB-outage, fixed in a prior session) must keep passing unmodified — its `mock.module` setup for `../../src/infra/services/redis.ts` and `../../src/infra/database/connection.ts` is the established pattern for auth-middleware unit tests in this repo; reuse it, don't reinvent.
- Current DB state has 0 rows in `wallets` and 4 rows in `api_keys` (dev environment) — no backfill/data-migration script is needed for the `wallets` ownership change, but the migration must still be written as a proper `drizzle-kit` migration (not a hand-edited SQL file) so it works correctly against any environment, including ones with existing wallet rows (in which case the migration will fail on the `NOT NULL`+FK addition — that's acceptable and expected: this plan does not need to handle backfilling other people's already-existing multi-row wallet data, since the project's own current dev DB has none).

---

### Task 1: Auth middleware exposes `request.apiKeyId`; `/v1/keys` creation requires auth (V-01)

**Files:**
- Modify: `apps/api/src/infra/http/middleware/auth.ts`
- Test: `apps/api/tests/infra/auth-fail-closed.test.ts` (existing — must still pass), `apps/api/tests/infra/auth-key-id.test.ts` (new)

**Interfaces:**
- Produces: `FastifyRequest.apiKeyId: string` — set by `authMiddleware` on every successful auth (both the Redis-cache-hit path and the DB-lookup path), read by every controller in Tasks 2-3.
- Produces: `PUBLIC_ROUTES` no longer includes `/v1/keys` — `POST /v1/keys` now requires `x-api-key` like every other route.

- [ ] **Step 1: Add the Fastify type augmentation**

In `apps/api/src/infra/http/middleware/auth.ts`, add near the top (after imports):

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
  }
}
```

- [ ] **Step 2: Write the failing test for `apiKeyId` propagation**

Create `apps/api/tests/infra/auth-key-id.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';

mock.module('../../src/infra/services/redis.ts', () => ({
  redis: {
    get: async () => null, // cache miss, forces DB lookup path
    setex: async () => {},
  },
  checkRedisConnection: async () => true,
  getOrSet: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
}));

mock.module('../../src/infra/database/connection.ts', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ key: 'ur_test', active: true, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  },
  checkDatabaseConnection: async () => {},
  closeDatabaseConnection: async () => {},
}));

const { authMiddleware } = await import('../../src/infra/http/middleware/auth.ts');

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
  };
  return { reply, getCaptured: () => captured };
}

function fakeRequest(url: string, key?: string): { url: string; method: string; headers: Record<string, string>; apiKeyId?: string } {
  return { url, method: 'GET', headers: key ? { 'x-api-key': key } : {} };
}

describe('authMiddleware — sets request.apiKeyId', () => {
  test('attaches the authenticated key id to the request on success', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = fakeRequest('/v1/wallets', 'ur_test');

    await authMiddleware(request as never, reply as never);

    expect(getCaptured()).toBeNull(); // not rejected
    expect(request.apiKeyId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd apps/api && bun test tests/infra/auth-key-id.test.ts
```

Expected: FAIL — `request.apiKeyId` is `undefined` (the middleware doesn't set it yet).

- [ ] **Step 4: Select `id` in the query, cache it, and attach it in both success paths**

In `apps/api/src/infra/http/middleware/auth.ts`, change the Redis cache-hit branch so a valid key's cached value is its **id** (a UUID string) instead of the literal string `'true'` — the two cache states stay distinguishable because `'false'` (the negative-cache sentinel) can never equal a UUID. Find the existing try block:

```typescript
  // Cache Redis: verifica se key é válida
  try {
    const valid = await redis.get(`apikey:valid:${key}`);
    if (valid === 'true') {
      // Atualiza last_used_at em background (fire-and-forget)
      updateLastUsed(key).catch(() => {});
      return;
    }
    if (valid === 'false') {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }
  } catch {
    // Redis offline → fallback para banco
  }
```

Replace it with:

```typescript
  try {
    const cached = await redis.get(`apikey:valid:${key}`);
    if (cached === 'false') {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key inválida ou inativa.',
      });
      return;
    }
    if (cached) {
      // Valid key: cached value is the apiKeyId (uuid), not a boolean.
      request.apiKeyId = cached;
      updateLastUsed(key).catch(() => {});
      return;
    }
  } catch {
    // Redis offline → fallback para banco
  }
```

Then find the DB-lookup block:

```typescript
  let row: { key: string; active: boolean } | undefined;
  try {
    const result = await db
      .select({ key: apiKeys.key, active: apiKeys.active })
      .from(apiKeys)
      .where(and(eq(apiKeys.key, key), eq(apiKeys.active, true)));
    row = result[0];
```

Replace with:

```typescript
  let row: { key: string; active: boolean; id: string } | undefined;
  try {
    const result = await db
      .select({ key: apiKeys.key, active: apiKeys.active, id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.key, key), eq(apiKeys.active, true)));
    row = result[0];
```

And find the positive-cache block near the end:

```typescript
  // Cache positivo (60s)
  try {
    await redis.setex(`apikey:valid:${key}`, 60, 'true');
  } catch { /* ok */ }

  // Atualiza last_used_at em background
  updateLastUsed(key).catch(() => {});
```

Replace with:

```typescript
  request.apiKeyId = row.id;

  // Cache positivo (60s) — guarda o id, não um booleano
  try {
    await redis.setex(`apikey:valid:${key}`, 60, row.id);
  } catch { /* ok */ }

  // Atualiza last_used_at em background
  updateLastUsed(key).catch(() => {});
```

- [ ] **Step 5: Run the new test and the full suite**

```bash
cd apps/api && bun test tests/infra/auth-key-id.test.ts && bun test
```

Expected: new test PASSES; full suite still 71/71 (the `auth-fail-closed.test.ts` mock's DB `where` throws before reaching this code, so it's unaffected).

- [ ] **Step 6: Remove `/v1/keys` from `PUBLIC_ROUTES` (V-01)**

In `apps/api/src/infra/http/middleware/auth.ts`, change:

```typescript
// Rotas públicas: healthcheck + criação de key (para bootstrap)
const PUBLIC_ROUTES = new Set(['/v1/healthcheck', '/v1/keys']);

function isPublicRoute(url: string): boolean {
  // /v1/keys só é público para POST (criação); GET e DELETE exigem auth
  if (url === '/v1/keys') return true;
  return PUBLIC_ROUTES.has(url);
}
```

to:

```typescript
// Rotas públicas: só healthcheck. Bootstrap de key é feito via `bun run key:create`
// (script CLI, acesso direto ao banco) — a rota HTTP de criação agora exige auth
// como qualquer outra, então só quem já tem uma key pode provisionar mais.
const PUBLIC_ROUTES = new Set(['/v1/healthcheck']);

function isPublicRoute(url: string): boolean {
  return PUBLIC_ROUTES.has(url);
}
```

- [ ] **Step 7: Run the full suite**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all tests pass (no existing test relied on unauthenticated `POST /v1/keys`), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix(security): require auth on POST /v1/keys, attach apiKeyId to request (V-01)"
```

---

### Task 2: Rotate/delete only your own key (V-03)

**Files:**
- Modify: `apps/api/src/infra/http/controllers/auth.controller.ts`
- Test: `apps/api/tests/infra/auth-controller.test.ts` (new)

**Interfaces:**
- Consumes: `request.apiKeyId` (Task 1)
- Produces: `rotateApiKeyController`/`deleteApiKeyController` reject with 403 when `params.id !== request.apiKeyId`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/infra/auth-controller.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { rotateApiKeyController, deleteApiKeyController } from '../../src/infra/http/controllers/auth.controller.ts';

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
          return reply;
        },
      };
    },
    send(body: unknown) {
      captured = { status: 200, body };
    },
  };
  return { reply, getCaptured: () => captured };
}

const OWN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('key management — ownership enforcement', () => {
  test('rotateApiKeyController: 403 when id is not the caller\'s own key', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID };

    await rotateApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(403);
  });

  test('deleteApiKeyController: 403 when id is not the caller\'s own key', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID };

    await deleteApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to confirm both fail**

```bash
cd apps/api && bun test tests/infra/auth-controller.test.ts
```

Expected: FAIL — both currently proceed to the DB call (which will throw/reject differently in this fake-DB-less test, but critically neither returns 403).

- [ ] **Step 3: Add the ownership check to both controllers**

In `apps/api/src/infra/http/controllers/auth.controller.ts`, in `rotateApiKeyController`, right after:

```typescript
  const { id } = parsed.data;
  const newKey = generateApiKey();
```

add:

```typescript
  if (id !== request.apiKeyId) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Só é possível rotacionar a própria API key.',
    });
    return;
  }
```

In `deleteApiKeyController`, right after:

```typescript
  const { id } = parsed.data;
```

add:

```typescript
  if (id !== request.apiKeyId) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Só é possível remover a própria API key.',
    });
    return;
  }
```

- [ ] **Step 4: Run the tests, then the full suite**

```bash
cd apps/api && bun test tests/infra/auth-controller.test.ts && bun test && bun run typecheck
```

Expected: both new tests PASS, full suite 73/73 (71 + the 2 new ones from Task 1/2 so far), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(security): rotate/delete API key restricted to the caller's own key (V-03)"
```

---

### Task 3: Wallet ownership — `wallets.userId` becomes the authenticated key, not client input (V-02)

**Files:**
- Modify: `apps/api/src/infra/database/schema.ts`
- Create: `apps/api/db/migrations/00XX_wallet_owner_fk.sql` (run via `drizzle-kit generate`, see Step 1)
- Modify: `apps/api/src/infra/http/controllers/wallets.controller.ts`
- Modify: `apps/api/src/infra/http/controllers/rebalance.controller.ts`
- Test: `apps/api/tests/infra/wallets-ownership.test.ts` (new)

**Interfaces:**
- Consumes: `request.apiKeyId` (Task 1)
- Produces: `wallets.userId` is now a foreign key to `api_keys.id`; every wallet/asset/rebalance controller filters by `eq(wallets.userId, request.apiKeyId)` and returns 404 (never leaks existence) for another key's wallet.

- [ ] **Step 1: Add the FK constraint in the schema and generate the migration**

In `apps/api/src/infra/database/schema.ts`, find the `wallets` table definition:

```typescript
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
```

Change `userId` to reference `apiKeys.id` (the `apiKeys` table is already defined earlier in this same file):

```typescript
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Dono da carteira = a API key autenticada que a criou. Nunca aceitar este
    // valor do cliente — sempre derivar de request.apiKeyId no controller.
    userId: uuid('user_id').notNull().references(() => apiKeys.id),
    name: varchar('name', { length: 100 }).notNull(),
```

Generate the migration:

```bash
cd apps/api && bun run db:generate
```

Expected: a new file `db/migrations/00XX_<name>.sql` containing an `ALTER TABLE "wallets" ADD CONSTRAINT ... FOREIGN KEY ("user_id") REFERENCES "api_keys"("id")` statement. Read the generated file to confirm it only adds the constraint (no data loss) — since the local dev DB currently has 0 rows in `wallets`, this is safe to apply.

- [ ] **Step 2: Apply the migration**

```bash
cd apps/api && bun run db:migrate
```

Expected: migration applies cleanly (0 existing rows, nothing to violate the new FK).

- [ ] **Step 3: Write the failing ownership tests**

Create `apps/api/tests/infra/wallets-ownership.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
  getWalletController,
  updateWalletController,
  deleteWalletController,
} from '../../src/infra/http/controllers/wallets.controller.ts';

const OWNER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WALLET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// These controllers query the real db module directly; this suite verifies
// the *shape* of the ownership guard via a fake db swapped in per-test using
// bun:test's module mock, matching the pattern in auth-key-id.test.ts.
import { mock } from 'bun:test';

function mockDbReturning(walletRow: unknown) {
  mock.module('../../src/infra/database/connection.ts', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: async () => (walletRow ? [walletRow] : []),
          leftJoin: () => ({ where: () => ({ orderBy: async () => [] }) }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => (walletRow ? [walletRow] : []) }) }) }),
      delete: () => ({ where: () => ({ returning: async () => (walletRow ? [{ id: WALLET_ID }] : []) }) }),
    },
    checkDatabaseConnection: async () => {},
    closeDatabaseConnection: async () => {},
  }));
}

interface CapturedResponse { status: number; body: unknown }
function fakeReply() {
  let captured: CapturedResponse | null = null;
  const reply = {
    status(code: number) {
      return { send(body: unknown) { captured = { status: code, body }; } };
    },
    send(body: unknown) { captured = { status: 200, body }; },
  };
  return { reply, getCaptured: () => captured };
}

describe('wallet ownership guard', () => {
  test('getWalletController: 404 when wallet belongs to a different key', async () => {
    mockDbReturning({ id: WALLET_ID, userId: OTHER, name: 'x' });
    const { getWalletController: fresh } = await import('../../src/infra/http/controllers/wallets.controller.ts');
    const { reply, getCaptured } = fakeReply();
    await fresh({ params: { walletId: WALLET_ID }, apiKeyId: OWNER } as never, reply as never);
    expect(getCaptured()?.status).toBe(404);
  });
});
```

Note for the implementer: bun's `mock.module` replaces the module for subsequent dynamic imports in the same test file; if the static imports at the top of this file resolve before the mock is registered, re-import the controller dynamically inside each test as shown (`await import(...)`) rather than relying on the top-level static import for the mocked scenario. Adjust the fake `db` shape as needed once you see the real query chains each controller uses (check `wallets.controller.ts` — `getWalletController` does a `select().from().where()` then a second `select().from().leftJoin().where().orderBy()` for assets).

- [ ] **Step 4: Run to confirm it fails**

```bash
cd apps/api && bun test tests/infra/wallets-ownership.test.ts
```

Expected: FAIL — current `getWalletController` returns 200 with the wallet regardless of who owns it (no `apiKeyId` filter applied yet).

- [ ] **Step 5: Enforce ownership in every wallet/asset controller**

In `apps/api/src/infra/http/controllers/wallets.controller.ts`:

`createWalletController` — stop trusting client `userId`, derive it:

```typescript
const createWalletSchema = z.object({
  name: z.string().min(1).max(100),
});
```

(remove `userId: z.string().uuid()` from the schema), and change the handler body:

```typescript
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

  reply.status(201).send(row);
}
```

`listWalletsController` — always scope to the caller, drop the client-supplied `userId` query param entirely:

```typescript
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
```

`getWalletController` — add the ownership filter to the wallet lookup:

```typescript
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
```

(the rest of the function — the 404 branch and the assets query — stays the same, since `walletId` is already confirmed owned by this point).

`updateWalletController` — add the same filter to the `.update().where()`:

```typescript
  const [row] = await db
    .update(wallets)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)))
    .returning();
```

`deleteWalletController` — same:

```typescript
  const [deleted] = await db
    .delete(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)))
    .returning({ id: wallets.id });
```

`addAssetToWalletController` — the existence check must also check ownership:

```typescript
  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
```

`removeAssetFromWalletController` — this one never checked wallet existence at all; add an ownership-checked wallet lookup before the delete:

```typescript
export async function removeAssetFromWalletController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = assetParamsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Parâmetros de rota inválidos.');

  const { walletId, assetId } = parsed.data;

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
```

- [ ] **Step 6: Enforce ownership in the rebalance controller**

In `apps/api/src/infra/http/controllers/rebalance.controller.ts`, add an ownership check before calling the use case. Add these imports at the top:

```typescript
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { wallets } from '../../database/schema.ts';
```

And right after the two `safeParse` blocks (params and body), before the `try`:

```typescript
  const { walletId } = paramsResult.data;

  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, request.apiKeyId!)));
  if (!wallet) {
    reply.status(404).send({ error: 'NotFound', message: 'Carteira não encontrada.' });
    return;
  }
```

(the existing `try` block below keeps using `paramsResult.data`/`bodyResult.data` as before — just don't redeclare `walletId` a second time inside it; adjust the destructuring inside the `try` to not repeat `const { walletId }`.)

- [ ] **Step 7: Update `apps/web`'s `createWallet` call, if any, to stop sending `userId`**

Grep the web app: `grep -rn "userId" apps/web/src`. If any call site sends a client-side-generated `userId` when creating a wallet, remove that field from the request body (the backend now derives it from the auth header). If no such call site exists (wallet creation isn't wired into the UI yet), skip this step — note that in your report.

- [ ] **Step 8: Run the full suite**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all tests pass, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix(security): scope all wallet/asset/rebalance access to the authenticated key (V-02)"
```

---

### Task 4: Hash stored API keys (V-06)

**Files:**
- Modify: `apps/api/src/infra/database/schema.ts`
- Create: `apps/api/db/migrations/00XX_api_key_hash.sql` (generated)
- Create: `apps/api/scripts/hash-existing-keys.ts` (one-off backfill for already-issued plaintext keys)
- Modify: `apps/api/src/infra/http/middleware/auth.ts`
- Modify: `apps/api/src/infra/http/controllers/auth.controller.ts`
- Modify: `apps/api/scripts/create-api-key.ts`
- Test: `apps/api/tests/infra/api-key-hash.test.ts` (new)

**Interfaces:**
- Produces: `apiKeys.keyHash: varchar` (sha256 hex digest) replaces plaintext comparison; the plaintext `key` column stays for now (needed so `bun run key:create`/rotate can still print the key once) but is never used in the auth lookup.

- [ ] **Step 1: Add `keyHash` column and generate the migration**

In `apps/api/src/infra/database/schema.ts`, in the `apiKeys` table, add a column after `key`:

```typescript
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    key: varchar('key', { length: 128 }).notNull().unique(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    active: boolean('active').notNull().default(true),
```

Since `keyHash` is `notNull` and the table already has 4 rows in the dev DB, generating this as a plain migration would fail on existing rows. Generate it as nullable first, backfill, then tighten:

```bash
cd apps/api && bun run db:generate
```

Read the generated SQL. If drizzle-kit prompts for a default during generation (interactive), or if the generated statement adds the column as `NOT NULL` directly, edit the generated `.sql` file by hand to add it nullable instead:

```sql
ALTER TABLE "api_keys" ADD COLUMN "key_hash" varchar(64);
```

(drop any `NOT NULL`/`UNIQUE` from this generated file for now — Step 3 below adds those constraints back after backfill, in a second migration.)

- [ ] **Step 2: Apply the nullable-column migration**

```bash
cd apps/api && bun run db:migrate
```

- [ ] **Step 3: Write and run the one-off backfill script**

Create `apps/api/scripts/hash-existing-keys.ts`:

```typescript
/**
 * One-off backfill: computes key_hash for every existing api_keys row from
 * its still-plaintext `key` column. Safe to re-run (idempotent — only
 * updates rows where key_hash is null).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { isNull } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '../src/infra/database/connection.ts';
import { apiKeys } from '../src/infra/database/schema.ts';

async function main(): Promise<void> {
  const rows = await db.select().from(apiKeys).where(isNull(apiKeys.keyHash));
  for (const row of rows) {
    const hash = createHash('sha256').update(row.key).digest('hex');
    await db.update(apiKeys).set({ keyHash: hash }).where(eq(apiKeys.id, row.id));
  }
  console.log(`✅ ${rows.length} key(s) hashed.`);
}

main()
  .catch((err) => {
    console.error('❌ Erro ao popular key_hash:', err);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnection());
```

This file is missing an `eq` import — add `eq` to the `drizzle-orm` import: `import { isNull, eq } from 'drizzle-orm';`.

Run it:

```bash
cd apps/api && bun run scripts/hash-existing-keys.ts
```

Expected: `✅ 4 key(s) hashed.` (or however many rows currently exist).

- [ ] **Step 4: Generate and apply the tightening migration**

Change the schema to its final form:

```typescript
    key: varchar('key', { length: 128 }).notNull().unique(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
```

```bash
cd apps/api && bun run db:generate && bun run db:migrate
```

Expected: succeeds now that every row has a `key_hash` from Step 3.

- [ ] **Step 5: Write the failing test for hash-based auth lookup**

Create `apps/api/tests/infra/api-key-hash.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

describe('API key hashing', () => {
  test('sha256 hex digest is deterministic and matches expected format', () => {
    const key = 'ur_deadbeef_deadbeef_deadbeef_deadbeef';
    const hash = createHash('sha256').update(key).digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(key).digest('hex')).toBe(hash);
  });
});
```

(This is a sanity test for the hashing primitive itself — the full auth-middleware behavior is already covered by `auth-key-id.test.ts` and `auth-fail-closed.test.ts`, which Step 6 below updates to hash the test key before mocking the DB response.)

- [ ] **Step 6: Update the auth middleware to look up by hash**

In `apps/api/src/infra/http/middleware/auth.ts`, add the import:

```typescript
import { createHash } from 'node:crypto';
```

Change the DB lookup:

```typescript
  let row: { key: string; active: boolean; id: string } | undefined;
  try {
    const keyHash = createHash('sha256').update(key).digest('hex');
    const result = await db
      .select({ key: apiKeys.key, active: apiKeys.active, id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true)));
    row = result[0];
```

Update `apps/api/tests/infra/auth-key-id.test.ts`'s mocked `db.select().from().where()` — it currently returns a fixed row regardless of the query; no change needed there since the mock doesn't inspect the `where` clause. Run the full suite to confirm nothing broke:

```bash
cd apps/api && bun test
```

- [ ] **Step 7: Update key creation/rotation to compute and store the hash**

In `apps/api/src/infra/http/controllers/auth.controller.ts`, add the import `import { createHash } from 'node:crypto';`, then in `createApiKeyController`:

```typescript
  const { name } = parsed.data;
  const key = generateApiKey();
  const keyHash = createHash('sha256').update(key).digest('hex');

  const [row] = await db
    .insert(apiKeys)
    .values({ name, key, keyHash })
    .returning();
```

In `rotateApiKeyController`:

```typescript
  const newKey = generateApiKey();
  const newKeyHash = createHash('sha256').update(newKey).digest('hex');

  const [updated] = await db
    .update(apiKeys)
    .set({ key: newKey, keyHash: newKeyHash })
    .where(eq(apiKeys.id, id))
    .returning();
```

In `apps/api/scripts/create-api-key.ts`, add the same import and change:

```typescript
    const key = generateApiKey();
    const keyHash = createHash('sha256').update(key).digest('hex');

    const [row] = await db
      .insert(apiKeys)
      .values({ name, key, keyHash })
      .returning();
```

- [ ] **Step 8: Run the full suite and typecheck**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix(security): hash stored API keys (sha256), lookup by hash not plaintext (V-06)"
```

---

### Task 5: Harden `docker-compose.yml` — Redis auth + Postgres password from env (V-04, V-05)

**Files:**
- Modify: `apps/api/docker-compose.yml`
- Modify: `apps/api/.env` (add `POSTGRES_PASSWORD`, `REDIS_PASSWORD`; this file is gitignored, edit it directly)
- Modify: `apps/api/src/config/env.ts` (no `REDIS_PASSWORD`/`POSTGRES_PASSWORD` needed here — the app already gets full connection strings via `DATABASE_URL`/`REDIS_URL`; just update those two values in `.env` to include the new password)

**Interfaces:** none code-facing — this is operational config only.

- [ ] **Step 1: Update `apps/api/docker-compose.yml`**

Change:

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: urano-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: urano
      POSTGRES_PASSWORD: urano_dev
      POSTGRES_DB: urano_finbot
```

to:

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: urano-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: urano
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?defina POSTGRES_PASSWORD no .env}
      POSTGRES_DB: urano_finbot
```

And change:

```yaml
  redis:
    image: redis:7-alpine
    container_name: urano-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

to:

```yaml
  redis:
    image: redis:7-alpine
    container_name: urano-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass ${REDIS_PASSWORD:?defina REDIS_PASSWORD no .env}
```

- [ ] **Step 2: Generate strong passwords and update `apps/api/.env`**

```bash
cd apps/api
PG_PW=$(openssl rand -hex 24)
REDIS_PW=$(openssl rand -hex 24)
echo "Generated (write these into .env manually, replacing existing DATABASE_URL/REDIS_URL and adding the two new vars):"
echo "POSTGRES_PASSWORD=$PG_PW"
echo "REDIS_PASSWORD=$REDIS_PW"
```

Edit `apps/api/.env` by hand:
- Add `POSTGRES_PASSWORD=<generated>` and `REDIS_PASSWORD=<generated>` as new lines.
- Update `DATABASE_URL` to `postgres://urano:<generated-pg-password>@localhost:5432/urano_finbot`.
- Update `REDIS_URL` to `redis://:<generated-redis-password>@localhost:6379`.

- [ ] **Step 3: Recreate the containers and verify connectivity**

```bash
cd apps/api
docker compose down
docker compose up -d
timeout 20 bash -c 'until docker exec urano-postgres pg_isready -U urano -d urano_finbot; do sleep 1; done'
docker exec urano-redis redis-cli -a "$REDIS_PW" ping
```

Expected: `PONG`. Also confirm the old, no-password connection now fails: `docker exec urano-redis redis-cli ping` should return `NOAUTH Authentication required.`

- [ ] **Step 4: Run the full apps/api suite against the now-password-protected services**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all pass (app reads the updated `.env` values, same as before).

- [ ] **Step 5: Commit (compose file only — `.env` stays gitignored, never committed)**

```bash
git add apps/api/docker-compose.yml
git commit -m "fix(security): require passwords for Postgres and Redis in docker-compose (V-04, V-05)"
```

---

### Task 6: MCP server fail-fast + frontend Base URL validation (V-07, V-08)

**Files:**
- Modify: `apps/api/src/infra/mcp/server.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web` has no existing unit test setup for `lib/api.ts` — verify manually via typecheck + the existing Settings screen (documented in Step 4 below); no new automated test infra is introduced by this task.

**Interfaces:**
- `apiSettings.setBaseUrl(v: string)` now throws/rejects an invalid URL instead of silently accepting one — check the call site in `apps/web/src/routes/settings.tsx` to see how it handles the call today and keep that contract (it currently doesn't check a return value or catch an exception, so Step 3 below also updates the call site).

- [ ] **Step 1: MCP server — fail fast instead of defaulting to `'dev'`**

In `apps/api/src/infra/mcp/server.ts`, both `api()` and `apiPost()` currently have:

```typescript
  const key = process.env.URANO_API_KEY || 'dev';
```

Replace both occurrences with a single shared constant computed once near the top of the file (right after the `API_BASE` line):

```typescript
const API_BASE = process.env.URANO_API_URL || 'http://localhost:3000/v1';

if (!process.env.URANO_API_KEY) {
  console.error('❌ URANO_API_KEY não definida. Configure a variável de ambiente antes de iniciar o MCP server.');
  process.exit(1);
}
const API_KEY = process.env.URANO_API_KEY;
```

Then in `api()` and `apiPost()`, replace `const key = process.env.URANO_API_KEY || 'dev';` with nothing (delete the line) and change `'x-api-key': key` to `'x-api-key': API_KEY` in both functions.

- [ ] **Step 2: Frontend — validate the Base URL before storing it**

Read `apps/web/src/lib/api.ts`'s current `setBaseUrl`:

```typescript
  setBaseUrl(v: string) {
    localStorage.setItem(LS_BASE, v.replace(/\/+$/, ""));
    window.dispatchEvent(new Event("urano:settings"));
  },
```

Replace with:

```typescript
  setBaseUrl(v: string) {
    const trimmed = v.replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("URL inválida. Use um endereço completo, ex.: https://api.exemplo.com");
    }
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
      throw new Error("Use https:// (ou http:// apenas para localhost).");
    }
    localStorage.setItem(LS_BASE, trimmed);
    window.dispatchEvent(new Event("urano:settings"));
  },
```

- [ ] **Step 3: Update the Settings screen call site to surface the validation error**

In `apps/web/src/routes/settings.tsx`, add a new state next to the existing `saved` state:

```typescript
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
```

Change the `save` handler:

```typescript
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    apiSettings.setBaseUrl(baseUrl);
    apiSettings.setKey(key);
    setSaved(true);
    toast.success("Configurações salvas");
    setTimeout(() => setSaved(false), 1500);
  };
```

to:

```typescript
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      apiSettings.setBaseUrl(baseUrl);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "URL inválida.");
      return;
    }
    setSaveError(null);
    apiSettings.setKey(key);
    setSaved(true);
    toast.success("Configurações salvas");
    setTimeout(() => setSaved(false), 1500);
  };
```

Then render `saveError` using the same visual treatment already used for `authMsg` a few lines above (same file, lines 57-68) — add this block right after that `{authMsg ? (...) : null}` block, before the `<div className="grid ...">`:

```tsx
      {saveError ? (
        <div className="mb-4 flex items-start gap-2 rounded border border-negative/40 bg-negative/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-negative mt-0.5" />
          <div>
            <div className="font-semibold text-negative">Base URL inválida</div>
            <div className="text-muted-foreground mt-0.5">{saveError}</div>
          </div>
        </div>
      ) : null}
```

- [ ] **Step 4: Verify manually**

```bash
cd apps/api && bun run typecheck
cd ../web && bunx tsc --noEmit
```

Expected: both clean. Then start `apps/web`'s dev server, open Settings, try saving `javascript:alert(1)` as the Base URL — expect a visible inline error, not a silent save. Try `https://example.com` — expect it to save normally. Try `http://localhost:3333` — expect it to save normally (local dev exception).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(security): MCP server fails fast without URANO_API_KEY, frontend validates Base URL scheme (V-07, V-08)"
```

---

### Task 7: Audit logging for key and wallet mutations (V-09)

**Files:**
- Modify: `apps/api/src/infra/http/controllers/auth.controller.ts`
- Modify: `apps/api/src/infra/http/controllers/wallets.controller.ts`
- Test: `apps/api/tests/infra/audit-log.test.ts` (new)

**Interfaces:**
- Produces: a `logSecurityEvent(action: string, details: Record<string, unknown>)` helper (new, colocated in a small shared module) that writes one structured `console.log` line per sensitive mutation — this repo has no external log aggregator configured, so structured console output (consistent with the rest of the codebase's `console.log`/`console.error` usage) is the right fit; do not introduce a new logging dependency.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/infra/audit-log.test.ts`:

```typescript
import { describe, expect, test, spyOn } from 'bun:test';
import { logSecurityEvent } from '../../src/infra/http/audit-log.ts';

describe('logSecurityEvent', () => {
  test('writes a structured line including action and details, never a raw key value', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    logSecurityEvent('api_key.create', { apiKeyId: 'abc-123', name: 'test' });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('api_key.create');
    expect(line).toContain('abc-123');
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd apps/api && bun test tests/infra/audit-log.test.ts
```

Expected: FAIL — `apps/api/src/infra/http/audit-log.ts` doesn't exist yet.

- [ ] **Step 3: Create the helper**

Create `apps/api/src/infra/http/audit-log.ts`:

```typescript
/**
 * Structured audit log for security-sensitive mutations (key/wallet
 * create/rotate/delete). Never pass a plaintext API key value in `details`.
 */
export function logSecurityEvent(action: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      audit: true,
      action,
      at: new Date().toISOString(),
      ...details,
    }),
  );
}
```

- [ ] **Step 4: Run the test again**

```bash
cd apps/api && bun test tests/infra/audit-log.test.ts
```

Expected: PASS.

- [ ] **Step 5: Call it from every sensitive mutation**

In `apps/api/src/infra/http/controllers/auth.controller.ts`, import `logSecurityEvent` from `'../audit-log.ts'` and call it:
- In `createApiKeyController`, right before `reply.status(201).send(...)`: `logSecurityEvent('api_key.create', { apiKeyId: row!.id, name: row!.name });`
- In `rotateApiKeyController`, right before `reply.send(...)`: `logSecurityEvent('api_key.rotate', { apiKeyId: updated.id, requestedBy: request.apiKeyId });`
- In `deleteApiKeyController`, right before `reply.send(...)`: `logSecurityEvent('api_key.delete', { apiKeyId: updated.id, requestedBy: request.apiKeyId });`

In `apps/api/src/infra/http/controllers/wallets.controller.ts`, import `logSecurityEvent` from `'../audit-log.ts'` and call it:
- In `createWalletController`, right before `reply.status(201).send(row)`: `logSecurityEvent('wallet.create', { walletId: row!.id, apiKeyId: request.apiKeyId });`
- In `deleteWalletController`, right before `reply.send(...)`: `logSecurityEvent('wallet.delete', { walletId: deleted.id, apiKeyId: request.apiKeyId });`

- [ ] **Step 6: Run the full suite**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(security): structured audit log for API key and wallet mutations (V-09)"
```

---

### Task 8: Small hardening items — parametrize backtest query, pin dependency, fix docs comment (V-10, V-11, V-13)

**Files:**
- Modify: `apps/api/src/infra/workers/backtest.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/infra/http/routes/index.ts`
- Test: none new (backtest.ts is a CLI script with no existing test harness; typecheck + `apps/api`'s existing suite are the verification gates)

- [ ] **Step 1: Parametrize the backtest SQL (V-10)**

In `apps/api/src/infra/workers/backtest.ts`, add the import `import { sql } from 'drizzle-orm';` near the top, then change:

```typescript
  const rows = await db.execute(
    `SELECT DISTINCT ON (c.ticker, cf.fiscal_year)
      c.ticker, c.name, c.sector,
      cf.revenue, cf.cogs, cf.ebit, cf.net_income_parent,
      cf.total_assets, cf.total_liabilities, cf.cash,
      cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
      cf.reference_date, cf.fiscal_year
     FROM company_fundamentals cf
     JOIN companies c ON c.cnpj = cf.company_cnpj
     WHERE cf.fiscal_year BETWEEN ${year - 4} AND ${year}
       AND c.ticker NOT LIKE '%11'
     ORDER BY c.ticker, cf.fiscal_year, cf.reference_date DESC`,
  );
```

to:

```typescript
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.ticker, cf.fiscal_year)
      c.ticker, c.name, c.sector,
      cf.revenue, cf.cogs, cf.ebit, cf.net_income_parent,
      cf.total_assets, cf.total_liabilities, cf.cash,
      cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
      cf.reference_date, cf.fiscal_year
     FROM company_fundamentals cf
     JOIN companies c ON c.cnpj = cf.company_cnpj
     WHERE cf.fiscal_year BETWEEN ${year - 4} AND ${year}
       AND c.ticker NOT LIKE '%11'
     ORDER BY c.ticker, cf.fiscal_year, cf.reference_date DESC
  `);
```

- [ ] **Step 2: Pin `@types/bun` (V-11)**

In `apps/api/package.json`, check the currently-installed resolved version:

```bash
cd apps/api && bun pm ls | grep '@types/bun'
```

Change `"@types/bun": "latest"` to `"@types/bun": "^<resolved-version>"` (the caret-pinned form matching every other dependency in this file).

- [ ] **Step 3: Fix the misleading comment on `/v1/docs/openapi.json` (V-13)**

In `apps/api/src/infra/http/routes/index.ts`, change:

```typescript
  // Healthcheck + Docs (rotas públicas, sem auth)
  app.get('/healthcheck', healthcheckController);
  app.get('/docs/openapi.json', openApiController);
```

to:

```typescript
  // Healthcheck é público; docs (openapi.json) exige auth como qualquer outra rota
  // — corrigido em V-13 (o comentário antigo dizia "pública" mas isPublicRoute
  // nunca incluiu esta rota, então isso nunca foi um vazamento real).
  app.get('/healthcheck', healthcheckController);
  app.get('/docs/openapi.json', openApiController);
```

- [ ] **Step 4: Run the full suite**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all pass (V-10's change is behavior-preserving — same query, same parameter binding semantics, just via Drizzle's safe tag instead of a raw template literal).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(security): parametrize backtest query via Drizzle sql tag, pin @types/bun, fix docs route comment (V-10, V-11, V-13)"
```

---

### Task 9: Basic CI pipeline with secret/dependency scanning (V-12)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** none code-facing.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

jobs:
  test-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Typecheck
        run: bun run typecheck
      - name: API tests
        working-directory: apps/api
        run: bun test
      - name: Web lint
        working-directory: apps/web
        run: bun run lint

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: OSV Scanner
        uses: google/osv-scanner-action@v1
        with:
          scan-args: |-
            --lockfile=./bun.lock
            --lockfile=./apps/api/bun.lock
            --lockfile=./apps/web/bun.lock
        continue-on-error: true
```

Note for the implementer: `apps/api/bun.lock` and `apps/web/bun.lock` were removed in a prior session (the root `bun.lock` is now the single workspace lockfile) — check with `ls apps/api/bun.lock apps/web/bun.lock apps/api/../../bun.lock` before finalizing this step, and only reference lockfiles that actually exist. If only the root `bun.lock` exists, the `scan-args` should be just `--lockfile=./bun.lock`.

- [ ] **Step 2: Validate the YAML syntax locally**

```bash
bunx --bun js-yaml .github/workflows/ci.yml > /dev/null && echo "valid YAML"
```

(If `js-yaml` isn't available, at minimum confirm the file has consistent indentation and no tabs: `grep -P '\t' .github/workflows/ci.yml` should print nothing.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(security): add CI pipeline — tests, typecheck, secret scanning, dependency scanning (V-12)"
```

Note: this workflow cannot be executed/validated end-to-end without pushing to GitHub Actions — the task reviewer for this task should focus on YAML correctness and whether the referenced actions/lockfile paths are accurate, not on a live CI run.
