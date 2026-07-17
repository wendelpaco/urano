# Urano — Auditoria & Roadmap (Julho 2026 — rev. 2026-07-17)

> Documento para revisão **ponto a ponto** antes de implementar. Cada item tem ID
> estável, evidência `arquivo:linha`, impacto, fix proposto e esforço.
>
> **Rev. 2026-07-17:** re-auditoria completa contra o HEAD atual (`701bfba`).
> A maior parte da Fase 0/1 da rev. anterior foi **resolvida e verificada no
> código** (primeira tabela). Esta revisão adiciona um track novo (**Track N**)
> com achados desta rodada — a maioria é residual de performance, hardening e
> um bug de produto real (N-1, mesma classe do ENG-3r).

## Como ler este documento

- **Status:**
  - `✅ resolvido` — confirmado no código atual, com evidência.
  - `🔶 parcial` — parte resolvida; resta o residual descrito.
  - `🔴 aberto` — confirmado presente no código atual.
  - `🕒 runtime` — precisa inspeção de dado real (banco/logs) para confirmar ou agir.
- **Severidade:** `crítico` distorce resultado/segurança de forma ampla; `alto` afeta muitos casos; `médio` casos específicos; `baixo` cosmético/hardening.
- **Esforço:** `P` (<1h), `M` (algumas horas), `G` (dia+ / precisa dado em runtime).

---

## Resolvidos desde a rev. 2026-07-16 (verificados em 2026-07-17)

| ID | Era | Evidência da correção |
|----|-----|----------------------|
| SEC-1r | Coluna `key` + índice legados | Migration `0019_drop_legacy_key_column.sql` dropa coluna e `idx_api_keys_key`; schema comenta a remoção (`schema.ts:332`). |
| SEC-12a | `.gitignore` sem `.env.production` | `.gitignore:19-21` — `.env`, `.env.*`, `!.env.example`. |
| SEC-12b | MCP enviava key em cleartext p/ host remoto http | `mcp/server.ts:40-58` — valida URL e recusa `http://` quando host ≠ localhost. |
| SEC-2 (CI) | Sem regra gitleaks p/ formato da key | `.gitleaks.toml` com regex `ur_[0-9a-f]{12}(_...)x3` + job `secret-scan` no CI. **Resta SEC-2r abaixo (rotação no banco).** |
| SSRF-3r | Fetch seguia redirects | `redirect: 'error'` em todos os fetches de upstream (statusinvest `:171,208,263,335`, yahoo `stock-quote-service.ts:451,551`, cvm `:391`, bcb `selic-provider.ts:30`, investidor10 `:126,187`, dividends `:152`). |
| SSRF-2r | Rotas de live-scrape sem bucket dedicado | `server.ts:29-44` — `scraperPathLimits` (default 10/min via `SCRAPER_RATE_LIMIT_PER_MINUTE`) em search/screener/ranking/allocate/contribution/compare. |
| SSRF-1 (CVM) | ZIP CVM sem teto de bytes | `cvm-storage-service.ts:395-405` — valida `Content-Length` e tamanho pós-leitura (50 MiB). **Resta SSRF-1r abaixo (scrapers + leitura streaming).** |
| ENG-8 | Prejuízo mascarado por dado ausente | `indicators.ts:44-45` — `eps`/`bvps` `null` quando shares ausente; `:94` — `fcoToNetIncome` só com `netIncome > 0`. |
| ENG-3r (engine) | LIMIT 100 alfabético no universo | `allocation-engine.ts:715,775` — LIMIT removido, universo completo. **Resta N-1 abaixo (ranking/screener controllers).** |
| ENG-5r | Backtest entrava na data do balanço (look-ahead) | `backtest.ts:123-131` — `entryDate = reference_date + 4 meses`. |
| REL-1 | Timezone errado no dia-da-semana da janela ETL | `time-window.ts:129-203` — weekday derivado das parts do `Intl`. **Resta N-6 (residual menor).** |
| REL-2 | Universo com awaits sequenciais | `allocation-engine.ts:716` — `withConcurrency` (5 simultâneos); ranking/search usam `batchWithConcurrency`. |
| REL-3 | Pool Postgres fixo em 10 | `env.ts:112-116` + `connection.ts:15` — `DATABASE_POOL_MAX` configurável (2-100). |
| PIPE-3 | Dividendos sintéticos sem marcação | `statusinvest-scraper.ts:302` — `type: 'SINTETICO_ANUAL'`. |
| IMP-1 (SELIC) | SELIC hardcoded 14.0 | `stock-score.ts:11-14` + `server.ts:205-216` — SELIC dinâmica via BCB com fallback. **Resta IMP-1r (setor-relativo + re-fit).** |
| IMP-6 | Renda estimada sempre `unavailable` | `allocation-engine.ts:139-140` — `dividendEstimateStatus: full \| partial \| unavailable` com DY real por ativo. |
| IMP-5 | Alocação proporcional vs equal-weight inconsistente | Ambos usam equal-weight **por design** (backtest: score filtra, não ordena): `allocation-engine.ts:518`, `contribution-advisor.ts:192-212`. Consistente — fechado. |

---

## Track S — Segurança (abertos)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **SEC-2r** | alto | 🕒 runtime | **Rotacionar/desativar no banco a key vazada no histórico do git** (`ur_9a02...`, presente nos commits `c1eed31`/`5af5a9b`/`701bfba` e anteriores). O CI agora barra vazamento novo, mas a credencial antiga só morre quando a linha correspondente for desativada **no Postgres**. **Ação:** calcular o SHA-256 da key vazada, localizar por `key_hash`, desativar (`active=false`) ou rotacionar; conferir `last_used_at` para detectar uso indevido. **Esforço:** P |
| **SEC-13** | baixo | 🔴 aceito | **API key em `localStorage` no frontend** (`apps/web/src/lib/api.ts:9-10`). Aceitável para single-operator/self-host (decisão registrada em `MATURITY-STATUS.md`). Vira **bloqueador** se houver multiusuário → mover para proxy server-side (session cookie httpOnly) ou BFF. **Esforço:** M (só se multiusuário) |
| **N-7** | médio | 🔴 aberto | **CSP fraca no terminal web** (`__root.tsx:102-113`): `script-src 'unsafe-inline'` + `connect-src ... https:` (qualquer host). Com a key no localStorage, um XSS injeta script inline e exfiltra para qualquer domínio https. Mitigado por ser single-user e sem input de terceiros renderizado, mas é a linha de defesa que protege a credencial. **Fix:** remover `'unsafe-inline'` de `script-src` (nonce/hash — verificar suporte no TanStack Start SSR) e restringir `connect-src` à origem da API. **Esforço:** M |

## Track SSRF — Scraping / Supply-chain (residuais)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **SSRF-1r** | médio | 🔶 parcial | **Corpo de resposta ainda sem teto nos scrapers**: `statusinvest-scraper.ts:176,212,268,353` (`.text()`), `stock-quote-service.ts:487,586` e `investidor10-provider.ts:146,204` (`.json()`), `dividends-provider.ts:176` — leitura ilimitada (mitigada por timeout 15s). CVM valida `Content-Length` mas lê o corpo inteiro **antes** de checar o tamanho (`cvm-storage-service.ts:402-405`) — se o header faltar/mentir, o buffer de até N GB entra na memória antes do throw. **Agravante:** `shared/safe-fetch.ts` já implementa exatamente isso (leitura streaming com teto + redirect error) e **nenhum arquivo o importa — é código morto**. **Fix:** trocar os fetches dos scrapers por `safeFetch`/`safeFetchBuffer` (2 MiB scraper, 50 MiB CVM) ou deletar o módulo se decidir não usar. **Esforço:** P/M |

## Track E/P — Engine & Pipeline (abertos)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **N-1** | alto | 🔴 aberto | **Ranking e screener ainda truncam o universo alfabeticamente** — mesma classe do ENG-3r, corrigido só no allocation-engine: `analysis.controller.ts:576` (ações, `ORDER BY ticker ... LIMIT 200`), `analysis.controller.ts:665` (FIIs, `LIMIT 200`), `screener.controller.ts:127` (`LIMIT 100`). Com universo B3 > limite, tickers do fim do alfabeto (VALE3, WEGE3, VIVT3...) somem do ranking/screener. **Fix:** remover LIMIT (paths já são cache-first + concorrência limitada) ou cortar por liquidez/score persistido do warmup, nunca por ordem alfabética. Decidir junto: paginação do screener. **Esforço:** P/M |
| **PIPE-4r** | médio | 🔴 aberto | Padrão `parseFloat((campo \|\| '0'))` persiste (`statusinvest-scraper.ts:186-189,243-246,279`) — ausência vira `0` indistinguível de zero real, alimentando DY/proventos. **Fix:** ausência → `null` e propagar (consumidores já toleram `null` pós ENG-8/IMP-3). **Esforço:** P/M |
| **ENG-6r** | médio | 🔶 bloqueado | Pilar dividends do backtest depende de `dividends_paid` (100% NULL — PIPE-2). Sem mudança desde a rev. anterior. **Bloqueado por PIPE-2.** |
| **PIPE-1** | alto | 🕒 runtime | `shares_outstanding` ~60% NULL → P/L e P/VP "—" na maioria das ações. Investigar match de CNPJ com arquivo de capital da CVM; fallback via StatusInvest. **Esforço:** G |
| **PIPE-2** | alto | 🕒 runtime | `dividends_paid` 100% NULL (DMPL nunca casa contas 5.04.06/5.04.07). Faminta pilar de dividendos + ENG-6r. **Esforço:** G |
| **PIPE-5** | médio | 🕒 runtime | Snapshots diários possivelmente falhando (histórico: ~17/113 jobs gravando). Worker foi reescrito — **confirmar em `job_runs` real** antes de agir. **Esforço:** M |
| **PIPE-6r** | médio | 🕒 runtime | CNPJ placeholder (`STOCK*`/`FII*`) em ~53% das empresas — impede join com CVM (alimenta PIPE-1/2). Backfill de CNPJ real (B3/StatusInvest). **Esforço:** M |

## Track R/PERF — Confiabilidade & Performance (novos)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **N-3** | médio | 🔴 aberto | **Gzip síncrono no event loop** (`server.ts:124-138`): `Bun.gzipSync` roda inline para todo payload ≥1 KiB. Respostas grandes (ranking/screener, centenas de KB) bloqueiam o loop e seguram todas as outras requests. **Fix:** limite superior (ex.: só comprimir < 1 MiB), ou compressão assíncrona/stream (`@fastify/compress`), ou aceitar sem gzip para payloads grandes atrás de proxy que comprime. **Esforço:** P/M |
| **N-4** | baixo/médio | 🔴 aberto | **`updateLastUsed` faz UPDATE em `api_keys` a cada request autenticado** (`auth.ts:207-219`), inclusive em cache-hit. Write amplification no hot path (200 req/min/key = 200 UPDATEs/min). **Fix:** throttle — só atualizar se `last_used_at` > 60s (guardar timestamp em memória/Redis junto do cache de auth). **Esforço:** P |
| **N-5** | baixo | 🔴 aberto | **Rate limiter faz 2 round-trips Redis por request** (`rate-limit.ts:203,217` — `eval` + `ttl`). **Fix:** retornar `{count, ttl}` do próprio script Lua. **Esforço:** P |
| **N-6** | baixo | 🔴 aberto | Residual do REL-1: `getLocalDay` fallback ignora o `date` recebido e recalcula com `new Date()` (`time-window.ts:191-202`); o weekday viaja como propriedade expando `__tzWeekday` num `Date` (`:177`) — qualquer cópia (`new Date(d)`) perde o valor silenciosamente. Funciona hoje, mas é frágil. **Fix:** retornar um objeto `{date, weekday}` tipado em vez de expando. **Esforço:** P |
| **N-11** | baixo | 🔴 aberto | **MCP server chama a API sem timeout** (`mcp/server.ts:66-80` — `fetch` cru). Endpoint lento (ranking frio pode passar de 30s) pendura a tool call no Claude. **Fix:** `AbortSignal.timeout(120_000)` + mensagem de erro amigável. **Esforço:** P |

## Track M — Manutenibilidade / Operação (novos)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **N-9** | baixo | 🔴 aberto | **Allowlist de Units duplicada em 3 queries SQL** (`'KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11'` em `allocation-engine.ts:725`, `analysis.controller.ts:572`, e filtro espelhado no ranking FII). Divergência silenciosa quando alguém editar uma e esquecer as outras. **Fix:** constante única exportada (ex.: `shared/b3-units.ts`) interpolada via `sql.join`, ou tabela/coluna `asset_class`. **Esforço:** P |
| **N-10** | médio | 🔴 aberto | **Backups sem retenção, sem offsite, restore nunca testado.** `backup-postgres.sh` acumula `.sql.gz` locais para sempre no mesmo disco do banco; gate "Restore testado" segue aberto no `MATURITY-STATUS.md`. **Fix:** (a) pruning no script (ex.: manter 7 diários + 4 semanais); (b) cópia offsite (rclone/S3/B2 — qualquer destino barato); (c) rodar 1× o ritual `CONFIRM=yes RESTORE_DB=urano_restore_test` e marcar o gate. **Esforço:** M |
| **N-12** | médio | 🔴 aberto | **Sem monitoramento/alerta externo.** `/v1/metrics` e `/v1/health/*` existem mas nada os consome; falha de job ETL ou API fora do ar só é percebida manualmente. **Fix mínimo (single-operator):** uptime-check externo gratuito no `/v1/healthcheck` + alerta (e-mail/Telegram) quando job falhar N vezes (o scheduler já sabe o estado — falta o notificador). Prometheus/Grafana é opcional depois. **Esforço:** M |
| **N-8** | médio | 🔴 aberto | **Web sem nenhum teste (0 arquivos) e sem E2E.** O terminal já tem ~23 rotas; regressões de adapter/formatação (classe UX-1) só aparecem no olho. **Fix:** começar pelo custo-benefício alto — testes de unidade dos adapters/lib (`src/lib`) + 1 smoke E2E (Playwright: login key → ranking renderiza → detalhe abre). **Esforço:** M (unidade) / G (E2E) |
| **N-15** | baixo | 🔴 aberto | **Housekeeping:** `scripts/hash-existing-keys.ts` é artefato de migração já aplicada (coluna dropada — o script nem roda mais); `apps/web/.lovable/`, `.wrangler/`, `.tanstack/` são lixo de tooling no working tree (não versionados, mas conferir `.gitignore` do web); `MATURITY-STATUS.md` defasado (diz "SELIC hardcoded", "LIMIT 100"...). **Fix:** deletar script legado, atualizar MATURITY-STATUS junto com este doc. **Esforço:** P |

## Track U — Frontend/UX (herdado, não re-verificado)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **UX-2** | médio | 🕒 runtime | `sector` ~47% NULL → coluna Setor "—". Depende de PIPE-6r/PIPE-1. **Esforço:** M |
| **UX-3** | baixo | herdado | `changePct` sem fonte real no path StatusInvest. Decidir fonte (Yahoo) e propagar. **Esforço:** M |
| **UX-4** | baixo | herdado | ROIC nunca calculado → "—". Depende de dívida financeira real (evolução do IMP-2). **Esforço:** P/M |
| **UX-5** | baixo | herdado | FII: esconder linhas N/A (P/L, ROE...) em vez de "—". **Esforço:** P |
| **UX-6** | baixo | herdado | `isScraping` do search fica true para sempre; sem estado de erro/retry. **Esforço:** P |

## Track I — Melhorias (evoluções, não bugs)

| ID | Status | Item |
|----|--------|------|
| **IMP-1r** | 🔶 parcial | SELIC dinâmica ✅. **Resta:** setor ainda casado por substring contra tabela estática (`stock-score.ts:59`); re-fit dos pesos contra `backtest_results` — pré-requisito: ENG-6r (que depende de PIPE-2). **Esforço:** G |
| **IMP-3r** | 🔶 parcial | Coverage/confidence existe no score FII. **Resta:** mesmo conceito no score de ações (dado faltando pontua neutro) e ligar vacância/inadimplência nos paths de ranking/warmup. **Esforço:** M/G |
| **IMP-4** | 🔴 aberto | FII sem fatores diferenciadores: classificação por listas estáticas de tickers; sem cap rate, mix de indexador ou duration; backtest FII sem rank por score. **Esforço:** G |
| **N-14** | ⚠️ estratégico | **Dependência estrutural de fontes não-oficiais** (StatusInvest, Investidor10, Yahoo — scraping sem contrato). Circuit breakers e cache-first já mitigam, mas um ban ou mudança de HTML degrada DY/quotes silenciosamente. **Direção:** aumentar a fatia coberta por fontes oficiais (CVM/BCB/B3), medir no `/health/data` a % de dados por fonte, e documentar o modo degradado esperado. Alimenta a decisão "feed B3 pago" (deferred). |

---

## Matriz de prioridade sugerida

**Fase 0 — Correção imediata (alto impacto, ~½ dia):**
1. `SEC-2r` — rotacionar a key vazada no banco (única credencial viva exposta; 10 min).
2. `N-1` — remover truncamento alfabético do ranking/screener (bug de produto visível: tickers V/W ausentes).
3. `SSRF-1r` — ligar o `safeFetch` já escrito nos scrapers (ou deletá-lo).
4. `PIPE-4r` — ausência → `null` no scraper de proventos.
5. `N-11`, `N-9`, `N-6` — timeout no MCP, constante de Units, tipagem do weekday (miúdos de 15-30 min cada).

**Fase 1 — Performance & operação (~1-2 dias):**
6. `N-3` — gzip fora do hot path (medir antes: payload típico do ranking).
7. `N-4` + `N-5` — throttle do `last_used_at` e Lua único no rate limit.
8. `N-10` — retenção + offsite de backup + **ritual de restore 1×** (fecha gate de maturidade).
9. `N-12` — uptime-check externo + alerta de falha de job.

**Fase 2 — Investigação em runtime (G, precisa banco/logs reais):**
10. `PIPE-1` / `PIPE-2` / `PIPE-6r` — cobertura CVM/CNPJ (destrava ENG-6r, UX-2, e o re-fit do score).
11. `PIPE-5` — confirmar snapshots no worker novo.

**Fase 3 — Evolução do produto (depois do pipeline saudável):**
12. `IMP-3r` — coverage no score de ações + vacância no ranking.
13. `IMP-1r` — setor-relativo + re-fit dos pesos (só após ENG-6r/PIPE-2).
14. `IMP-4` — fatores FII (CVM-based) + backtest FII com score.
15. `N-8` — testes de unidade web + smoke E2E.
16. `UX-3/4/5/6` — polimentos do terminal.

**Condicionais (só se o contexto mudar):**
- `SEC-13` + `N-7` (BFF/cookie httpOnly + CSP estrita) — **gatilho: abrir para segundo usuário**.
- Staging + TLS — gatilho: deploy fora do localhost/LAN.
- `N-14` feed pago B3 — gatilho: % de dados via scraping não cair com PIPE-1/2 resolvidos.

---

## Decisões que preciso de você

1. **N-1:** remover os LIMITs do ranking/screener por completo (paths já são cache-first) ou cortar por liquidez com cap configurável? Recomendo remover e medir latência do primeiro warm.
2. **N-3:** aceitável desligar gzip para payloads > 1 MiB (proxy/browser aguentam) ou prefere `@fastify/compress` async? Recomendo o limite simples primeiro.
3. **N-10:** qual destino offsite para backup (S3/B2/rclone p/ drive)? Precisa de credencial que só você pode criar.
4. **N-12:** canal de alerta preferido (e-mail, Telegram, ntfy)? Define a implementação do notificador de jobs.
5. **Fase 2:** rodar as investigações PIPE-* direto na base de produção local (read-only) — posso preparar as queries de diagnóstico antes, para você só executar e colar o resultado.

## Pendências de verificação

- `SEC-2r` e todos os `🕒 runtime` exigem Postgres/logs reais — nada foi confirmado em banco nesta revisão.
- Track U herdado sem re-verificação visual.
- Verificação adversarial não rodou para os achados novos (N-1..N-15); a evidência é citação direta de código com linha — conferir `arquivo:linha` ao revisar cada ponto.
