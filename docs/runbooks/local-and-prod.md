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

`SCHEDULER_ENABLED` (env, default `true`) is intended to control whether the in-process job scheduler starts with the HTTP server. Prefer a **split** deployment in production.

| Goal | How |
|------|-----|
| Single process (dev default) | `bun run dev` / `bun run start` — HTTP + scheduler in one process |
| HTTP API only (no background jobs) | `bun run start:api-only` → `SCHEDULER_ENABLED=false` |
| Dedicated jobs process (no Fastify) | `bun run worker:jobs` → `src/infra/workers/job-runner.ts` |
| Legacy combined worker (HTTP + scheduler) | `bun run worker` → `SCHEDULER_ENABLED=true bun run src/server.ts` |

### Split API + worker (recommended for prod)

1. **API replica(s):** `SCHEDULER_ENABLED=false` (script: `start:api-only`) so request handlers do not compete with ETL/scrapers.
2. **Job worker (one instance):** `bun run worker:jobs` — starts `JobStore` + `JobWorker` + `JobScheduler` only (no HTTP listen). Needs the same `DATABASE_URL` / `REDIS_URL` as the API (jobs use Postgres + Redis cache).

```bash
cd apps/api
# terminal A — HTTP
bun run start:api-only
# terminal B — background jobs
bun run worker:jobs
```

From monorepo root: `bun --filter urano-api start:api-only` and `bun --filter urano-api worker:jobs`.

One-shot / heavy jobs (unchanged):

```bash
bun run worker:sync    # CVM fundamentals
bun run seed           # seed job rows
bun run warm-cache
bun run backtest
```

---

## Postgres backup & restore

Logical dump via `pg_dump` (requires client tools on PATH). Script: `apps/api/scripts/backup-postgres.sh`.

```bash
cd apps/api
# uses DATABASE_URL from environment (or load .env first)
set -a && source .env && set +a   # optional if DATABASE_URL not already exported
bun run backup
# equivalent: bash scripts/backup-postgres.sh
```

- Output dir: `BACKUP_DIR` (default `./backups` relative to CWD).
- Filename: `urano_<UTC-timestamp>.sql.gz`.
- Fallback: if `DATABASE_URL` is unset, uses libpq `PGHOST` + `PGDATABASE` (+ `PGUSER` / `PGPASSWORD` / `PGPORT`).

Restore one-liner (into an existing empty/target DB; adjust URL and dump path):

```bash
gunzip -c backups/urano_YYYYMMDDTHHMMSSZ.sql.gz | psql "$DATABASE_URL"
```

---

## Quick reference

| Command | What |
|---------|------|
| `docker compose --env-file .env up -d` | Postgres + Redis only |
| `docker compose --env-file .env --profile full up -d --build` | + API container |
| `bun run start:api-only` | API, scheduler off (use with `worker:jobs`) |
| `bun run worker:jobs` | JobScheduler only (no HTTP) |
| `bun run worker` | Legacy: scheduler on via full `server.ts` |
| `bun run backup` | `pg_dump` → `BACKUP_DIR` (default `./backups`) |
| `docker build -f apps/api/Dockerfile -t urano-api .` | Prod image from repo root |
