# Urano

Monorepo de análise de **ações e FIIs da B3**: API de fundamentals/score + terminal web.

O **score** é um **filtro de qualidade fundamentalista** (triagem de ativos fracos/caros/endividados). **Não** é preditor de retorno nem sinal de timing. Ver [veredito do backtest v1](docs/backtest/2026-07-08-veredito-v1.md) (`quality-filter`, com ressalvas).

## Layout

| Path | Pacote | Descrição |
|---|---|---|
| `apps/api` | `urano-api` | API Fastify (Bun), Postgres, Redis, MCP, jobs |
| `apps/web` | `urano-web` | Terminal web (Vite / TanStack) — porta `8080` |

## Pré-requisitos

- [Bun](https://bun.sh)
- Docker (Postgres 16 + Redis 7 via compose da API)

## Quick start

1. **Env da API** — copie e defina as senhas (`CHANGE_ME`):

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

   Variáveis mínimas: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGIN` (padrão `http://localhost:8080`).

2. **Infra local** (Postgres + Redis):

   ```bash
   docker compose -f apps/api/docker-compose.yml --env-file apps/api/.env up -d
   ```

3. **Dependências** (na raiz do monorepo):

   ```bash
   bun install
   ```

4. **Migrations**:

   ```bash
   bun --filter urano-api db:migrate
   ```

5. **API key**:

   ```bash
   bun --filter urano-api key:create
   ```

6. **Dev** (dois terminais):

   ```bash
   bun run dev:api   # http://localhost:3000
   bun run dev:web   # http://localhost:8080
   ```

## Scripts (raiz)

| Script | Comando | Função |
|---|---|---|
| `dev:api` | `bun run dev:api` | API em watch |
| `dev:web` | `bun run dev:web` | Web em dev |
| `typecheck` | `bun run typecheck` | `tsc --noEmit` em todos os workspaces |
| `test` | `bun run test` | Testes da API |
| `lint` | `bun run lint` | Lint nos workspaces |

Úteis na API: `db:migrate`, `key:create`, `mcp`, `seed`, `warm-cache`, `backtest` (via `bun --filter urano-api <script>`).

## Auth

Rotas autenticadas usam o header:

```http
x-api-key: <sua-chave>
```

Crie a chave com `bun --filter urano-api key:create`.

## MCP

Servidor MCP (stdio) que chama a API com a mesma auth:

```bash
URANO_API_KEY=<sua-chave> bun --filter urano-api mcp
```

Opcional: `URANO_API_URL` (padrão `http://localhost:3000/v1`). Exemplo de config: [`docs/mcp-claude-config.json`](docs/mcp-claude-config.json).

## Docker (API)

Build **a partir da raiz** do monorepo (lockfile + workspaces):

```bash
docker build -f apps/api/Dockerfile -t urano-api .
```

Não embuta secrets na imagem — passe `DATABASE_URL`, `REDIS_URL`, etc. em runtime.

## Docs

- [Veredito backtest v1 — quality-filter](docs/backtest/2026-07-08-veredito-v1.md)
- Planos/specs em `docs/superpowers/`
