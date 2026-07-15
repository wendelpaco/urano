# Runbook — local & production (API)

Short guide for Postgres/Redis via Compose, API on the host or in Docker, and scheduler vs worker separation.

## Prerequisites

- Bun (local API/dev)
- Docker + Docker Compose
- `apps/api/.env` from `.env.example` (set `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and matching `DATABASE_URL` / `REDIS_URL`)

Compose loads env vars from the shell and from `--env-file` / `env_file`. Run commands from `apps/api` unless noted.

---

## Local — infrastructure only (default)

Default profile starts **only** Postgres and Redis (no API container):

```bash
cd apps/api
docker compose --env-file .env up -d
```

Host-oriented URLs in `.env` (typical):

```env
DATABASE_URL=postgres://urano:<POSTGRES_PASSWORD>@localhost:5432/urano_finbot
REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379
```

Then on the host:

```bash
# monorepo root
bun install
bun --filter urano-api db:migrate
bun --filter urano-api key:create   # optional
bun --filter urano-api dev          # or: bun run dev:api
```

Web (optional): `bun run dev:web` (port 8080; set `CORS_ORIGIN` accordingly).

---

## Local — full stack in Compose (profile `full`)

Starts postgres + redis + **api** (build from monorepo root):

```bash
cd apps/api
docker compose --env-file .env --profile full up -d --build
```

- API: http://localhost:3000  
- Inside the `api` service, `DATABASE_URL` / `REDIS_URL` are overridden to hostnames `postgres` and `redis` (see `docker-compose.yml`).  
- Stop: `docker compose --profile full down`

Build image alone (from monorepo root):

```bash
docker build -f apps/api/Dockerfile -t urano-api .
```

---

## Production-style Docker

1. Build: `docker build -f apps/api/Dockerfile -t urano-api .` (repo root).
2. Run against managed Postgres/Redis (or Compose services on a shared network).
3. Pass secrets at **runtime** — never bake `.env` into the image:

```bash
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgres://…' \
  -e REDIS_URL='redis://:…@…:6379' \
  -e CORS_ORIGIN='https://app.example.com' \
  -e SCHEDULER_ENABLED=true \
  urano-api
```

Or use Compose profile `full` on a host that already has `apps/api/.env` with production passwords.

Health: `GET /v1/health` (or project healthcheck route) after migrations.

---

## Scheduler on/off & worker process

`SCHEDULER_ENABLED` (env, default `true`) controls whether the in-process job scheduler starts with the HTTP server.

| Goal | How |
|------|-----|
| Single process (dev default) | `bun run dev` / `bun run start` — scheduler on |
| HTTP API only (no background jobs) | `bun run start:api-only` → `SCHEDULER_ENABLED=false` |
| Process that runs with scheduler on | `bun run worker` → `SCHEDULER_ENABLED=true bun run src/server.ts` |

### Split API + worker (recommended direction for prod)

Today the scheduler lives in the same entrypoint as Fastify (`src/server.ts`). Practical split:

1. **API replica(s):** `SCHEDULER_ENABLED=false` (script: `start:api-only`) so request handlers do not compete with ETL/scrapers.
2. **Worker process:** one instance with `SCHEDULER_ENABLED=true` (script: `worker`). Until a dedicated worker entrypoint exists (no HTTP listen), this still starts the API server on that process — run a **single** worker instance and do not put it behind the load balancer, or pin a free port.

Future improvement: dedicated `scripts/run-worker.ts` that only starts `JobScheduler` + DB/Redis (no Fastify). Scripts above are the interim contract.

One-shot / heavy jobs (unchanged):

```bash
bun run worker:sync    # CVM fundamentals
bun run seed           # seed job rows
bun run warm-cache
bun run backtest
```

---

## Quick reference

| Command | What |
|---------|------|
| `docker compose --env-file .env up -d` | Postgres + Redis only |
| `docker compose --env-file .env --profile full up -d --build` | + API container |
| `bun run start:api-only` | API, scheduler off |
| `bun run worker` | Scheduler on (same binary for now) |
| `docker build -f apps/api/Dockerfile -t urano-api .` | Prod image from repo root |
