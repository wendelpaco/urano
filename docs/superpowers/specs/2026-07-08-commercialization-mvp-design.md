# Urano — Comercialização MVP (Abordagem C: MVP enxuto, arquitetura pronta para expansão)

**Data:** 2026-07-08
**Status:** Aprovado em brainstorming
**Modelo de negócio:** API paga por assinatura, self-service completo, pagamento via Stripe.

## Objetivo

Levar o Urano do estado atual (API de dados + análise funcional, auth fraca, sem billing) até o mínimo necessário para cobrar clientes com segurança: contas de usuário, keys seguras, rate limiting, planos com Stripe, metering, dashboard self-service, docs públicas e deploy de produção.

Fora de escopo do MVP (fase 2, pós-receita): metered billing (cobrança por excedente), SDKs, playground interativo, webhooks para clientes, keys multi-ambiente, feed de cotações licenciado.

## Contexto atual (o que já existe)

- API Fastify/Bun: companies, fundamentals, stocks, dividends, FIIs, macro, screener, analysis (scores, ranking, allocation), wallets + rebalance
- Workers: cvm-sync, daily-snapshot, backtest; MCP server; Redis cache; Postgres/Drizzle
- Auth atual: header `x-api-key`, keys em **plaintext** no banco, `POST /v1/keys` **público**, middleware **fail-open** se o banco cair (`src/infra/http/middleware/auth.ts:71-76`)
- Sem: users, rate limiting, billing, metering, docs OpenAPI, dashboard

## Seção 1 — Contas, Auth e Segurança

### Modelo de dados

```
users
  id            uuid PK
  email         varchar unique not null
  name          varchar
  stripeCustomerId varchar unique nullable
  plan          enum('free','pro','business') default 'free'
  planStatus    enum('active','past_due','canceled') default 'active'
  createdAt     timestamptz

apiKeys (alterações)
  + userId      uuid FK -> users.id, not null
  + keyHash     varchar(64) unique not null   -- SHA-256 hex da key
  + keyPrefix   varchar(16) not null          -- ex.: 'ur_a1b2c3d4' para exibição
  - key         (coluna plaintext REMOVIDA)

sessions (Redis, não Postgres)
  session:<token> -> { userId }, TTL 30 dias, revogável via DEL

magicLinks (Redis)
  magiclink:<token> -> { email }, TTL 15 min, single-use (GETDEL)
```

### Fluxo de API key

1. Key gerada uma única vez: `ur_` + 256 bits de `crypto.randomBytes` (gerador atual mantido)
2. Resposta mostra a key completa uma única vez; banco guarda apenas `keyHash` + `keyPrefix`
3. Auth middleware: SHA-256 da key recebida → lookup por `keyHash`
4. Cache Redis: `apikey:valid:<hash>` → `{ keyId, userId, plan }`, TTL 60s
5. Revogação de key faz DEL explícito do cache (revogação imediata)

### Correções de segurança (bloqueantes para cobrar)

1. **`POST /v1/keys` deixa de ser público** — criação/revogação de keys passa a exigir sessão de usuário (rotas `/v1/portal/*`)
2. **Auth fail-closed** — Postgres indisponível e cache frio → HTTP 503, nunca acesso liberado sem validação
3. **Keys hasheadas** — vazamento do banco não expõe keys utilizáveis
4. Migração: keys plaintext existentes são hasheadas em migration (hash da coluna atual → `keyHash`, prefixo extraído, coluna `key` dropada); keys órfãs (sem dono) são atribuídas a um user admin criado na migration

### Rate limiting

- Por key, no Redis, dois níveis:
  - **req/min** (proteção burst): `INCR ratelimit:<keyId>:<epoch-min>` TTL 60s
  - **req/mês** (limite do plano): lê contador de metering `usage:<keyId>:<YYYY-MM>`
- Limites definidos pelo plano do dono da key
- Excedido → HTTP 429 com headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Redis indisponível → rate limiting desativado temporariamente (fail-open **apenas** para rate limit; auth continua fail-closed)

### Sessão do dashboard

- Login passwordless por magic link: e-mail com token de 15 min → troca por cookie de sessão
- Sessão em Redis (revogável), cookie `httpOnly`, `secure`, `sameSite=lax`
- Envio de e-mail: Resend (ou SMTP simples) — único e-mail transacional do MVP

## Seção 2 — Planos, Stripe e Metering

### Planos (hard limit, sem cobrança de excedente)

| | Free | Pro | Business |
|---|---|---|---|
| req/mês | 5.000 | 100.000 | 1.000.000 |
| req/min | 10 | 60 | 300 |
| keys | 1 | 3 | 10 |
| `/analysis/*`, `/screener` | ❌ | ✅ | ✅ |
| preço (placeholder) | R$0 | ~R$49/mês | ~R$249/mês |

Limites e preços ficam em config central (`src/core/plans.ts`), não espalhados no código.

### Stripe

- 2 Products (Pro, Business), Prices mensais em BRL, Pix habilitado no Checkout
- Upgrade: dashboard → Stripe Checkout (redirect) → webhook ativa plano
- `POST /v1/webhooks/stripe` — rota pública, validação de assinatura obrigatória (`stripe.webhooks.constructEvent`):
  - `checkout.session.completed` → seta `plan` + `stripeCustomerId`
  - `invoice.payment_failed` → `planStatus = past_due` (mantém acesso por período de graça definido no Stripe)
  - `customer.subscription.deleted` → rebaixa para `free`
- Stripe Customer Portal para trocar cartão, cancelar, baixar faturas — zero UI própria de billing
- Idempotência: eventos processados registrados por `event.id` (tabela `stripeEvents` ou SETNX Redis) para tolerar redelivery

### Metering

- Hook `onResponse` (só respostas 2xx/4xx autenticadas):
  - `INCR usage:<keyId>:<YYYY-MM>`
  - `INCR usage:<keyId>:<YYYY-MM>:<endpoint>` (endpoint = rota registrada, não URL crua)
- Worker a cada 5 min: flush Redis → Postgres `usageMonthly (keyId, userId, month, endpoint, count)` via upsert
- Enforcement mensal lê o contador Redis no próprio request (O(1))
- Dashboard lê o Postgres
- Granularidade por endpoint desde o dia 1 → habilita metered billing na fase 2 sem retrabalho

## Seção 3 — Dashboard, Docs e Landing

### Dashboard

- App separado (Next.js) consumindo rotas `/v1/portal/*` (sessão cookie; namespace separado das rotas autenticadas por API key)
- Telas:
  1. Login (magic link)
  2. Home: uso do mês (total + por endpoint, gráfico simples), plano atual
  3. Keys: listar (só prefixo), criar (mostra key uma vez), revogar
  4. Billing: botão Upgrade (Stripe Checkout) + Gerenciar assinatura (Stripe Portal)
- Sem admin panel próprio: admin = Drizzle Studio/SQL direto

### Docs

- `@fastify/swagger` sobre os zod schemas existentes → OpenAPI 3
- UI pública em `/docs` (Scalar ou Swagger UI)
- Quickstart: cadastro → key → primeira chamada curl → exemplos por endpoint

### Landing

- Página única estática: proposta de valor, tabela de preços, link docs, CTA de cadastro
- Mesma stack/deploy do dashboard

## Seção 4 — Deploy, Operação e Legal

### Deploy

- API + workers: Railway (Postgres + Redis gerenciados no mesmo projeto; Bun nativo). Alternativa: Fly.io
- Dashboard/landing: Vercel ou Railway
- Secrets via env do provedor; migrations Drizzle no deploy

### Observabilidade

- Sentry (SDK Fastify) para errors
- UptimeRobot/BetterStack no `/healthcheck`
- Logs pino → stdout do provedor
- Backup Postgres: automático do provedor + dump semanal externo

### Dados e resiliência de fontes

- ToS declara: fundamentals oficiais (CVM), macro (BCB); cotações "best-effort, delayed", sem SLA de fonte
- Scrapers (StatusInvest, Yahoo) com circuit breaker + fallback para snapshot do dia anterior — bloqueio de scraper não pode derrubar endpoint pago
- Fase 2 (pós-receita): cotações via provedor licenciado (Cedro / B3 UP2DATA)

### Legal

- Termos de Uso + Política de Privacidade (LGPD: coleta = e-mail e métricas de uso; base legal = execução de contrato)
- Disclaimer em toda resposta de `/analysis/*`: "Este conteúdo não constitui recomendação de investimento" (campo fixo no JSON)
- CNPJ + emissão de NFSe fora do escopo de código (eNotas/PlugNotas na fase 2; Stripe emite invoice, não NF)

### Testes e CI

- GitHub Actions: typecheck + `bun test` em todo PR
- Cobertura nova obrigatória:
  - Auth: hash lookup, fail-closed, revogação invalida cache
  - Rate limit: burst, mensal, headers 429
  - Webhook Stripe: assinatura inválida rejeitada, transições de plano, idempotência
  - Metering: contagem por endpoint, flush idempotente

## Ordem de implementação (ondas)

1. **Onda S (segurança/fundação):** users + migração de keys (hash), auth fail-closed, sessões magic link, rotas portal de keys
2. **Onda R (limites):** config de planos, rate limiting, metering + worker de flush
3. **Onda B (billing):** Stripe (checkout, webhook, portal), gating de endpoints por plano
4. **Onda D (superfície):** OpenAPI/docs, dashboard, landing
5. **Onda O (operação):** deploy Railway, Sentry, uptime, CI, circuit breaker de scrapers, disclaimer + ToS

Critério de lançamento: onda S–O completas; um cliente consegue, sem intervenção manual: cadastrar → assinar Pro via Pix/cartão → criar key → consumir API dentro dos limites → ver uso no dashboard.
