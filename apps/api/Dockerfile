# Production image for urano-api (Bun + Fastify).
#
# Build from monorepo root (required — lockfile and workspace layout live there):
#   docker build -f apps/api/Dockerfile -t urano-api .
#
# Do not bake secrets: pass DATABASE_URL, REDIS_URL, etc. at runtime.

FROM oven/bun:1-alpine

WORKDIR /app

# Workspace manifests only — maximizes layer cache for deps
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/

RUN bun install --frozen-lockfile --filter urano-api

# Application source (no .env)
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/drizzle.config.ts ./apps/api/
COPY apps/api/db ./apps/api/db

WORKDIR /app/apps/api

ENV NODE_ENV=production
EXPOSE 3000

USER bun

CMD ["bun", "run", "start"]
