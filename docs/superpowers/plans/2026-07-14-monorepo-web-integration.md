# Monorepo + Web Dashboard Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-package `urano` repo into a bun workspace monorepo with `apps/api` (existing Fastify backend, moved as-is) and `apps/web` (the TanStack Start dashboard cloned from `https://github.com/wendelsantos-solar/urano-insights.git`, imported as a one-time snapshot — no ongoing sync back to Lovable), and enable the browser-based web app to call the API directly (CORS).

**Architecture:** Bun workspaces (`workspaces: ["apps/*"]` at repo root) with two independent apps that share nothing but the repo and root `bun install`. `apps/api` keeps its current internal structure untouched, just relocated. `apps/web` is imported as plain files (its own `.git` history is dropped — it's a single-commit Lovable scaffold, nothing worth preserving) and becomes an ordinary tracked directory in this repo's git history. The two communicate only over HTTP: the web app already implements the full contract from `docs/superpowers/specs/2026-07-14-web-dashboard-lovable-design.md` (localStorage-based `x-api-key` + base URL, `{error,message,details}` inline error handling, 401→Settings redirect, persistent data-health banner) — the only backend gap is CORS, since there's no proxy.

**Tech Stack:** Bun workspaces, Fastify + `@fastify/cors` (api), Vite + TanStack Start/Router/Query + Tailwind v4 + shadcn/radix (web, already scaffolded by Lovable).

## Global Constraints

- No proxy between browser and API — the web app calls the API directly from the browser using `x-api-key` from `localStorage` (per spec, "Auth no front"). CORS is the only backend change needed to support this.
- API error shape stays `{error, message, details?}` (zod validation) — already consumed as-is by `apps/web/src/lib/api.ts`. Do not change the shape.
- This is a **one-time import** of the Lovable-generated web app. Do not add `apps/web/.git`, do not add `urano-insights` as a git remote/submodule, and do not push anything back to `https://github.com/wendelsantos-solar/urano-insights.git`.
- Single-user, no multi-tenant/SSO/JWT — nothing in this plan should add auth beyond the existing `x-api-key` header check.
- Keep `apps/api`'s internal module layout (`src/core`, `src/infra`, etc.) untouched — this plan relocates files, it does not refactor backend internals.

---

### Task 1: Relocate the backend into `apps/api`

**Files:**
- Move: `src/`, `tests/`, `scripts/`, `db/`, `package.json`, `tsconfig.json`, `drizzle.config.ts`, `docker-compose.yml`, `API.http` → same names under `apps/api/`
- Move (untracked, plain `mv` not `git mv`): `.env` → `apps/api/.env`
- Modify: `.gitignore` (repo root, stays at root)
- Modify: `apps/api/package.json` (rename `name`)

**Interfaces:**
- Produces: `apps/api` is a fully self-contained package — `bun install && bun run dev` from inside `apps/api/` starts the Fastify server exactly as it did from repo root today.

- [ ] **Step 1: Create `apps/` and move backend files with git history preserved**

```bash
mkdir -p apps/api
git mv src tests scripts db package.json tsconfig.json drizzle.config.ts docker-compose.yml API.http apps/api/
mv .env apps/api/.env
```

- [ ] **Step 2: Update `.gitignore` for the new `db/migrations/meta` path**

In `.gitignore`, change:

```
# drizzle-kit
db/migrations/meta
```

to:

```
# drizzle-kit
apps/api/db/migrations/meta
```

- [ ] **Step 3: Rename the api package**

In `apps/api/package.json`, change:

```json
  "name": "urano",
```

to:

```json
  "name": "urano-api",
```

- [ ] **Step 4: Verify the backend still runs from its new location**

```bash
cd apps/api && bun install && bun run typecheck
```

Expected: `tsc --noEmit` completes with no errors (same as before the move).

```bash
cd apps/api && timeout 5 bun run dev; echo "exit:$?"
```

Expected: Fastify boot log lines appear (DB/Redis connection checks, `Server listening at ...`) before the timeout kills it — no path-resolution errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: move backend into apps/api ahead of monorepo restructure"
```

---

### Task 2: Set up the bun workspace root

**Files:**
- Create: `package.json` (repo root, new — replaces the one moved in Task 1)
- Create: `bunfig.toml` (repo root)

**Interfaces:**
- Consumes: `apps/api` (Task 1)
- Produces: a root workspace so `bun install` at repo root resolves both `apps/api` and (once added in Task 3) `apps/web` into one lockfile/`node_modules`.

- [ ] **Step 1: Create the workspace root `package.json`**

```json
{
  "name": "urano",
  "private": true,
  "workspaces": [
    "apps/*"
  ],
  "scripts": {
    "dev:api": "bun --filter urano-api dev",
    "dev:web": "bun --filter urano-web dev",
    "typecheck": "bun --filter '*' typecheck"
  }
}
```

- [ ] **Step 2: Create the root `bunfig.toml`**

```toml
[install]
saveTextLockfile = true
```

- [ ] **Step 3: Install from the root and verify the workspace resolves**

```bash
bun install
bun pm ls
```

Expected: `urano-api` listed as a workspace package, no install errors.

```bash
bun run dev:api & sleep 4; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health/data 2>/dev/null || true; kill %1
```

Expected: the api still starts via the root `--filter` script (adjust the health path if it 404s — the goal is confirming the process boots, not a specific route).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: set up bun workspace root for apps/*"
```

---

### Task 3: Import the web dashboard into `apps/web`

**Files:**
- Create: `apps/web/` (entire contents of the cloned `urano-insights` repo, minus `.git`)
- Delete: `apps/web/AGENTS.md` (Lovable git-sync warning — no longer accurate once decoupled)
- Modify: `apps/web/package.json` (rename `name`)
- Modify: `bunfig.toml` (repo root — merge in the release-age excludes from the web app)

**Interfaces:**
- Consumes: workspace root from Task 2
- Produces: `apps/web` runnable via `bun --filter urano-web dev` (Vite dev server, default port 5173), fully wired to hit an API base URL configured through its own Settings screen (`apps/web/src/routes/settings.tsx`, backed by `apps/web/src/lib/api.ts`).

- [ ] **Step 1: Copy the cloned repo in, dropping its own git history**

```bash
rm -rf /tmp/urano-insights-import
git clone --depth 1 https://github.com/wendelsantos-solar/urano-insights.git /tmp/urano-insights-import
rm -rf /tmp/urano-insights-import/.git
mkdir -p apps/web
cp -a /tmp/urano-insights-import/. apps/web/
rm -rf /tmp/urano-insights-import
```

- [ ] **Step 2: Remove the stale Lovable git-sync warning**

`apps/web/AGENTS.md` only contains a warning that commits sync back to Lovable — false now that the app lives in this monorepo. Delete it:

```bash
rm apps/web/AGENTS.md
```

- [ ] **Step 3: Rename the web package**

In `apps/web/package.json`, change:

```json
  "name": "tanstack_start_ts",
```

to:

```json
  "name": "urano-web",
```

- [ ] **Step 4: Merge the web app's install guard into the root `bunfig.toml`**

Replace the root `bunfig.toml` from Task 2 with:

```toml
[install]
saveTextLockfile = true
# 24h supply-chain guard: skip package versions published less than a day ago.
minimumReleaseAge = 86400
# Each entry bypasses the 24h guard for one package — confirm with the user
# before adding any.
minimumReleaseAgeExcludes = ["@lovable.dev/vite-tanstack-config", "@lovable.dev/mcp-js", "@lovable.dev/vite-plugin-dev-server-bridge", "@lovable.dev/vite-plugin-hmr-gate", "@lovable.dev/email-js", "@lovable.dev/webhooks-js"]
```

Delete `apps/web/bunfig.toml` (now redundant — bun reads the root one for the whole workspace).

```bash
rm apps/web/bunfig.toml
```

- [ ] **Step 5: Install and verify the web app builds and typechecks**

```bash
bun install
bun --filter urano-web run lint
bun run tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no lint errors, no type errors (this is the app exactly as Lovable generated it — any failure here means the copy step went wrong, not a real code issue).

- [ ] **Step 6: Verify the dev server boots**

```bash
timeout 6 bun --filter urano-web run dev; echo "exit:$?"
```

Expected: Vite prints a local dev URL (`http://localhost:5173/` by default) before the timeout — no plugin/config resolution errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: import urano-insights web dashboard into apps/web"
```

---

### Task 4: Enable CORS on the API for direct browser calls

**Files:**
- Modify: `apps/api/package.json` (add `@fastify/cors` dependency)
- Modify: `apps/api/src/config/env.ts:1-41` (add `CORS_ORIGIN`)
- Modify: `apps/api/src/server.ts` (register the plugin)
- Test: `apps/api/tests/infra/cors.test.ts`

**Interfaces:**
- Consumes: `env.CORS_ORIGIN: string` (new field on the `Env` type from `apps/api/src/config/env.ts`)
- Produces: `OPTIONS`/cross-origin `GET`/`POST` requests from `env.CORS_ORIGIN` succeed with `Access-Control-Allow-Origin` set; other origins are rejected by the browser (not by the server — `@fastify/cors` still processes the request, it just omits the ACAO header for disallowed origins).

- [ ] **Step 1: Add the dependency**

```bash
cd apps/api && bun add @fastify/cors
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/tests/infra/cors.test.ts
import { describe, expect, test } from 'bun:test';
import Fastify from 'fastify';
import cors from '@fastify/cors';

describe('CORS', () => {
  test('allows the configured origin', async () => {
    const app = Fastify();
    await app.register(cors, { origin: 'http://localhost:5173' });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  test('omits the header for a different origin', async () => {
    const app = Fastify();
    await app.register(cors, { origin: 'http://localhost:5173' });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://evil.example' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to confirm it passes against the plugin directly (sanity check on `@fastify/cors`'s own behavior)**

```bash
cd apps/api && bun test tests/infra/cors.test.ts
```

Expected: PASS — this test only exercises the third-party plugin, confirming it's installed and behaves as documented before wiring it into `src/server.ts`.

- [ ] **Step 4: Add `CORS_ORIGIN` to the env schema**

In `apps/api/src/config/env.ts`, change:

```typescript
const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().positive()),

  DATABASE_URL: z
    .string()
    .default('postgres://urano:urano_dev@localhost:5432/urano_finbot'),

  REDIS_URL: z
    .string()
    .default('redis://localhost:6379'),
});
```

to:

```typescript
const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform(Number)
    .pipe(z.number().int().positive()),

  DATABASE_URL: z
    .string()
    .default('postgres://urano:urano_dev@localhost:5432/urano_finbot'),

  REDIS_URL: z
    .string()
    .default('redis://localhost:6379'),

  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173'),
});
```

And change:

```typescript
  const raw = {
    PORT: process.env.PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  };
```

to:

```typescript
  const raw = {
    PORT: process.env.PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  };
```

- [ ] **Step 5: Register the plugin in `apps/api/src/server.ts`**

Add near the top with the other imports:

```typescript
import cors from '@fastify/cors';
```

Add right after `const app = Fastify({ ... });` (before `app.addHook('onRequest', rateLimiter);`):

```typescript
await app.register(cors, { origin: env.CORS_ORIGIN });
```

- [ ] **Step 6: Add `CORS_ORIGIN` to `apps/api/.env`**

```
CORS_ORIGIN=http://localhost:5173
```

- [ ] **Step 7: Run the full test suite and typecheck**

```bash
cd apps/api && bun test && bun run typecheck
```

Expected: all tests PASS including the new `cors.test.ts`, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: enable CORS on the API for direct browser calls from apps/web"
```

---

### Task 5: End-to-end verification

**Files:** none (manual verification only)

- [ ] **Step 1: Start Postgres/Redis and the API**

```bash
cd apps/api && docker compose up -d && bun run dev
```

- [ ] **Step 2: Create an API key**

```bash
cd apps/api && bun run key:create
```

Copy the printed key.

- [ ] **Step 3: Start the web app**

```bash
bun run dev:web
```

- [ ] **Step 4: Configure and exercise the dashboard in a browser**

Open the printed Vite URL (`http://localhost:5173`), go to Settings, enter the API base URL (`http://localhost:3000`) and the key from Step 2, then open the Ranking or Screener screen.

Expected: data loads with no CORS error in the browser console, no 401, and (if data health has warnings) the persistent banner renders per spec.

- [ ] **Step 5: Confirm the plan's constraint is intact**

```bash
git remote -v
```

Expected: only `origin` for the `urano` repo itself — no reference to `urano-insights` was added anywhere in the repo (submodule, remote, or `.git` directory under `apps/web`).
