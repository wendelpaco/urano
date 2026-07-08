# Urano Comercialização — Backend (Ondas S+R+B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar a API Urano em produto cobrável: users + keys hasheadas, auth fail-closed, rate limiting, metering, planos com gating e billing Stripe.

**Architecture:** Núcleo puro em `src/core` (plans, api-key, usage-keys, stripe reducer) testado sem infra; shells finos em `src/infra` (middleware, portal, webhook, worker de flush). Auth por API key (hash SHA-256, cache Redis 60s, fail-closed) para rotas de dados; sessão Redis por cookie para rotas `/v1/portal/*`; webhook Stripe público com assinatura verificada.

**Tech Stack:** Bun, Fastify 5, Drizzle/Postgres, ioredis, zod 3, `stripe`, `@fastify/cookie`, bun:test.

**Spec:** `docs/superpowers/specs/2026-07-08-commercialization-mvp-design.md`

## Global Constraints

- Runtime Bun; testes com `bun:test`; typecheck `bun run typecheck` deve passar em todo commit
- Prefixo de rotas `/v1`; mensagens de erro em pt-BR no formato `{ error, message }` (padrão existente)
- Keys NUNCA persistidas em plaintext; somente `keyHash` (SHA-256 hex) + `keyPrefix` (12 chars)
- Auth por API key é **fail-closed** (Postgres indisponível + cache frio → 503); rate limiting é **fail-open** (Redis indisponível → deixa passar)
- Limites de plano centralizados em `src/core/plans.ts` — nenhum número de limite hardcoded fora dele
- Planos: free (5.000 req/mês, 10 req/min, 1 key, sem analysis), pro (100.000, 60, 3, com analysis), business (1.000.000, 300, 10, com analysis)
- Endpoints gated por plano pago: prefixos `/v1/analysis` e `/v1/screener`
- Mês de uso em UTC, formato `YYYY-MM`
- Commits frequentes, mensagens em pt-BR estilo repo (`feat:`, `fix:`), com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Dependências e variáveis de ambiente

**Files:**
- Modify: `package.json`
- Modify: `src/config/env.ts`

**Interfaces:**
- Produces: `env.RESEND_API_KEY?`, `env.EMAIL_FROM`, `env.DASHBOARD_URL`, `env.STRIPE_SECRET_KEY`, `env.STRIPE_WEBHOOK_SECRET`, `env.STRIPE_PRICE_PRO`, `env.STRIPE_PRICE_BUSINESS` — usados pelas Tasks 5, 12, 13.

- [ ] **Step 1: Instalar dependências**

Run: `bun add stripe @fastify/cookie`
Expected: `package.json` e `bun.lock` atualizados.

- [ ] **Step 2: Adicionar script do worker de flush em `package.json`**

Em `"scripts"`, adicionar:

```json
"worker:usage": "bun run src/infra/workers/usage-flush-worker.ts"
```

- [ ] **Step 3: Estender `src/config/env.ts`**

Adicionar ao `envSchema` (depois de `REDIS_URL`):

```ts
  RESEND_API_KEY: z.string().optional(),

  EMAIL_FROM: z
    .string()
    .default('Urano <noreply@urano.dev>'),

  DASHBOARD_URL: z
    .string()
    .default('http://localhost:3001'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_PRO: z.string().default(''),
  STRIPE_PRICE_BUSINESS: z.string().default(''),
```

E no objeto `raw` de `parseEnv()`:

```ts
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    DASHBOARD_URL: process.env.DASHBOARD_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
```

- [ ] **Step 4: Verificar**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/config/env.ts
git commit -m "feat: deps e env para billing (stripe, cookie, resend)"
```

---

### Task 2: Schema — users, api_keys seguro, usage_monthly, stripe_events

**Files:**
- Modify: `src/infra/database/schema.ts`
- Create: migration gerada em `drizzle/` (gerar + editar à mão)

**Interfaces:**
- Produces: tabelas Drizzle `users`, `usageMonthly`, `stripeEvents`; `apiKeys` com `userId`, `keyHash`, `keyPrefix` (sem coluna `key`). Enums `planEnum('plan')`, `planStatusEnum('plan_status')`. Tasks 6, 9, 11, 13 consomem.

- [ ] **Step 1: Adicionar `pgEnum` ao import de `drizzle-orm/pg-core` e definir enums + tabela `users` em `schema.ts`**

```ts
export const planEnum = pgEnum('plan', ['free', 'pro', 'business']);
export const planStatusEnum = pgEnum('plan_status', ['active', 'past_due', 'canceled']);

// ═══════════════════════════════════════════════════════════════════════════
// users — Contas de clientes da API
// ═══════════════════════════════════════════════════════════════════════════
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: varchar('name', { length: 100 }),
    stripeCustomerId: varchar('stripe_customer_id', { length: 64 }).unique(),
    plan: planEnum('plan').notNull().default('free'),
    planStatus: planStatusEnum('plan_status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
);
```

- [ ] **Step 2: Alterar `apiKeys` no `schema.ts`**

Substituir a definição atual por:

```ts
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    active: boolean('active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_api_keys_user_id').on(table.userId),
  ],
);
```

- [ ] **Step 3: Adicionar `usageMonthly` e `stripeEvents` ao `schema.ts`**

```ts
// ═══════════════════════════════════════════════════════════════════════════
// usage_monthly — Uso agregado por key/mês/endpoint (flush do Redis a cada 5min)
// endpoint '_total' representa o agregado do mês da key
// ═══════════════════════════════════════════════════════════════════════════
export const usageMonthly = pgTable(
  'usage_monthly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    month: char('month', { length: 7 }).notNull(),
    endpoint: varchar('endpoint', { length: 160 }).notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_usage_key_month_endpoint').on(table.keyId, table.month, table.endpoint),
    index('idx_usage_user_month').on(table.userId, table.month),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// stripe_events — Idempotência de webhooks Stripe
// ═══════════════════════════════════════════════════════════════════════════
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
);
```

- [ ] **Step 4: Gerar migration**

Run: `bun run db:generate`
Expected: novo arquivo SQL em `drizzle/`.

- [ ] **Step 5: Editar a migration gerada à mão (backfill de keys existentes)**

A migration gerada vai criar `users`/`usage_monthly`/`stripe_events` e alterar `api_keys` de forma destrutiva. Reordenar/editar o SQL de `api_keys` para o padrão abaixo (colunas novas nullable → backfill → not null → drop `key`):

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "api_keys" ADD COLUMN "user_id" uuid;
ALTER TABLE "api_keys" ADD COLUMN "key_hash" varchar(64);
ALTER TABLE "api_keys" ADD COLUMN "key_prefix" varchar(16);

-- User admin herda keys pré-existentes (sem dono)
INSERT INTO "users" ("email", "name")
VALUES ('admin@urano.local', 'Admin')
ON CONFLICT ("email") DO NOTHING;

UPDATE "api_keys" SET
  "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'admin@urano.local'),
  "key_hash" = encode(digest("key", 'sha256'), 'hex'),
  "key_prefix" = left("key", 12)
WHERE "key_hash" IS NULL;

ALTER TABLE "api_keys" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "key_hash" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "key_prefix" SET NOT NULL;

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_unique" UNIQUE ("key_hash");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
CREATE INDEX "idx_api_keys_user_id" ON "api_keys" ("user_id");

ALTER TABLE "api_keys" DROP COLUMN "key";
DROP INDEX IF EXISTS "idx_api_keys_key";
```

Manter o restante do SQL gerado (CREATE TYPE, CREATE TABLE users/usage_monthly/stripe_events) acima desse bloco.

- [ ] **Step 6: Aplicar migration local e verificar**

Run: `bun run db:migrate && bun run typecheck`
Expected: migration aplicada sem erro; typecheck limpo. Nota: `src/infra/http/controllers/auth.controller.ts` e `middleware/auth.ts` vão quebrar o typecheck por referenciar `apiKeys.key` — nesta task, atualizar as referências mínimas: em `auth.controller.ts` e `auth.ts` trocar `apiKeys.key` por `apiKeys.keyHash` SOMENTE para compilar (comportamento correto chega nas Tasks 6 e 11; este estado intermediário nunca vai para produção sozinho).

- [ ] **Step 7: Commit**

```bash
git add src/infra/database/schema.ts drizzle/ src/infra/http/middleware/auth.ts src/infra/http/controllers/auth.controller.ts
git commit -m "feat: schema de comercialização (users, keys hasheadas, usage, stripe_events)"
```

---

### Task 3: Config de planos (`src/core/plans.ts`)

**Files:**
- Create: `src/core/plans.ts`
- Test: `tests/core/plans.test.ts`

**Interfaces:**
- Produces: `type Plan = 'free' | 'pro' | 'business'`; `PLANS: Record<Plan, PlanLimits>` com `{ reqPerMonth, reqPerMin, maxKeys, analysisAccess }`; `requiresPaidPlan(routeUrl: string): boolean`; `canAccess(plan: Plan, routeUrl: string): boolean`; `isOverMonthlyLimit(plan: Plan, count: number): boolean`.

- [ ] **Step 1: Escrever teste que falha**

`tests/core/plans.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { PLANS, canAccess, requiresPaidPlan, isOverMonthlyLimit } from '../../src/core/plans.ts';

describe('PLANS', () => {
  test('limites do free', () => {
    expect(PLANS.free).toEqual({ reqPerMonth: 5_000, reqPerMin: 10, maxKeys: 1, analysisAccess: false });
  });
  test('pro e business têm acesso a analysis', () => {
    expect(PLANS.pro.analysisAccess).toBe(true);
    expect(PLANS.business.analysisAccess).toBe(true);
  });
});

describe('requiresPaidPlan', () => {
  test('analysis e screener são gated', () => {
    expect(requiresPaidPlan('/v1/analysis/stocks/:ticker')).toBe(true);
    expect(requiresPaidPlan('/v1/screener')).toBe(true);
  });
  test('rotas de dados são livres', () => {
    expect(requiresPaidPlan('/v1/companies')).toBe(false);
    expect(requiresPaidPlan('/v1/stocks/:ticker/quote')).toBe(false);
  });
});

describe('canAccess', () => {
  test('free não acessa analysis; pro sim', () => {
    expect(canAccess('free', '/v1/analysis/ranking')).toBe(false);
    expect(canAccess('pro', '/v1/analysis/ranking')).toBe(true);
  });
  test('free acessa rotas de dados', () => {
    expect(canAccess('free', '/v1/fiis')).toBe(true);
  });
});

describe('isOverMonthlyLimit', () => {
  test('limite exato bloqueia', () => {
    expect(isOverMonthlyLimit('free', 5_000)).toBe(true);
    expect(isOverMonthlyLimit('free', 4_999)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/core/plans.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/core/plans.ts`**

```ts
/**
 * Planos comerciais — fonte única de limites.
 * Nenhum limite de plano deve ser hardcoded fora deste arquivo.
 */

export type Plan = 'free' | 'pro' | 'business';

export interface PlanLimits {
  reqPerMonth: number;
  reqPerMin: number;
  maxKeys: number;
  analysisAccess: boolean;
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: { reqPerMonth: 5_000, reqPerMin: 10, maxKeys: 1, analysisAccess: false },
  pro: { reqPerMonth: 100_000, reqPerMin: 60, maxKeys: 3, analysisAccess: true },
  business: { reqPerMonth: 1_000_000, reqPerMin: 300, maxKeys: 10, analysisAccess: true },
};

const GATED_PREFIXES = ['/v1/analysis', '/v1/screener'];

export function requiresPaidPlan(routeUrl: string): boolean {
  return GATED_PREFIXES.some((prefix) => routeUrl.startsWith(prefix));
}

export function canAccess(plan: Plan, routeUrl: string): boolean {
  if (!requiresPaidPlan(routeUrl)) return true;
  return PLANS[plan].analysisAccess;
}

export function isOverMonthlyLimit(plan: Plan, count: number): boolean {
  return count >= PLANS[plan].reqPerMonth;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test tests/core/plans.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plans.ts tests/core/plans.test.ts
git commit -m "feat: config central de planos com gating de analysis/screener"
```

---

### Task 4: Serviço de API key (`src/core/services/api-key.ts`)

**Files:**
- Create: `src/core/services/api-key.ts`
- Test: `tests/core/api-key.test.ts`

**Interfaces:**
- Produces: `generateApiKey(): string` (`ur_` + 64 hex chars = 256 bits); `hashApiKey(key: string): string` (SHA-256 hex, 64 chars); `apiKeyPrefix(key: string): string` (12 chars). Tasks 6 e 11 consomem.

- [ ] **Step 1: Escrever teste que falha**

`tests/core/api-key.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../src/core/services/api-key.ts';

describe('generateApiKey', () => {
  test('formato ur_ + 64 hex', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^ur_[0-9a-f]{64}$/);
  });
  test('keys são únicas', () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe('hashApiKey', () => {
  test('SHA-256 hex determinístico', () => {
    const h = hashApiKey('ur_abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('ur_abc')).toBe(h);
    expect(hashApiKey('ur_abd')).not.toBe(h);
  });
});

describe('apiKeyPrefix', () => {
  test('primeiros 12 chars', () => {
    const key = generateApiKey();
    expect(apiKeyPrefix(key)).toBe(key.slice(0, 12));
    expect(apiKeyPrefix(key)).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/core/api-key.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/core/services/api-key.ts`**

```ts
import crypto from 'node:crypto';

export const KEY_PREFIX_LENGTH = 12;

/** Gera key nova: 'ur_' + 256 bits em hex. Exibida UMA única vez. */
export function generateApiKey(): string {
  return `ur_${crypto.randomBytes(32).toString('hex')}`;
}

/** Hash SHA-256 hex — único formato persistido no banco. */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Prefixo exibível no dashboard (não sensível). */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX_LENGTH);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test tests/core/api-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/api-key.ts tests/core/api-key.test.ts
git commit -m "feat: serviço de api key com hash sha-256 e prefixo"
```

---

### Task 5: FakeRedis (helper de teste), sessões magic link e e-mail

**Files:**
- Create: `tests/helpers/fake-redis.ts`
- Create: `src/infra/auth/session.ts`
- Create: `src/infra/services/email.ts`
- Test: `tests/infra/session.test.ts`

**Interfaces:**
- Consumes: `redis` de `src/infra/services/redis.ts`; `env` de `src/config/env.ts`.
- Produces: `createMagicLink(email): Promise<string>`; `consumeMagicLink(token): Promise<string | null>`; `createSession(userId): Promise<string>`; `getSessionUserId(token): Promise<string | null>`; `destroySession(token): Promise<void>`; `sendMagicLinkEmail(email, link): Promise<void>`; classe `FakeRedis` para todos os testes de infra.

- [ ] **Step 1: Criar `tests/helpers/fake-redis.ts`**

```ts
/** Stub em memória do ioredis para testes (sem TTL real). */
export class FakeRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string | number): Promise<'OK'> {
    this.store.set(key, String(value));
    return 'OK';
  }
  async setex(key: string, _ttl: number, value: string | number): Promise<'OK'> {
    this.store.set(key, String(value));
    return 'OK';
  }
  async getdel(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed++;
    return removed;
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
  async ping(): Promise<'PONG'> {
    return 'PONG';
  }
  async scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : '*';
    const regex = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    void cursor;
    return ['0', [...this.store.keys()].filter((k) => regex.test(k))];
  }
}
```

- [ ] **Step 2: Escrever teste que falha**

`tests/infra/session.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

const { createMagicLink, consumeMagicLink, createSession, getSessionUserId, destroySession } =
  await import('../../src/infra/auth/session.ts');

beforeEach(() => fakeRedis.store.clear());

describe('magic link', () => {
  test('cria e consome uma única vez', async () => {
    const token = await createMagicLink('User@Email.com');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await consumeMagicLink(token)).toBe('user@email.com');
    expect(await consumeMagicLink(token)).toBeNull();
  });
  test('token inválido retorna null', async () => {
    expect(await consumeMagicLink('nope')).toBeNull();
  });
});

describe('sessão', () => {
  test('cria, resolve e destrói', async () => {
    const token = await createSession('user-1');
    expect(await getSessionUserId(token)).toBe('user-1');
    await destroySession(token);
    expect(await getSessionUserId(token)).toBeNull();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test tests/infra/session.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar `src/infra/auth/session.ts`**

```ts
/**
 * Sessões do portal (dashboard) — Redis, revogáveis.
 * Magic link: token de 15 min, single-use (GETDEL).
 */

import crypto from 'node:crypto';
import { redis } from '../services/redis.ts';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias
const MAGIC_LINK_TTL_SECONDS = 60 * 15; // 15 min

export async function createMagicLink(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.setex(`magiclink:${token}`, MAGIC_LINK_TTL_SECONDS, email.toLowerCase());
  return token;
}

export async function consumeMagicLink(token: string): Promise<string | null> {
  const email = await redis.getdel(`magiclink:${token}`);
  return email ?? null;
}

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await redis.setex(`session:${token}`, SESSION_TTL_SECONDS, userId);
  return token;
}

export async function getSessionUserId(token: string): Promise<string | null> {
  return redis.get(`session:${token}`);
}

export async function destroySession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test tests/infra/session.test.ts`
Expected: PASS.

- [ ] **Step 6: Implementar `src/infra/services/email.ts` (sem teste — IO puro, dev-mode loga no console)**

```ts
import { env } from '../../config/env.ts';

/**
 * Envio de e-mail transacional via Resend.
 * Sem RESEND_API_KEY (dev) → loga o link no console.
 */
export async function sendMagicLinkEmail(email: string, link: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email/dev] Magic link para ${email}: ${link}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: 'Seu link de acesso — Urano',
      html: `<p>Acesse o dashboard do Urano: <a href="${link}">entrar</a>.</p><p>O link expira em 15 minutos. Se você não solicitou, ignore este e-mail.</p>`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Falha ao enviar e-mail: HTTP ${response.status}`);
  }
}
```

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`

```bash
git add tests/helpers/fake-redis.ts tests/infra/session.test.ts src/infra/auth/session.ts src/infra/services/email.ts
git commit -m "feat: sessões magic link em redis e e-mail transacional"
```

---

### Task 6: Reescrita do auth middleware — hash, fail-closed, gating por plano

**Files:**
- Modify: `src/infra/http/middleware/auth.ts` (reescrita completa)
- Test: `tests/infra/api-key-auth.test.ts`

**Interfaces:**
- Consumes: `hashApiKey` (Task 4); `canAccess`, tipo `Plan` (Task 3); `apiKeys`, `users` (Task 2).
- Produces: `apiKeyAuthMiddleware(request, reply)`; `interface ApiKeyContext { keyId: string; userId: string; plan: Plan }`; `request.apiKeyContext` (module augmentation); helper `invalidateKeyCache(keyHash: string)`. Task 7 injeta rate limit aqui; Task 8 lê `request.apiKeyContext`.

- [ ] **Step 1: Escrever teste que falha**

`tests/infra/api-key-auth.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import { FakeRedis } from '../helpers/fake-redis.ts';
import { hashApiKey } from '../../src/core/services/api-key.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

// db stub controlável por teste
let dbRows: unknown[] = [];
let dbShouldFail = false;
const chain: Record<string, unknown> = {};
for (const m of ['select', 'from', 'innerJoin', 'update', 'set', 'insert', 'values']) {
  chain[m] = () => chain;
}
chain.where = async () => {
  if (dbShouldFail) throw new Error('db down');
  return dbRows;
};
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const { apiKeyAuthMiddleware } = await import('../../src/infra/http/middleware/auth.ts');

function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', apiKeyAuthMiddleware);
  app.get('/v1/companies', async () => ({ ok: true }));
  app.get('/v1/analysis/ranking', async () => ({ ok: true }));
  app.get('/v1/healthcheck', async () => ({ ok: true }));
  return app;
}

const VALID_KEY = 'ur_' + 'a'.repeat(64);
const VALID_ROW = { keyId: 'k1', userId: 'u1', plan: 'free', planStatus: 'active' };

beforeEach(() => {
  fakeRedis.store.clear();
  dbRows = [];
  dbShouldFail = false;
});

describe('apiKeyAuthMiddleware', () => {
  test('healthcheck é público', async () => {
    const res = await buildApp().inject({ url: '/v1/healthcheck' });
    expect(res.statusCode).toBe(200);
  });

  test('sem header → 401', async () => {
    const res = await buildApp().inject({ url: '/v1/companies' });
    expect(res.statusCode).toBe(401);
  });

  test('key válida no banco → 200 e cacheia contexto', async () => {
    dbRows = [VALID_ROW];
    const res = await buildApp().inject({
      url: '/v1/companies',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(200);
    const cached = fakeRedis.store.get(`apikey:ctx:${hashApiKey(VALID_KEY)}`);
    expect(JSON.parse(cached!)).toEqual({ keyId: 'k1', userId: 'u1', plan: 'free' });
  });

  test('key inexistente → 401 e cache negativo', async () => {
    dbRows = [];
    const res = await buildApp().inject({
      url: '/v1/companies',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(fakeRedis.store.get(`apikey:ctx:${hashApiKey(VALID_KEY)}`)).toBe('invalid');
  });

  test('banco fora e cache frio → 503 (fail-closed)', async () => {
    dbShouldFail = true;
    const res = await buildApp().inject({
      url: '/v1/companies',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(503);
  });

  test('banco fora mas cache quente → 200', async () => {
    dbShouldFail = true;
    await fakeRedis.setex(
      `apikey:ctx:${hashApiKey(VALID_KEY)}`, 60,
      JSON.stringify({ keyId: 'k1', userId: 'u1', plan: 'free' }),
    );
    const res = await buildApp().inject({
      url: '/v1/companies',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(200);
  });

  test('plano free em /v1/analysis → 403 PlanRequired', async () => {
    dbRows = [VALID_ROW];
    const res = await buildApp().inject({
      url: '/v1/analysis/ranking',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('PlanRequired');
  });

  test('plano pro em /v1/analysis → 200', async () => {
    dbRows = [{ ...VALID_ROW, plan: 'pro' }];
    const res = await buildApp().inject({
      url: '/v1/analysis/ranking',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(200);
  });

  test('planStatus canceled rebaixa para free → 403 em analysis', async () => {
    dbRows = [{ ...VALID_ROW, plan: 'pro', planStatus: 'canceled' }];
    const res = await buildApp().inject({
      url: '/v1/analysis/ranking',
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/api-key-auth.test.ts`
Expected: FAIL (`apiKeyAuthMiddleware` não existe).

- [ ] **Step 3: Reescrever `src/infra/http/middleware/auth.ts`**

Substituir TODO o conteúdo por:

```ts
/**
 * Auth por API key — hash SHA-256, cache Redis 60s, FAIL-CLOSED.
 *
 * Fluxo: x-api-key → hash → cache Redis (`apikey:ctx:<hash>`) → banco (join users).
 * Banco indisponível com cache frio → 503 (nunca libera sem validar).
 * Gating por plano: /v1/analysis e /v1/screener exigem analysisAccess.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { apiKeys, users } from '../../database/schema.ts';
import { redis } from '../../services/redis.ts';
import { hashApiKey } from '../../../core/services/api-key.ts';
import { canAccess, type Plan } from '../../../core/plans.ts';

export interface ApiKeyContext {
  keyId: string;
  userId: string;
  plan: Plan;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyContext?: ApiKeyContext;
  }
}

const CACHE_TTL_SECONDS = 60;

const PUBLIC_ROUTES = new Set(['/v1/healthcheck']);

function cacheKey(keyHash: string): string {
  return `apikey:ctx:${keyHash}`;
}

/** Invalida o cache de contexto de uma key (revogação imediata). */
export async function invalidateKeyCache(keyHash: string): Promise<void> {
  try {
    await redis.del(cacheKey(keyHash));
  } catch {
    // Redis fora: TTL de 60s resolve
  }
}

export async function apiKeyAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const routeUrl = request.routeOptions?.url ?? request.url.split('?')[0]!;
  if (PUBLIC_ROUTES.has(routeUrl)) return;

  const key = request.headers['x-api-key'] as string | undefined;
  if (!key) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Header x-api-key é obrigatório.' });
    return;
  }

  const keyHash = hashApiKey(key);
  let context: ApiKeyContext | null = null;

  // 1) Cache
  try {
    const cached = await redis.get(cacheKey(keyHash));
    if (cached === 'invalid') {
      reply.status(401).send({ error: 'Unauthorized', message: 'API key inválida ou inativa.' });
      return;
    }
    if (cached) context = JSON.parse(cached) as ApiKeyContext;
  } catch {
    // Redis fora → segue para o banco
  }

  // 2) Banco (fail-closed)
  if (!context) {
    let row:
      | { keyId: string; userId: string; plan: Plan; planStatus: string }
      | undefined;
    try {
      const rows = await db
        .select({
          keyId: apiKeys.id,
          userId: apiKeys.userId,
          plan: users.plan,
          planStatus: users.planStatus,
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.userId, users.id))
        .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.active, true)));
      row = rows[0];
    } catch {
      reply.status(503).send({
        error: 'ServiceUnavailable',
        message: 'Autenticação temporariamente indisponível. Tente novamente.',
      });
      return;
    }

    if (!row) {
      try {
        await redis.setex(cacheKey(keyHash), CACHE_TTL_SECONDS, 'invalid');
      } catch { /* ok */ }
      reply.status(401).send({ error: 'Unauthorized', message: 'API key inválida ou inativa.' });
      return;
    }

    const effectivePlan: Plan = row.planStatus === 'canceled' ? 'free' : row.plan;
    context = { keyId: row.keyId, userId: row.userId, plan: effectivePlan };

    try {
      await redis.setex(cacheKey(keyHash), CACHE_TTL_SECONDS, JSON.stringify(context));
    } catch { /* ok */ }

    updateLastUsed(context.keyId).catch(() => {});
  }

  // 3) Gating por plano
  if (!canAccess(context.plan, routeUrl)) {
    reply.status(403).send({
      error: 'PlanRequired',
      message: 'Este endpoint exige plano Pro ou Business. Faça upgrade no dashboard.',
    });
    return;
  }

  request.apiKeyContext = context;
}

async function updateLastUsed(keyId: string): Promise<void> {
  try {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
  } catch {
    // métrica secundária
  }
}
```

- [ ] **Step 4: Atualizar `src/infra/http/routes/index.ts`**

Trocar `import { authMiddleware }` por `import { apiKeyAuthMiddleware }` e o hook `app.addHook('onRequest', authMiddleware)` por `app.addHook('onRequest', apiKeyAuthMiddleware)`. Remover as 3 rotas `/keys` e o import de `auth.controller.ts` (o controller antigo morre na Task 11).

- [ ] **Step 5: Rodar testes e typecheck**

Run: `bun test tests/infra/api-key-auth.test.ts && bun run typecheck`
Expected: PASS. Se `auth.controller.ts` quebrar o typecheck por não estar mais importado, deletar o arquivo já nesta task e remover referências.

- [ ] **Step 6: Commit**

```bash
git add src/infra/http/middleware/auth.ts src/infra/http/routes/index.ts tests/infra/api-key-auth.test.ts
git commit -m "feat: auth por hash fail-closed com gating de plano"
```

---

### Task 7: Rate limiting (burst por minuto + teto mensal)

**Files:**
- Create: `src/core/services/rate-limit.ts` (matemática pura)
- Create: `src/infra/http/middleware/rate-limit.ts` (Redis)
- Modify: `src/infra/http/middleware/auth.ts` (integração no final do middleware)
- Test: `tests/core/rate-limit.test.ts`, `tests/infra/rate-limit.test.ts`

**Interfaces:**
- Consumes: `PLANS`, `isOverMonthlyLimit`, tipo `Plan` (Task 3); `ApiKeyContext` (Task 6).
- Produces: puro — `minuteWindow(nowMs): number`, `monthKey(now: Date): string`, `nextMonthResetEpoch(now: Date): number`, `secondsToNextMinute(nowMs): number`; infra — `checkRateLimit(ctx: ApiKeyContext, nowMs: number): Promise<RateLimitResult>` com `RateLimitResult = { allowed: true } | { allowed: false; reason: 'burst' | 'monthly'; limit: number; resetEpoch: number }`. Task 8 usa `monthKey`.

- [ ] **Step 1: Teste puro que falha**

`tests/core/rate-limit.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  minuteWindow, monthKey, nextMonthResetEpoch, secondsToNextMinute,
} from '../../src/core/services/rate-limit.ts';

describe('minuteWindow', () => {
  test('mesma janela dentro do minuto, muda no próximo', () => {
    const t = Date.UTC(2026, 6, 8, 12, 30, 5);
    expect(minuteWindow(t)).toBe(minuteWindow(t + 54_000));
    expect(minuteWindow(t + 60_000)).toBe(minuteWindow(t) + 1);
  });
});

describe('monthKey', () => {
  test('formato YYYY-MM em UTC', () => {
    expect(monthKey(new Date(Date.UTC(2026, 6, 8)))).toBe('2026-07');
    expect(monthKey(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12');
  });
});

describe('nextMonthResetEpoch', () => {
  test('primeiro dia do mês seguinte, em segundos', () => {
    const now = new Date(Date.UTC(2026, 6, 8));
    expect(nextMonthResetEpoch(now)).toBe(Date.UTC(2026, 7, 1) / 1000);
  });
  test('vira o ano em dezembro', () => {
    const now = new Date(Date.UTC(2026, 11, 15));
    expect(nextMonthResetEpoch(now)).toBe(Date.UTC(2027, 0, 1) / 1000);
  });
});

describe('secondsToNextMinute', () => {
  test('complemento do minuto', () => {
    expect(secondsToNextMinute(Date.UTC(2026, 6, 8, 12, 0, 45))).toBe(15);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/core/rate-limit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/core/services/rate-limit.ts`**

```ts
/** Matemática pura de janelas de rate limit (UTC). */

export function minuteWindow(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function nextMonthResetEpoch(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
}

export function secondsToNextMinute(nowMs: number): number {
  return 60 - Math.floor((nowMs % 60_000) / 1000);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test tests/core/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Teste de infra que falha**

`tests/infra/rate-limit.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

const { checkRateLimit } = await import('../../src/infra/http/middleware/rate-limit.ts');
const { monthKey } = await import('../../src/core/services/rate-limit.ts');

const CTX = { keyId: 'k1', userId: 'u1', plan: 'free' as const };
const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);

beforeEach(() => fakeRedis.store.clear());

describe('checkRateLimit', () => {
  test('permite dentro dos limites', async () => {
    const result = await checkRateLimit(CTX, NOW);
    expect(result.allowed).toBe(true);
  });

  test('bloqueia burst acima de reqPerMin (free = 10)', async () => {
    for (let i = 0; i < 10; i++) await checkRateLimit(CTX, NOW);
    const result = await checkRateLimit(CTX, NOW);
    expect(result).toMatchObject({ allowed: false, reason: 'burst', limit: 10 });
  });

  test('bloqueia teto mensal (free = 5000)', async () => {
    await fakeRedis.set(`usage:k1:${monthKey(new Date(NOW))}`, 5_000);
    const result = await checkRateLimit(CTX, NOW);
    expect(result).toMatchObject({ allowed: false, reason: 'monthly', limit: 5_000 });
  });

  test('redis fora → fail-open', async () => {
    const broken = { incr: async () => { throw new Error('down'); } };
    Object.assign(fakeRedis, { incr: broken.incr });
    const result = await checkRateLimit(CTX, NOW);
    expect(result.allowed).toBe(true);
    // restaura
    fakeRedis.incr = FakeRedis.prototype.incr.bind(fakeRedis);
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `bun test tests/infra/rate-limit.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implementar `src/infra/http/middleware/rate-limit.ts`**

```ts
/**
 * Rate limiting por key — Redis. FAIL-OPEN (Redis fora → deixa passar).
 * Burst: INCR rl:<keyId>:<janela-minuto>, TTL 60s.
 * Mensal: lê contador de metering usage:<keyId>:<YYYY-MM>.
 */

import { redis } from '../../services/redis.ts';
import { PLANS } from '../../../core/plans.ts';
import {
  minuteWindow, monthKey, nextMonthResetEpoch, secondsToNextMinute,
} from '../../../core/services/rate-limit.ts';
import type { ApiKeyContext } from './auth.ts';

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: 'burst' | 'monthly'; limit: number; resetEpoch: number };

export async function checkRateLimit(
  context: ApiKeyContext,
  nowMs: number,
): Promise<RateLimitResult> {
  const limits = PLANS[context.plan];

  try {
    const burstKey = `rl:${context.keyId}:${minuteWindow(nowMs)}`;
    const burstCount = await redis.incr(burstKey);
    if (burstCount === 1) await redis.expire(burstKey, 60);
    if (burstCount > limits.reqPerMin) {
      return {
        allowed: false,
        reason: 'burst',
        limit: limits.reqPerMin,
        resetEpoch: Math.floor(nowMs / 1000) + secondsToNextMinute(nowMs),
      };
    }

    const now = new Date(nowMs);
    const monthly = Number((await redis.get(`usage:${context.keyId}:${monthKey(now)}`)) ?? '0');
    if (monthly >= limits.reqPerMonth) {
      return {
        allowed: false,
        reason: 'monthly',
        limit: limits.reqPerMonth,
        resetEpoch: nextMonthResetEpoch(now),
      };
    }

    return { allowed: true };
  } catch {
    // Redis indisponível → rate limit desativado temporariamente
    return { allowed: true };
  }
}
```

- [ ] **Step 8: Integrar no `auth.ts` (antes de `request.apiKeyContext = context;`)**

```ts
  // 4) Rate limiting (fail-open)
  const rateLimit = await checkRateLimit(context, Date.now());
  if (!rateLimit.allowed) {
    reply
      .status(429)
      .header('x-ratelimit-limit', String(rateLimit.limit))
      .header('x-ratelimit-remaining', '0')
      .header('x-ratelimit-reset', String(rateLimit.resetEpoch))
      .send({
        error: 'RateLimitExceeded',
        message:
          rateLimit.reason === 'burst'
            ? 'Limite de requisições por minuto excedido.'
            : 'Cota mensal do plano excedida. Faça upgrade ou aguarde o próximo ciclo.',
      });
    return;
  }
```

Com import: `import { checkRateLimit } from './rate-limit.ts';`

- [ ] **Step 9: Adicionar teste de 429 em `tests/infra/api-key-auth.test.ts`**

```ts
  test('estouro de burst → 429 com headers', async () => {
    dbRows = [VALID_ROW];
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      await app.inject({ url: '/v1/companies', headers: { 'x-api-key': VALID_KEY } });
    }
    const res = await app.inject({ url: '/v1/companies', headers: { 'x-api-key': VALID_KEY } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });
```

- [ ] **Step 10: Rodar tudo e commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/core/services/rate-limit.ts src/infra/http/middleware/rate-limit.ts src/infra/http/middleware/auth.ts tests/core/rate-limit.test.ts tests/infra/rate-limit.test.ts tests/infra/api-key-auth.test.ts
git commit -m "feat: rate limiting por key (burst e teto mensal)"
```

---

### Task 8: Metering — hook onResponse + chaves de uso

**Files:**
- Create: `src/core/services/usage-keys.ts`
- Create: `src/infra/http/middleware/metering.ts`
- Modify: `src/infra/http/routes/index.ts` (registrar hook)
- Test: `tests/core/usage-keys.test.ts`, `tests/infra/metering.test.ts`

**Interfaces:**
- Consumes: `monthKey` (Task 7); `request.apiKeyContext` (Task 6).
- Produces: `buildUsageKeys(keyId, month, endpoint): { total: string; byEndpoint: string }`; `parseUsageKey(redisKey): { keyId, month, endpoint } | null` (endpoint `_total` para chave agregada); `meteringHook(request, reply)` (onResponse). Task 9 usa `parseUsageKey`.

- [ ] **Step 1: Teste puro que falha**

`tests/core/usage-keys.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildUsageKeys, parseUsageKey } from '../../src/core/services/usage-keys.ts';

describe('buildUsageKeys', () => {
  test('gera chave total e por endpoint', () => {
    expect(buildUsageKeys('k1', '2026-07', '/v1/stocks/:ticker/quote')).toEqual({
      total: 'usage:k1:2026-07',
      byEndpoint: 'usage:k1:2026-07:/v1/stocks/:ticker/quote',
    });
  });
});

describe('parseUsageKey', () => {
  test('chave total → endpoint _total', () => {
    expect(parseUsageKey('usage:k1:2026-07')).toEqual({
      keyId: 'k1', month: '2026-07', endpoint: '_total',
    });
  });
  test('endpoint com dois-pontos (params de rota) preservado', () => {
    expect(parseUsageKey('usage:k1:2026-07:/v1/stocks/:ticker/quote')).toEqual({
      keyId: 'k1', month: '2026-07', endpoint: '/v1/stocks/:ticker/quote',
    });
  });
  test('chaves não-usage retornam null', () => {
    expect(parseUsageKey('rl:k1:123')).toBeNull();
    expect(parseUsageKey('usage:k1:invalido')).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/core/usage-keys.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/core/services/usage-keys.ts`**

```ts
/**
 * Convenção de chaves de metering no Redis.
 *   usage:<keyId>:<YYYY-MM>              → total do mês
 *   usage:<keyId>:<YYYY-MM>:<endpoint>   → por endpoint (endpoint pode conter ':')
 */

export interface ParsedUsageKey {
  keyId: string;
  month: string;
  endpoint: string;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export function buildUsageKeys(
  keyId: string,
  month: string,
  endpoint: string,
): { total: string; byEndpoint: string } {
  return {
    total: `usage:${keyId}:${month}`,
    byEndpoint: `usage:${keyId}:${month}:${endpoint}`,
  };
}

export function parseUsageKey(redisKey: string): ParsedUsageKey | null {
  const parts = redisKey.split(':');
  if (parts[0] !== 'usage' || parts.length < 3) return null;
  const [, keyId, month, ...rest] = parts;
  if (!keyId || !month || !MONTH_PATTERN.test(month)) return null;
  return { keyId, month, endpoint: rest.length > 0 ? rest.join(':') : '_total' };
}
```

- [ ] **Step 4: Rodar e ver passar; teste de infra que falha**

Run: `bun test tests/core/usage-keys.test.ts` → PASS.

`tests/infra/metering.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

const { meteringHook } = await import('../../src/infra/http/middleware/metering.ts');
const { monthKey } = await import('../../src/core/services/rate-limit.ts');

const MONTH = monthKey(new Date());

function buildApp(withContext: boolean) {
  const app = Fastify();
  if (withContext) {
    app.addHook('onRequest', async (request) => {
      request.apiKeyContext = { keyId: 'k1', userId: 'u1', plan: 'free' };
    });
  }
  app.addHook('onResponse', meteringHook);
  app.get('/v1/companies', async () => ({ ok: true }));
  return app;
}

beforeEach(() => fakeRedis.store.clear());

describe('meteringHook', () => {
  test('incrementa total e por endpoint em request autenticado', async () => {
    const app = buildApp(true);
    await app.inject({ url: '/v1/companies' });
    await app.inject({ url: '/v1/companies' });
    expect(fakeRedis.store.get(`usage:k1:${MONTH}`)).toBe('2');
    expect(fakeRedis.store.get(`usage:k1:${MONTH}:/v1/companies`)).toBe('2');
  });

  test('sem apiKeyContext (rota pública/401) → não conta', async () => {
    const app = buildApp(false);
    await app.inject({ url: '/v1/companies' });
    expect(fakeRedis.store.size).toBe(0);
  });
});
```

Run: `bun test tests/infra/metering.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implementar `src/infra/http/middleware/metering.ts`**

```ts
/**
 * Metering — hook onResponse. Conta requests autenticados por key/mês/endpoint.
 * 429 e 5xx não contam. Redis fora → não conta (best-effort).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../../services/redis.ts';
import { monthKey } from '../../../core/services/rate-limit.ts';
import { buildUsageKeys } from '../../../core/services/usage-keys.ts';

const USAGE_TTL_SECONDS = 60 * 60 * 24 * 40; // 40 dias — sobrevive à virada do mês

export async function meteringHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const context = request.apiKeyContext;
  if (!context) return;
  if (reply.statusCode === 429 || reply.statusCode >= 500) return;

  const endpoint = request.routeOptions?.url ?? request.url.split('?')[0]!;
  const keys = buildUsageKeys(context.keyId, monthKey(new Date()), endpoint);

  try {
    const [total, byEndpoint] = await Promise.all([
      redis.incr(keys.total),
      redis.incr(keys.byEndpoint),
    ]);
    const expirations: Promise<unknown>[] = [];
    if (total === 1) expirations.push(redis.expire(keys.total, USAGE_TTL_SECONDS));
    if (byEndpoint === 1) expirations.push(redis.expire(keys.byEndpoint, USAGE_TTL_SECONDS));
    await Promise.all(expirations);
  } catch {
    // metering é best-effort
  }
}
```

- [ ] **Step 6: Registrar hook em `src/infra/http/routes/index.ts`**

Logo após o hook de auth:

```ts
import { meteringHook } from '../middleware/metering.ts';
// ...
app.addHook('onResponse', meteringHook);
```

- [ ] **Step 7: Rodar tudo e commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/core/services/usage-keys.ts src/infra/http/middleware/metering.ts src/infra/http/routes/index.ts tests/core/usage-keys.test.ts tests/infra/metering.test.ts
git commit -m "feat: metering de uso por key/mês/endpoint no redis"
```

---

### Task 9: Worker de flush de uso (Redis → Postgres)

**Files:**
- Create: `src/infra/workers/usage-flush-worker.ts`
- Test: `tests/infra/usage-flush.test.ts`

**Interfaces:**
- Consumes: `parseUsageKey` (Task 8); `usageMonthly`, `apiKeys` (Task 2); `redis`.
- Produces: `flushUsage(): Promise<number>` (exportada para teste; retorna nº de chaves persistidas). Script roda `flushUsage` a cada 5 min via `setInterval`. Task 14 lê `usage_monthly`.

- [ ] **Step 1: Teste que falha**

`tests/infra/usage-flush.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

// Captura upserts; select de userId responde fixo
const upserts: Record<string, unknown>[] = [];
const chain: Record<string, unknown> = {};
chain.select = () => chain;
chain.from = () => chain;
chain.where = async () => [{ userId: 'u1' }];
chain.insert = () => chain;
chain.values = (v: Record<string, unknown>) => {
  upserts.push(v);
  return chain;
};
chain.onConflictDoUpdate = async () => undefined;
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const { flushUsage } = await import('../../src/infra/workers/usage-flush-worker.ts');

beforeEach(() => {
  fakeRedis.store.clear();
  upserts.length = 0;
});

describe('flushUsage', () => {
  test('persiste contadores usage:* com endpoint e _total', async () => {
    await fakeRedis.set('usage:k1:2026-07', 42);
    await fakeRedis.set('usage:k1:2026-07:/v1/companies', 40);
    await fakeRedis.set('rl:k1:123', 9); // ignorada

    const flushed = await flushUsage();
    expect(flushed).toBe(2);
    const endpoints = upserts.map((u) => u.endpoint).sort();
    expect(endpoints).toEqual(['/v1/companies', '_total']);
    expect(upserts.every((u) => u.userId === 'u1')).toBe(true);
  });

  test('sem chaves → 0', async () => {
    expect(await flushUsage()).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/usage-flush.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/infra/workers/usage-flush-worker.ts`**

```ts
/**
 * Usage Flush Worker — copia contadores usage:* do Redis para usage_monthly (upsert).
 * Redis permanece a fonte de verdade do mês corrente; o Postgres serve dashboard/histórico.
 * Roda a cada 5 minutos. Idempotente (upsert de valor absoluto, não incremento).
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { apiKeys, usageMonthly } from '../database/schema.ts';
import { redis } from '../services/redis.ts';
import { parseUsageKey } from '../../core/services/usage-keys.ts';

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export async function flushUsage(): Promise<number> {
  const userIdByKey = new Map<string, string | null>();
  let cursor = '0';
  let flushed = 0;

  do {
    const [nextCursor, redisKeys] = await redis.scan(cursor, 'MATCH', 'usage:*', 'COUNT', 200);
    cursor = nextCursor;

    for (const redisKey of redisKeys) {
      const parsed = parseUsageKey(redisKey);
      if (!parsed) continue;

      const count = Number((await redis.get(redisKey)) ?? '0');
      if (count === 0) continue;

      if (!userIdByKey.has(parsed.keyId)) {
        const rows = await db
          .select({ userId: apiKeys.userId })
          .from(apiKeys)
          .where(eq(apiKeys.id, parsed.keyId));
        userIdByKey.set(parsed.keyId, rows[0]?.userId ?? null);
      }
      const userId = userIdByKey.get(parsed.keyId);
      if (!userId) continue; // key deletada — contador expira sozinho

      await db
        .insert(usageMonthly)
        .values({
          keyId: parsed.keyId,
          userId,
          month: parsed.month,
          endpoint: parsed.endpoint,
          count,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [usageMonthly.keyId, usageMonthly.month, usageMonthly.endpoint],
          set: { count, updatedAt: new Date() },
        });
      flushed++;
    }
  } while (cursor !== '0');

  return flushed;
}

// Execução direta como worker (não em import de teste)
if (import.meta.main) {
  const run = async (): Promise<void> => {
    try {
      const flushed = await flushUsage();
      console.log(`[usage-flush] ${flushed} contadores persistidos`);
    } catch (error) {
      console.error('[usage-flush] falha:', error);
    }
  };
  await run();
  setInterval(run, FLUSH_INTERVAL_MS);
  console.log('[usage-flush] worker ativo (5 min)');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test tests/infra/usage-flush.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infra/workers/usage-flush-worker.ts tests/infra/usage-flush.test.ts
git commit -m "feat: worker de flush de uso redis para postgres"
```

---

### Task 10: Portal — middleware de sessão e rotas de auth

**Files:**
- Create: `src/infra/http/middleware/portal-auth.ts`
- Create: `src/infra/http/controllers/portal/auth.controller.ts`
- Create: `src/infra/http/routes/portal.ts`
- Modify: `src/server.ts` (registrar `@fastify/cookie` + plugin portal)
- Test: `tests/infra/portal-auth.test.ts`

**Interfaces:**
- Consumes: sessão (Task 5); `users` (Task 2); `sendMagicLinkEmail` (Task 5); `env.DASHBOARD_URL`.
- Produces: `portalAuthMiddleware` (exige cookie `urano_session`, popula `request.portalUserId: string`); rotas `POST /v1/portal/auth/request-link`, `POST /v1/portal/auth/verify`, `POST /v1/portal/auth/logout`. Cookie: `httpOnly`, `sameSite: 'lax'`, `secure` em produção, `path: '/'`, maxAge 30 dias. Tasks 11, 12, 14 usam `portalUserId`.

- [ ] **Step 1: Teste que falha**

`tests/infra/portal-auth.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

// users: findByEmail/insert stub
let userRows: Record<string, unknown>[] = [];
const chain: Record<string, unknown> = {};
for (const m of ['select', 'from', 'insert', 'update', 'set']) chain[m] = () => chain;
chain.where = async () => userRows;
chain.limit = async () => userRows;
chain.values = () => chain;
chain.returning = async () => [{ id: 'novo-user', email: 'a@b.com', plan: 'free' }];
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const sentEmails: { email: string; link: string }[] = [];
mock.module('../../src/infra/services/email.ts', () => ({
  sendMagicLinkEmail: async (email: string, link: string) => {
    sentEmails.push({ email, link });
  },
}));

const { portalPlugin } = await import('../../src/infra/http/routes/portal.ts');
const { createSession, createMagicLink } = await import('../../src/infra/auth/session.ts');

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(portalPlugin, { prefix: '/v1' });
  return app;
}

beforeEach(() => {
  fakeRedis.store.clear();
  userRows = [];
  sentEmails.length = 0;
});

describe('portal auth', () => {
  test('request-link responde 200 e dispara e-mail', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/auth/request-link',
      payload: { email: 'a@b.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.link).toContain('token=');
  });

  test('verify com token válido cria usuário e seta cookie', async () => {
    const app = await buildApp();
    const token = await createMagicLink('a@b.com');
    userRows = []; // usuário não existe → cria
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/auth/verify',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('urano_session=');
  });

  test('verify com token inválido → 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/auth/verify',
      payload: { token: 'x'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });

  test('rota protegida sem cookie → 401; com sessão → 200', async () => {
    const app = await buildApp();
    const noAuth = await app.inject({ method: 'POST', url: '/v1/portal/auth/logout' });
    expect(noAuth.statusCode).toBe(401);

    const session = await createSession('u1');
    const withAuth = await app.inject({
      method: 'POST',
      url: '/v1/portal/auth/logout',
      cookies: { urano_session: session },
    });
    expect(withAuth.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/portal-auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/infra/http/middleware/portal-auth.ts`**

```ts
/** Auth do portal — cookie de sessão Redis. Rotas /v1/portal/auth/* são públicas. */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUserId } from '../../auth/session.ts';

declare module 'fastify' {
  interface FastifyRequest {
    portalUserId?: string;
    portalSessionToken?: string;
  }
}

const PUBLIC_PREFIX = '/v1/portal/auth/';
const PUBLIC_EXCEPTIONS = new Set(['/v1/portal/auth/logout']);

export async function portalAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const routeUrl = request.routeOptions?.url ?? request.url.split('?')[0]!;
  if (routeUrl.startsWith(PUBLIC_PREFIX) && !PUBLIC_EXCEPTIONS.has(routeUrl)) return;

  const token = request.cookies?.urano_session;
  if (!token) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Sessão ausente. Faça login.' });
    return;
  }

  let userId: string | null = null;
  try {
    userId = await getSessionUserId(token);
  } catch {
    reply.status(503).send({
      error: 'ServiceUnavailable',
      message: 'Sessões temporariamente indisponíveis.',
    });
    return;
  }

  if (!userId) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Sessão inválida ou expirada.' });
    return;
  }

  request.portalUserId = userId;
  request.portalSessionToken = token;
}
```

- [ ] **Step 4: Implementar `src/infra/http/controllers/portal/auth.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { users } from '../../../database/schema.ts';
import {
  createMagicLink, consumeMagicLink, createSession, destroySession,
} from '../../../auth/session.ts';
import { sendMagicLinkEmail } from '../../../services/email.ts';
import { env } from '../../../../config/env.ts';

const SESSION_COOKIE = 'urano_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const requestLinkSchema = z.object({ email: z.string().email().max(255) });
const verifySchema = z.object({ token: z.string().length(64) });

/** POST /v1/portal/auth/request-link — sempre 200 (sem enumeração de usuários). */
export async function requestLinkController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = requestLinkSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'E-mail inválido.' });
    return;
  }

  const token = await createMagicLink(parsed.data.email);
  const link = `${env.DASHBOARD_URL}/auth/callback?token=${token}`;
  try {
    await sendMagicLinkEmail(parsed.data.email, link);
  } catch (error) {
    request.log.error({ error }, 'Falha ao enviar magic link');
  }

  reply.send({ message: 'Se o e-mail for válido, você receberá um link de acesso.' });
}

/** POST /v1/portal/auth/verify — troca token por sessão; cria usuário no primeiro login. */
export async function verifyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = verifySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'Token inválido.' });
    return;
  }

  const email = await consumeMagicLink(parsed.data.token);
  if (!email) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Link inválido ou expirado.' });
    return;
  }

  const existing = await db.select().from(users).where(eq(users.email, email));
  let user = existing[0];
  if (!user) {
    const inserted = await db.insert(users).values({ email }).returning();
    user = inserted[0]!;
  }

  const session = await createSession(user.id);
  reply
    .setCookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    })
    .send({ user: { id: user.id, email: user.email, plan: user.plan } });
}

/** POST /v1/portal/auth/logout */
export async function logoutController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.portalSessionToken) await destroySession(request.portalSessionToken);
  reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ message: 'Sessão encerrada.' });
}
```

- [ ] **Step 5: Implementar `src/infra/http/routes/portal.ts`**

```ts
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { portalAuthMiddleware } from '../middleware/portal-auth.ts';
import {
  requestLinkController, verifyController, logoutController,
} from '../controllers/portal/auth.controller.ts';

export async function portalPlugin(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.addHook('onRequest', portalAuthMiddleware);

  app.post('/portal/auth/request-link', requestLinkController);
  app.post('/portal/auth/verify', verifyController);
  app.post('/portal/auth/logout', logoutController);
}
```

- [ ] **Step 6: Registrar em `src/server.ts`**

Após criar o app e antes de `routesPlugin`:

```ts
import cookie from '@fastify/cookie';
import { portalPlugin } from './infra/http/routes/portal.ts';
// ...
await app.register(cookie);
await app.register(portalPlugin, { prefix: '/v1' });
```

- [ ] **Step 7: Rodar tudo e commit**

Run: `bun test tests/infra/portal-auth.test.ts && bun run typecheck`
Expected: PASS.

```bash
git add src/infra/http/middleware/portal-auth.ts src/infra/http/controllers/portal/auth.controller.ts src/infra/http/routes/portal.ts src/server.ts tests/infra/portal-auth.test.ts
git commit -m "feat: portal com login por magic link e sessão em cookie"
```

---

### Task 11: Portal — gestão de keys e /me (mata o /v1/keys público)

**Files:**
- Create: `src/infra/http/controllers/portal/keys.controller.ts`
- Create: `src/infra/http/controllers/portal/me.controller.ts`
- Modify: `src/infra/http/routes/portal.ts`
- Delete: `src/infra/http/controllers/auth.controller.ts` (se ainda existir)
- Test: `tests/infra/portal-keys.test.ts`

**Interfaces:**
- Consumes: `generateApiKey`, `hashApiKey`, `apiKeyPrefix` (Task 4); `PLANS` (Task 3); `invalidateKeyCache` (Task 6); `portalUserId` (Task 10).
- Produces: `POST /v1/portal/keys` (201, retorna key completa UMA vez), `GET /v1/portal/keys` (só prefixo), `DELETE /v1/portal/keys/:id` (revoga + invalida cache), `GET /v1/portal/me` (user + plano + limites).

- [ ] **Step 1: Teste que falha**

`tests/infra/portal-keys.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

// db stub: users (plan free, maxKeys 1), apiKeys count e insert
let activeKeyCount = 0;
let insertedValues: Record<string, unknown> | null = null;
let updatedKeyRows: Record<string, unknown>[] = [];
const userRow = { id: 'u1', email: 'a@b.com', plan: 'free', planStatus: 'active' };
const chain: Record<string, unknown> = {};
chain.select = (fields?: Record<string, unknown>) => {
  chain._selecting = fields ? Object.keys(fields).join(',') : 'all';
  return chain;
};
chain.from = () => chain;
chain.where = async () => {
  if (chain._selecting === 'count') return [{ count: activeKeyCount }];
  if (chain._selecting?.toString().includes('email')) return [userRow];
  return updatedKeyRows;
};
chain.insert = () => chain;
chain.values = (v: Record<string, unknown>) => {
  insertedValues = v;
  return chain;
};
chain.returning = async () => [{ id: 'key-1', name: insertedValues?.name, keyPrefix: insertedValues?.keyPrefix, active: true, createdAt: new Date() }];
chain.update = () => chain;
chain.set = () => chain;
chain.orderBy = async () => updatedKeyRows;
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const { portalPlugin } = await import('../../src/infra/http/routes/portal.ts');
const { createSession } = await import('../../src/infra/auth/session.ts');

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(portalPlugin, { prefix: '/v1' });
  return app;
}

let sessionToken: string;
beforeEach(async () => {
  fakeRedis.store.clear();
  activeKeyCount = 0;
  insertedValues = null;
  updatedKeyRows = [];
  sessionToken = await createSession('u1');
});

describe('portal keys', () => {
  test('cria key: retorna key completa uma vez, persiste só hash', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/keys',
      cookies: { urano_session: sessionToken },
      payload: { name: 'produção' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^ur_[0-9a-f]{64}$/);
    expect(insertedValues!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(insertedValues!).not.toHaveProperty('key');
  });

  test('plano free com 1 key ativa → 403 ao criar segunda', async () => {
    activeKeyCount = 1;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/keys',
      cookies: { urano_session: sessionToken },
      payload: { name: 'segunda' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('PlanLimit');
  });

  test('revogar key invalida cache do hash', async () => {
    updatedKeyRows = [{ id: 'key-1', keyHash: 'f'.repeat(64) }];
    await fakeRedis.setex(`apikey:ctx:${'f'.repeat(64)}`, 60, '{"keyId":"key-1"}');
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/portal/keys/6f1b0f66-0000-0000-0000-000000000000',
      cookies: { urano_session: sessionToken },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeRedis.store.has(`apikey:ctx:${'f'.repeat(64)}`)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/portal-keys.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/infra/http/controllers/portal/keys.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { apiKeys, users } from '../../../database/schema.ts';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../../../core/services/api-key.ts';
import { PLANS, type Plan } from '../../../../core/plans.ts';
import { invalidateKeyCache } from '../../middleware/auth.ts';

const createKeySchema = z.object({ name: z.string().min(1).max(100) });
const deleteParamsSchema = z.object({ id: z.string().uuid() });

/** POST /v1/portal/keys */
export async function createKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createKeySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'Nome da key inválido.' });
    return;
  }
  const userId = request.portalUserId!;

  const userRows = await db
    .select({ email: users.email, plan: users.plan })
    .from(users)
    .where(eq(users.id, userId));
  const plan = (userRows[0]?.plan ?? 'free') as Plan;

  const countRows = await db
    .select({ count: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.active, true)));
  const activeKeys = Number(countRows[0]?.count ?? 0);

  if (activeKeys >= PLANS[plan].maxKeys) {
    reply.status(403).send({
      error: 'PlanLimit',
      message: `Seu plano permite ${PLANS[plan].maxKeys} key(s) ativa(s). Revogue uma ou faça upgrade.`,
    });
    return;
  }

  const key = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name: parsed.data.name,
      keyHash: hashApiKey(key),
      keyPrefix: apiKeyPrefix(key),
    })
    .returning();

  reply.status(201).send({
    id: row!.id,
    name: row!.name,
    key,
    keyPrefix: row!.keyPrefix,
    createdAt: row!.createdAt?.toISOString(),
    message: 'Guarde esta chave. Por segurança, ela não será exibida novamente.',
  });
}

/** GET /v1/portal/keys */
export async function listKeysController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      active: apiKeys.active,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, request.portalUserId!))
    .orderBy(desc(apiKeys.createdAt));

  reply.send({ total: rows.length, data: rows });
}

/** DELETE /v1/portal/keys/:id — revoga e invalida cache imediatamente. */
export async function revokeKeyController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = deleteParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'ID inválido.' });
    return;
  }

  const [updated] = await db
    .update(apiKeys)
    .set({ active: false })
    .where(and(eq(apiKeys.id, parsed.data.id), eq(apiKeys.userId, request.portalUserId!)))
    .returning({ id: apiKeys.id, keyHash: apiKeys.keyHash });

  if (!updated) {
    reply.status(404).send({ error: 'NotFound', message: 'API Key não encontrada.' });
    return;
  }

  await invalidateKeyCache(updated.keyHash);
  reply.send({ message: 'API Key revogada.', id: updated.id });
}
```

- [ ] **Step 4: Implementar `src/infra/http/controllers/portal/me.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { users } from '../../../database/schema.ts';
import { PLANS, type Plan } from '../../../../core/plans.ts';

/** GET /v1/portal/me */
export async function meController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      plan: users.plan,
      planStatus: users.planStatus,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, request.portalUserId!));

  const user = rows[0];
  if (!user) {
    reply.status(404).send({ error: 'NotFound', message: 'Usuário não encontrado.' });
    return;
  }

  reply.send({ user, limits: PLANS[user.plan as Plan] });
}
```

- [ ] **Step 5: Registrar rotas em `portal.ts` e deletar controller antigo**

Em `src/infra/http/routes/portal.ts`, adicionar:

```ts
import { createKeyController, listKeysController, revokeKeyController } from '../controllers/portal/keys.controller.ts';
import { meController } from '../controllers/portal/me.controller.ts';
// ...
  app.get('/portal/me', meController);
  app.post('/portal/keys', createKeyController);
  app.get('/portal/keys', listKeysController);
  app.delete('/portal/keys/:id', revokeKeyController);
```

Run: `rm -f src/infra/http/controllers/auth.controller.ts` (e conferir que nada mais o importa: `grep -r "auth.controller" src/`).

- [ ] **Step 6: Rodar tudo e commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add -A src/infra/http tests/infra/portal-keys.test.ts
git commit -m "feat: gestão de keys no portal e remoção do endpoint público de keys"
```

---

### Task 12: Stripe — reducer puro, service e endpoints de checkout/portal

**Files:**
- Create: `src/core/services/stripe-plan.ts`
- Create: `src/infra/services/stripe.ts`
- Create: `src/infra/http/controllers/portal/billing.controller.ts`
- Modify: `src/infra/http/routes/portal.ts`
- Test: `tests/core/stripe-plan.test.ts`

**Interfaces:**
- Consumes: `env.STRIPE_*`, `env.DASHBOARD_URL` (Task 1); `users` (Task 2); `portalUserId` (Task 10).
- Produces: `reduceStripeEvent(event): StripeAction` com `StripeAction = { type: 'activate'; plan: 'pro' | 'business'; userId: string; customerId: string } | { type: 'past_due'; customerId: string } | { type: 'downgrade'; customerId: string } | { type: 'ignore' }`; `stripe` (instância SDK); `POST /v1/portal/billing/checkout` `{ plan }` → `{ url }`; `POST /v1/portal/billing/portal` → `{ url }`. Task 13 usa `reduceStripeEvent` + `stripe`.

- [ ] **Step 1: Teste do reducer que falha**

`tests/core/stripe-plan.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { reduceStripeEvent } from '../../src/core/services/stripe-plan.ts';

describe('reduceStripeEvent', () => {
  test('checkout.session.completed → activate com plan/userId/customer', () => {
    const action = reduceStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', client_reference_id: 'u1', metadata: { plan: 'pro' } } },
    });
    expect(action).toEqual({ type: 'activate', plan: 'pro', userId: 'u1', customerId: 'cus_1' });
  });

  test('checkout sem metadata.plan válido → ignore', () => {
    const action = reduceStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', client_reference_id: 'u1', metadata: {} } },
    });
    expect(action).toEqual({ type: 'ignore' });
  });

  test('invoice.payment_failed → past_due', () => {
    const action = reduceStripeEvent({
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_1' } },
    });
    expect(action).toEqual({ type: 'past_due', customerId: 'cus_1' });
  });

  test('customer.subscription.deleted → downgrade', () => {
    const action = reduceStripeEvent({
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_1' } },
    });
    expect(action).toEqual({ type: 'downgrade', customerId: 'cus_1' });
  });

  test('evento desconhecido → ignore', () => {
    expect(reduceStripeEvent({ type: 'charge.refunded', data: { object: {} } }))
      .toEqual({ type: 'ignore' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/core/stripe-plan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/core/services/stripe-plan.ts`**

```ts
/**
 * Reducer puro de eventos Stripe → ação sobre o plano do usuário.
 * O checkout é criado com client_reference_id = userId e metadata.plan.
 */

export type StripeAction =
  | { type: 'activate'; plan: 'pro' | 'business'; userId: string; customerId: string }
  | { type: 'past_due'; customerId: string }
  | { type: 'downgrade'; customerId: string }
  | { type: 'ignore' };

interface StripeEventLike {
  type: string;
  data: { object: Record<string, unknown> };
}

export function reduceStripeEvent(event: StripeEventLike): StripeAction {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const plan = (object.metadata as Record<string, string> | undefined)?.plan;
      const userId = object.client_reference_id;
      const customerId = object.customer;
      if ((plan === 'pro' || plan === 'business') && typeof userId === 'string' && typeof customerId === 'string') {
        return { type: 'activate', plan, userId, customerId };
      }
      return { type: 'ignore' };
    }
    case 'invoice.payment_failed': {
      if (typeof object.customer === 'string') {
        return { type: 'past_due', customerId: object.customer };
      }
      return { type: 'ignore' };
    }
    case 'customer.subscription.deleted': {
      if (typeof object.customer === 'string') {
        return { type: 'downgrade', customerId: object.customer };
      }
      return { type: 'ignore' };
    }
    default:
      return { type: 'ignore' };
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test tests/core/stripe-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Implementar `src/infra/services/stripe.ts`**

```ts
import Stripe from 'stripe';
import { env } from '../../config/env.ts';

/** Instância única do SDK. Sem STRIPE_SECRET_KEY (dev) os endpoints de billing retornam 503. */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

export function stripeConfigured(): boolean {
  return env.STRIPE_SECRET_KEY.length > 0;
}

export function priceIdForPlan(plan: 'pro' | 'business'): string {
  return plan === 'pro' ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_BUSINESS;
}
```

- [ ] **Step 6: Implementar `src/infra/http/controllers/portal/billing.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { users } from '../../../database/schema.ts';
import { stripe, stripeConfigured, priceIdForPlan } from '../../../services/stripe.ts';
import { env } from '../../../../config/env.ts';

const checkoutSchema = z.object({ plan: z.enum(['pro', 'business']) });

/** POST /v1/portal/billing/checkout — cria sessão Stripe Checkout e retorna URL. */
export async function createCheckoutController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!stripeConfigured()) {
    reply.status(503).send({ error: 'BillingUnavailable', message: 'Billing não configurado.' });
    return;
  }
  const parsed = checkoutSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'Plano inválido.' });
    return;
  }

  const userId = request.portalUserId!;
  const rows = await db
    .select({ email: users.email, stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId));
  const user = rows[0];
  if (!user) {
    reply.status(404).send({ error: 'NotFound', message: 'Usuário não encontrado.' });
    return;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceIdForPlan(parsed.data.plan), quantity: 1 }],
    client_reference_id: userId,
    metadata: { plan: parsed.data.plan },
    ...(user.stripeCustomerId
      ? { customer: user.stripeCustomerId }
      : { customer_email: user.email }),
    success_url: `${env.DASHBOARD_URL}/billing?status=success`,
    cancel_url: `${env.DASHBOARD_URL}/billing?status=canceled`,
  });

  reply.send({ url: session.url });
}

/** POST /v1/portal/billing/portal — sessão do Stripe Customer Portal. */
export async function createPortalSessionController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!stripeConfigured()) {
    reply.status(503).send({ error: 'BillingUnavailable', message: 'Billing não configurado.' });
    return;
  }

  const rows = await db
    .select({ stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, request.portalUserId!));
  const customerId = rows[0]?.stripeCustomerId;
  if (!customerId) {
    reply.status(400).send({
      error: 'NoSubscription',
      message: 'Nenhuma assinatura encontrada. Assine um plano primeiro.',
    });
    return;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.DASHBOARD_URL}/billing`,
  });

  reply.send({ url: session.url });
}
```

- [ ] **Step 7: Registrar rotas em `portal.ts`**

```ts
import { createCheckoutController, createPortalSessionController } from '../controllers/portal/billing.controller.ts';
// ...
  app.post('/portal/billing/checkout', createCheckoutController);
  app.post('/portal/billing/portal', createPortalSessionController);
```

- [ ] **Step 8: Rodar tudo e commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/core/services/stripe-plan.ts src/infra/services/stripe.ts src/infra/http/controllers/portal/billing.controller.ts src/infra/http/routes/portal.ts tests/core/stripe-plan.test.ts
git commit -m "feat: checkout e customer portal stripe no portal"
```

---

### Task 13: Webhook Stripe — assinatura, idempotência, transições de plano

**Files:**
- Create: `src/infra/http/routes/webhooks.ts`
- Create: `src/infra/http/controllers/webhooks/stripe.controller.ts`
- Modify: `src/server.ts` (registrar plugin)
- Test: `tests/infra/stripe-webhook.test.ts`

**Interfaces:**
- Consumes: `reduceStripeEvent` (Task 12); `stripe` SDK (validação de assinatura); `users`, `stripeEvents` (Task 2); `env.STRIPE_WEBHOOK_SECRET`.
- Produces: `POST /v1/webhooks/stripe` — público, body raw (Buffer), 400 em assinatura inválida, 200 `{ received: true }` sempre que processado ou duplicado.

- [ ] **Step 1: Teste que falha**

`tests/infra/stripe-webhook.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import Stripe from 'stripe';

// env com webhook secret de teste
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const userUpdates: Record<string, unknown>[] = [];
let eventInsertConflict = false;
const chain: Record<string, unknown> = {};
chain.insert = () => chain;
chain.values = () => chain;
chain.onConflictDoNothing = () => chain;
chain.returning = async () => (eventInsertConflict ? [] : [{ id: 'evt_1' }]);
chain.update = () => chain;
chain.set = (v: Record<string, unknown>) => {
  userUpdates.push(v);
  return chain;
};
chain.where = async () => [];
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const { webhooksPlugin } = await import('../../src/infra/http/routes/webhooks.ts');

const stripeForSigning = new Stripe('sk_test_placeholder');

function signedPayload(event: Record<string, unknown>): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_test_secret',
  });
  return { payload, signature };
}

async function buildApp() {
  const app = Fastify();
  await app.register(webhooksPlugin, { prefix: '/v1' });
  return app;
}

beforeEach(() => {
  userUpdates.length = 0;
  eventInsertConflict = false;
});

describe('POST /v1/webhooks/stripe', () => {
  test('assinatura inválida → 400', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  test('checkout.session.completed ativa plano', async () => {
    const app = await buildApp();
    const { payload, signature } = signedPayload({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', client_reference_id: 'u1', metadata: { plan: 'pro' } } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(userUpdates[0]).toMatchObject({ plan: 'pro', planStatus: 'active', stripeCustomerId: 'cus_1' });
  });

  test('evento duplicado → 200 sem reprocessar', async () => {
    eventInsertConflict = true;
    const app = await buildApp();
    const { payload, signature } = signedPayload({
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_1' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(userUpdates).toHaveLength(0);
  });

  test('subscription.deleted rebaixa para free', async () => {
    const app = await buildApp();
    const { payload, signature } = signedPayload({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_1' } },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });
    expect(userUpdates[0]).toMatchObject({ plan: 'free' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/stripe-webhook.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/infra/http/routes/webhooks.ts`**

```ts
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { stripeWebhookController } from '../controllers/webhooks/stripe.controller.ts';

/** Rotas de webhook — SEM auth middleware; assinatura validada no controller. */
export async function webhooksPlugin(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // Stripe exige o body cru para validar assinatura
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/stripe', stripeWebhookController);
}
```

- [ ] **Step 4: Implementar `src/infra/http/controllers/webhooks/stripe.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { users, stripeEvents } from '../../../database/schema.ts';
import { stripe } from '../../../services/stripe.ts';
import { reduceStripeEvent } from '../../../../core/services/stripe-plan.ts';
import { env } from '../../../../config/env.ts';

/** POST /v1/webhooks/stripe */
export async function stripeWebhookController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const signature = request.headers['stripe-signature'] as string | undefined;
  if (!signature) {
    reply.status(400).send({ error: 'BadRequest', message: 'Assinatura ausente.' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body as Buffer,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET ?? env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    reply.status(400).send({ error: 'BadRequest', message: 'Assinatura inválida.' });
    return;
  }

  // Idempotência: se já processado, retorna 200 sem reprocessar
  const inserted = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    reply.send({ received: true, duplicate: true });
    return;
  }

  const action = reduceStripeEvent(event as { type: string; data: { object: Record<string, unknown> } });

  switch (action.type) {
    case 'activate':
      await db
        .update(users)
        .set({ plan: action.plan, planStatus: 'active', stripeCustomerId: action.customerId })
        .where(eq(users.id, action.userId));
      break;
    case 'past_due':
      await db
        .update(users)
        .set({ planStatus: 'past_due' })
        .where(eq(users.stripeCustomerId, action.customerId));
      break;
    case 'downgrade':
      await db
        .update(users)
        .set({ plan: 'free', planStatus: 'canceled' })
        .where(eq(users.stripeCustomerId, action.customerId));
      break;
    case 'ignore':
      break;
  }

  // Nota: cache de contexto de keys tem TTL 60s — mudança de plano propaga em até 1 min.
  reply.send({ received: true });
}
```

- [ ] **Step 5: Registrar em `src/server.ts`**

Junto aos outros registers:

```ts
import { webhooksPlugin } from './infra/http/routes/webhooks.ts';
// ...
await app.register(webhooksPlugin, { prefix: '/v1' });
```

- [ ] **Step 6: Rodar tudo e commit**

Run: `bun test && bun run typecheck`
Expected: PASS.

```bash
git add src/infra/http/routes/webhooks.ts src/infra/http/controllers/webhooks/ src/server.ts tests/infra/stripe-webhook.test.ts
git commit -m "feat: webhook stripe com assinatura e idempotência"
```

---

### Task 14: Portal — endpoint de uso + exemplos API.http

**Files:**
- Create: `src/infra/http/controllers/portal/usage.controller.ts`
- Modify: `src/infra/http/routes/portal.ts`
- Modify: `API.http`
- Test: `tests/infra/portal-usage.test.ts`

**Interfaces:**
- Consumes: `usageMonthly`, `apiKeys` (Task 2); `monthKey` (Task 7); `buildUsageKeys` (Task 8); `portalUserId` (Task 10).
- Produces: `GET /v1/portal/usage?month=YYYY-MM` → `{ month, totals: [{ keyId, keyName, count }], byEndpoint: [{ keyId, endpoint, count }] }`. Mês corrente: totais vêm ao vivo do Redis; por-endpoint vem do Postgres (flush ≤ 5 min).

- [ ] **Step 1: Teste que falha**

`tests/infra/portal-usage.test.ts`:

```ts
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { FakeRedis } from '../helpers/fake-redis.ts';

const fakeRedis = new FakeRedis();
mock.module('../../src/infra/services/redis.ts', () => ({
  redis: fakeRedis,
  checkRedisConnection: async () => true,
  getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => f(),
}));

let keyRows: Record<string, unknown>[] = [];
let usageRows: Record<string, unknown>[] = [];
const chain: Record<string, unknown> = {};
chain.select = (fields?: Record<string, unknown>) => {
  chain._mode = fields && 'keyPrefix' in fields ? 'keys' : 'usage';
  return chain;
};
chain.from = () => chain;
chain.where = async () => (chain._mode === 'keys' ? keyRows : usageRows);
mock.module('../../src/infra/database/connection.ts', () => ({
  db: chain,
  checkDatabaseConnection: async () => true,
}));

const { portalPlugin } = await import('../../src/infra/http/routes/portal.ts');
const { createSession } = await import('../../src/infra/auth/session.ts');
const { monthKey } = await import('../../src/core/services/rate-limit.ts');

const MONTH = monthKey(new Date());

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(portalPlugin, { prefix: '/v1' });
  return app;
}

let sessionToken: string;
beforeEach(async () => {
  fakeRedis.store.clear();
  keyRows = [{ id: 'k1', name: 'prod', keyPrefix: 'ur_aaaaaaaaa' }];
  usageRows = [{ keyId: 'k1', endpoint: '/v1/companies', count: 40 }];
  sessionToken = await createSession('u1');
});

describe('GET /v1/portal/usage', () => {
  test('mês corrente: total vem do Redis ao vivo', async () => {
    await fakeRedis.set(`usage:k1:${MONTH}`, 55);
    const app = await buildApp();
    const res = await app.inject({
      url: '/v1/portal/usage',
      cookies: { urano_session: sessionToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.month).toBe(MONTH);
    expect(body.totals[0]).toMatchObject({ keyId: 'k1', count: 55 });
    expect(body.byEndpoint[0]).toMatchObject({ endpoint: '/v1/companies', count: 40 });
  });

  test('sem sessão → 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ url: '/v1/portal/usage' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test tests/infra/portal-usage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/infra/http/controllers/portal/usage.controller.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { db } from '../../../database/connection.ts';
import { apiKeys, usageMonthly } from '../../../database/schema.ts';
import { redis } from '../../../services/redis.ts';
import { monthKey } from '../../../../core/services/rate-limit.ts';
import { buildUsageKeys } from '../../../../core/services/usage-keys.ts';

const querySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

/** GET /v1/portal/usage?month=YYYY-MM */
export async function getUsageController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    reply.status(400).send({ error: 'ValidationError', message: 'Parâmetro month inválido (YYYY-MM).' });
    return;
  }

  const currentMonth = monthKey(new Date());
  const month = parsed.data.month ?? currentMonth;
  const userId = request.portalUserId!;

  const keys = await db
    .select({ id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));

  const keyIds = keys.map((k) => k.id);
  const nameByKey = new Map(keys.map((k) => [k.id, k.name]));

  // Totais: mês corrente ao vivo do Redis; meses passados do Postgres (_total)
  let totals: { keyId: string; keyName: string | undefined; count: number }[] = [];
  if (month === currentMonth && keyIds.length > 0) {
    totals = await Promise.all(
      keyIds.map(async (keyId) => {
        let count = 0;
        try {
          count = Number((await redis.get(buildUsageKeys(keyId, month, '').total)) ?? '0');
        } catch { /* redis fora → 0 */ }
        return { keyId, keyName: nameByKey.get(keyId), count };
      }),
    );
  } else if (keyIds.length > 0) {
    const rows = await db
      .select({ keyId: usageMonthly.keyId, endpoint: usageMonthly.endpoint, count: usageMonthly.count })
      .from(usageMonthly)
      .where(and(inArray(usageMonthly.keyId, keyIds), eq(usageMonthly.month, month), eq(usageMonthly.endpoint, '_total')));
    totals = rows.map((r) => ({ keyId: r.keyId, keyName: nameByKey.get(r.keyId), count: r.count }));
  }

  // Por endpoint: sempre do Postgres (flush ≤ 5 min)
  let byEndpoint: { keyId: string; endpoint: string; count: number }[] = [];
  if (keyIds.length > 0) {
    byEndpoint = await db
      .select({ keyId: usageMonthly.keyId, endpoint: usageMonthly.endpoint, count: usageMonthly.count })
      .from(usageMonthly)
      .where(and(inArray(usageMonthly.keyId, keyIds), eq(usageMonthly.month, month), ne(usageMonthly.endpoint, '_total')));
  }

  reply.send({ month, totals, byEndpoint });
}
```

- [ ] **Step 4: Registrar rota em `portal.ts`**

```ts
import { getUsageController } from '../controllers/portal/usage.controller.ts';
// ...
  app.get('/portal/usage', getUsageController);
```

- [ ] **Step 5: Adicionar exemplos ao `API.http`**

```http
### Portal — solicitar magic link
POST {{baseUrl}}/v1/portal/auth/request-link
Content-Type: application/json

{ "email": "dev@example.com" }

### Portal — trocar token por sessão
POST {{baseUrl}}/v1/portal/auth/verify
Content-Type: application/json

{ "token": "<token-do-email>" }

### Portal — meus dados e limites
GET {{baseUrl}}/v1/portal/me

### Portal — criar key
POST {{baseUrl}}/v1/portal/keys
Content-Type: application/json

{ "name": "produção" }

### Portal — uso do mês
GET {{baseUrl}}/v1/portal/usage

### Portal — checkout upgrade Pro
POST {{baseUrl}}/v1/portal/billing/checkout
Content-Type: application/json

{ "plan": "pro" }
```

- [ ] **Step 6: Rodar TUDO e commit final**

Run: `bun test && bun run typecheck`
Expected: PASS em todos os testes.

```bash
git add src/infra/http/controllers/portal/usage.controller.ts src/infra/http/routes/portal.ts API.http tests/infra/portal-usage.test.ts
git commit -m "feat: endpoint de uso no portal e exemplos api.http"
```

---

## Verificação final do plano (smoke manual)

Após todas as tasks, com Postgres + Redis locais:

1. `bun run db:migrate && bun run dev`
2. `curl -X POST localhost:3000/v1/portal/auth/request-link -H 'content-type: application/json' -d '{"email":"a@b.com"}'` → link aparece no console (dev)
3. Verify com o token → cookie; criar key via portal; chamar `curl localhost:3000/v1/companies -H "x-api-key: <key>"` → 200
4. Key free em `/v1/analysis/ranking` → 403; 11 requests rápidos → 429
5. `curl -X POST localhost:3000/v1/keys` → 404 (endpoint público morto)
6. `bun run worker:usage` → contadores aparecem em `usage_monthly`
