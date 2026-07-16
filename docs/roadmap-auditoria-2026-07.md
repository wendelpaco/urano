# Urano — Auditoria & Roadmap (Julho 2026 — rev. 2026-07-16)

> Documento para revisão **ponto a ponto** antes de implementar. Cada item tem ID
> estável, evidência `arquivo:linha`, impacto, fix proposto e esforço.
>
> **Rev. 2026-07-16:** todos os itens da auditoria original foram re-verificados
> contra o código atual (commit `80245df` + working tree). Grande parte foi
> resolvida naquele commit — os resolvidos estão na primeira tabela, com evidência.
> O que segue aberto (ou parcial) foi re-citado com linhas atuais. A auditoria de
> **confiabilidade** que estava pendente foi executada nesta revisão (Track R).

## Como ler este documento

- **Status:**
  - `✅ resolvido` — confirmado no código atual, com evidência.
  - `🔶 parcial` — parte do problema resolvida; resta o residual descrito.
  - `🔴 aberto` — confirmado ainda presente no código atual.
  - `🕒 runtime` — precisa inspeção de dado real (banco/logs) para confirmar ou agir.
- **Severidade:** `crítico` distorce resultado/segurança de forma ampla; `alto` afeta muitos casos; `médio` casos específicos; `baixo` cosmético/hardening.
- **Esforço:** `P` (<1h), `M` (algumas horas), `G` (dia+ / precisa dado em runtime).

---

## Resolvidos desde a auditoria original (verificados em 2026-07-16)

| ID | Era | Evidência da correção |
|----|-----|----------------------|
| SEC-1 (núcleo) | API keys em texto plano no banco | Coluna `key` agora grava `ur_hashonly_<prefixo-do-hash>` (`auth.controller.ts:50`, usada em create `:150` e rotate `:230`); auth e `updateLastUsed` filtram por `keyHash` (`auth.ts:168,210`). Resta residual SEC-1r abaixo. |
| SEC-3 | Listagem de keys vazava todos os tenants | `listApiKeysController` escopa por `id = caller OR ownerId = caller` (`auth.controller.ts:200-201`); gestão só de self/filhas (`getManageableKey:96-109`); scopes administrativos não são herdáveis via HTTP (`resolveChildScopes`). |
| SEC-4 | Rate limiter burlável (bucket = header cru) e fail-open | Bucket pré-auth por hash de IP, pós-auth por `apiKeyId` (`rate-limit.ts:179-186`); `failClosed` configurável, default **true em produção** (`env.ts:70-73`); incremento atômico via script Redis. |
| SEC-5 | Defaults inseguros de env em produção | `env.ts:3,23-41` — em `NODE_ENV=production` não aceita defaults com credencial dev; exige `DATABASE_URL`/`REDIS_URL`. |
| SEC-6 | Postgres/Redis expostos em 0.0.0.0 | `docker-compose.yml:12,30` — bind `127.0.0.1`; senhas obrigatórias via `${VAR:?}` (`:58-59`). |
| SEC-7 | Sem security headers / resposta de key cacheável | Middleware dedicado com `nosniff` e `Cache-Control: no-store` em `/v1/*` (`security-headers.ts:11,28`). |
| SEC-8 | Revogação de key demorava até 60s (cache) | `invalidateCachedAuth` grava cache negativo no Redis + bloqueio local imediato (`auth.ts:50-82,130,140`). |
| SEC-9 | Erros internos vazavam em 5xx | Error handler central: 5xx responde `"Erro interno."` em **qualquer** ambiente; detalhe só em log (`server.ts:130-155`). |
| SEC-10 | Healthcheck público vazava estado operacional | `/v1/healthcheck` reduzido a db/redis up-down (`healthcheck.controller.ts`); diagnóstico de scraper atrás de `admin:ops` (`routes/index.ts:59-61`). |
| SEC-11 | Ticker sem validação de charset | `tickerParamSchema` (regex `^[A-Z]{4}\d{1,2}$`, `ticker-utils.ts:15,27`) aplicado nos controllers de stocks, fiis, dividends, fundamentals, wallets. |
| ENG-1 | camelCase/snake_case zerava fundamentos no ranking | `calcAllIndicators` aceita ambas as convenções (`indicators.ts:21,33`); ranking seleciona todas as colunas necessárias (`allocation-engine.ts:672-677`). |
| ENG-2 | DY estimado hardcoded 6% | Estimativa fabricada removida — retorna `null` + `dividendEstimateStatus: 'unavailable'` (`allocation-engine.ts:542-545`). Ver IMP-6 para computar valor real. |
| ENG-3 (seleção) | `selectDiversified` sub-alocava | Seleção em duas passagens: diversifica ~60% dos slots, completa por score (`allocation-engine.ts:830-870`). Resta residual ENG-3r (LIMIT 100). |
| ENG-4 | Liquidez FII em cotas vs thresholds em R$ | Liquidez financeira `volume * price` no warmup (`score-warmup.ts:313`) e no controller (`fiis.controller.ts:490`); score trata ausência como `null`, nunca imputa (`fii-score.ts:183`). |
| ENG-7 | Histórico de dividendos sem ordenação | Serviço novo `dividend-income.ts`: agregação mensal ordenada desc (`:62`), série com lacunas explícitas em zero e âncora `asOf` (`:72-98`) — consistência conta meses distintos, não eventos. |
| IMP-2 | EV usava passivo total como proxy de dívida | Resolvido de forma conservadora: EV/dívida ficam `null` até o ETL mapear dívida financeira real (`indicators.ts:47-48,76`) — sem número falso. Reativar é evolução (Fase 3). |
| PIPE-6 (parte) | `duration_ms smallint` overflow >32,7s; módulo morto | Migration `0018_stable_job_runtime.sql` → `integer`; `fundamentus-scraper.ts` removido do repo. |
| UX-1 | Adaptador frontend / chart / pilares | Corrigido na sessão original (DONE-1/2, commitado). Revalidar visualmente após deploy. |

---

## Track S — Segurança (residuais e novos)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **SEC-2** | alto | 🕒 runtime | **Rotacionar a key que vazou no histórico do git.** `API.http` já está sanitizado, mas a key `ur_9a02...` existe em todo o histórico e só morre quando for desativada **no banco**. **Ação:** localizar a linha pelo `key_hash` e desativar/rotacionar; adicionar regra gitleaks `ur_[0-9a-f]{12}(_[0-9a-f]{12}){3}` no CI. **Esforço:** P |
| **SEC-1r** | médio | 🔴 aberto | **Coluna `key` + índice legados ainda existem** (`schema.ts:332,355`). Código novo grava `ur_hashonly_...`, mas **linhas antigas no banco podem ainda conter a key em texto plano**, e a coluna/índice são superfície morta. **Fix:** migration que sobrescreve valores legados com o formato hashonly (ou dropa coluna + `idx_api_keys_key` de vez — nada mais lê essa coluna). **Esforço:** P |
| **SEC-12a** | baixo | 🔴 aberto | `.gitignore` cobre `.env` e `.env.*.local`, mas **não `.env.production`** (`.gitignore:19-23`). **Fix:** adicionar `.env.*`+ exceção `!.env.example`. **Esforço:** P |
| **SEC-12b** | baixo | 🔴 aberto | **MCP envia a key em cleartext** se `URANO_API_URL` apontar para host remoto `http://` (`mcp/server.ts:37`). **Fix:** recusar URL não-https quando host ≠ localhost. **Esforço:** P |
| **SEC-13** | baixo | 🔴 aberto (novo) | **API key guardada em `localStorage` no frontend** (`apps/web/src/lib/api.ts:2,59`) — qualquer XSS rouba a credencial. Aceitável para uso pessoal/self-host; se houver multiusuário, mover para proxy server-side ou cookie httpOnly. **Esforço:** M (só se multiusuário) |

## Track SSRF — Scraping / Supply-chain

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **SSRF-1** | alto | 🔴 aberto | **Respostas de upstream lidas sem limite de tamanho** — `cvm-storage-service.ts:384` (`arrayBuffer()` de ZIP da CVM, com abort de 120s mas sem teto de bytes), `statusinvest-scraper.ts:173,206,259,341` (`.json()`/`.text()`). Upstream comprometido ou MITM = OOM/zip-bomb. Timeouts já existem (15s scraper / 120s CVM). **Fix:** validar `Content-Length` e ler stream com teto (ex.: 50 MB CVM, 2 MB scraper). **Esforço:** M |
| **SSRF-3r** | médio | 🔴 aberto | **`fetch` segue redirects para host arbitrário** — nenhum `redirect:` configurado nos scrapers (default `follow`), então um 302 do StatusInvest/Yahoo pode apontar o processo para host interno. A parte de ticker-na-URL foi mitigada pela validação de charset (SEC-11 ✅). **Fix:** `redirect: 'manual'` (ou `'error'`) + allowlist de hosts nos fetches de scraping. **Esforço:** P |
| **SSRF-2r** | médio | 🔶 parcial | Live-scrape agora é cache-first com concorrência 5 (`fiis.controller.ts:467-548`) e diagnostics exige `admin:ops`. **Resta:** rotas que ainda podem disparar scrape síncrono (search/detalhe frio) não têm rate-limit dedicado mais apertado que o global — uma key válida ainda amplia custo/risco de ban. **Fix:** bucket de rate-limit separado (ex.: 10/min) nas rotas que tocam scraper. **Esforço:** P/M |

## Track E — Engine (correção)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **ENG-8** | alto | 🔴 aberto | **Empresa no prejuízo escapa das penalidades quando faltam dados.** (a) `shares` ausente → `eps = 0` (`indicators.ts:42`), então o guard `eps < 0` (`stock-score.ts:73`) nunca dispara; (b) `fcoToNetIncome` usa `|netIncome|` (`indicators.ts:83`) — empresa no prejuízo com OCF positivo ganha crédito de "qualidade". **Fix:** `eps: null` quando shares ausente (e tratar null nos consumidores); `fcoToNetIncome: null` quando `netIncome <= 0`; gate do quality premium em `netIncome > 0`. **Esforço:** P |
| **ENG-3r** | alto | 🔴 aberto | **Universo truncado nos 100 primeiros tickers alfabéticos** — ações (`allocation-engine.ts:683`) e FIIs (`:731`, `ORDER BY ticker LIMIT 100`). Ranking/alocação nunca veem PETR4/VALE3/WEGE3 se ficarem fora do corte alfabético. **Fix:** remover o LIMIT (com REL-2 para não explodir latência) ou ordenar por liquidez/score persistido antes de cortar. **Esforço:** M |
| **ENG-5r** | médio | 🔶 parcial | **Backtest ainda entra na data do balanço** (`backtest.ts:123`) — usa demonstração publicada ~3-4 meses depois (look-ahead de fundamento). Já corrigido: momentum é calculado look-ahead-free na data de referência (`:141-165`) e delistados agora ficam no resultado com `return12m: null` (`:186-187`) em vez de sumir. **Fix restante:** deslocar entrada para `reference_date + ~4 meses` (ou data real de filing CVM). **Esforço:** M |
| **ENG-6r** | médio | 🔶 parcial | **Pilar dividends do backtest depende de `dividends_paid`** (`backtest.ts:134`) — que está 100% NULL (PIPE-2). Momentum resolvido; dividends continua efetivamente constante até PIPE-2. **Bloqueado por PIPE-2.** **Esforço:** M (após PIPE-2) |

## Track P — Pipeline de dados

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **PIPE-1** | alto | 🕒 runtime | **`shares_outstanding` ~60% NULL** → P/L e P/VP "—" para a maioria das ações. Parsing correto; problema é cobertura de ingestão (match de CNPJ com arquivo de capital da CVM). **Fix:** inspecionar CSV real da CVM, entender o mismatch; fallback de shares via StatusInvest. **Esforço:** G |
| **PIPE-2** | alto | 🕒 runtime | **`dividends_paid` 100% NULL** (DMPL nunca casa contas 5.04.06/5.04.07). Faminta o pilar de dividendos e o backtest (ENG-6r). **Fix:** revisar matching de contas DMPL com dado real. **Esforço:** G |
| **PIPE-3** | médio | 🔴 aberto | **Dividendos sintéticos fabricados sem marcação** (`statusinvest-scraper.ts:276-295`) — quando só há totais anuais, gera 24 eventos mensais `anual/12` datados no dia 15, com `type: 'Rendimento'` idêntico a evento real. Infla consistência FII para fake-perfeito e envenena o cache. **Fix:** marcar `type: 'SINTETICO_ANUAL'`, e o score tratar cadência desconhecida via coverage (IMP-3) em vez de fingir 12/12 meses. Fazer junto com IMP-3. **Esforço:** M |
| **PIPE-4r** | médio | 🔶 parcial | `extractNumber` foi removido, mas o padrão `parseFloat((campo \|\| '0'))` persiste (`statusinvest-scraper.ts:181-184,235-238`) — ausência vira 0 indistinguível de 0 real. Menor superfície que antes (indicadores scraped não são mais persistidos), mas ainda alimenta DY/proventos. **Fix:** ausência → `null` e propagar. **Esforço:** P/M |
| **PIPE-5** | médio | 🕒 runtime | **Snapshots diários: ~17/113 jobs gravando** na auditoria original (provável 429). Baixo impacto hoje (nada lê snapshots), mas mata features futuras de histórico. **Fix:** ver `job_runs` real pós-`80245df` (worker foi reescrito) e confirmar se persiste; parar de gravar 0-como-dado. **Esforço:** M |
| **PIPE-6r** | baixo | 🕒 runtime | Residual: **CNPJ placeholder (`STOCK*`/`FII*`) em ~53% das empresas** — impede join com dado CVM (alimenta PIPE-1/2). **Fix:** backfill de CNPJ real (B3/StatusInvest). **Esforço:** M |

## Track R — Confiabilidade (novo — auditoria pendente executada nesta revisão)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **REL-1** | médio | 🔴 aberto | **Bug de timezone no `TimeWindow`** (`time-window.ts:129-160`): `getLocalTime()` pede `weekday` ao `Intl.DateTimeFormat` mas **nunca lê a parte** — o `Date` retornado usa ano/mês/dia do timezone **do servidor** com hora de São Paulo. `isOpen()`/`minutesUntilOpen()` chamam `getDay()` nesse Date → perto da virada de dia (servidor UTC: 21:00–23:59 em SP já é o dia seguinte em UTC) o check de `allowedDays` erra o dia da semana. Janela ETL seg-sex pode abrir no domingo à noite ou pular a segunda. **Fix:** derivar dia-da-semana das parts do Intl (que já estão ali) em vez de `getDay()`. Adicionar teste com TZ simulada. **Esforço:** P |
| **REL-2** | médio | 🔴 aberto | **Ranking constrói o universo com awaits sequenciais por ticker** (`allocation-engine.ts:670-745`): para cada um dos até 100 tickers, `getQuote` + `fetchDividends` em série. Latência de minutos na primeira carga e pressão desnecessária no upstream. **Fix:** concorrência limitada (~5 simultâneos, alinhada ao rate-limiter interno) + preferir score do warmup persistido. Pré-requisito para remover o LIMIT 100 (ENG-3r). **Esforço:** M |
| **REL-3** | baixo | 🔴 aberto | **Pool Postgres `max: 10`** (`connection.ts:13`) compartilhado entre API, scheduler e workers — job pesado + burst de requests = fila. postgres.js enfileira (não quebra), mas latência de API degrada silenciosamente durante ETL. **Fix:** monitorar; se confirmar contenção, pool separado para workers ou `max` maior. **Esforço:** P |
| **REL-4** | — | ✅ ok | Revisado sem finding: scheduler tem guarda de reentrância e não abandona jobs em shutdown (`scheduler.ts:30,62,113-114`); retry de worker é bounded por `retryCount` com espaçamento de 60s (`worker.ts:107-127`); retry HTTP tem backoff exponencial com jitter e respeita `Retry-After` (`shared/retry.ts`). |

## Track U — Frontend/UX (não re-verificado nesta revisão — herdado)

| ID | Sev | Status | Item |
|----|-----|--------|------|
| **UX-2** | médio | 🕒 runtime | `sector` ~47% NULL → coluna Setor "—". Depende de PIPE-6r/PIPE-1 (CNPJ/cobertura) + incluir sector no JSON de detalhe. **Esforço:** M |
| **UX-3** | baixo | herdado | `changePct` sem fonte real (finge 0 no path StatusInvest). Decidir fonte (Yahoo) e propagar. **Esforço:** M |
| **UX-4** | baixo | herdado | ROIC nunca calculado → "—" sempre. Adicionar em `calcAllIndicators` (NOPAT/capital investido) — depende de dívida real (junto com evolução do IMP-2). **Esforço:** P/M |
| **UX-5** | baixo | herdado | FII: esconder linhas N/A (P/L, ROE, margens...) em vez de "—". **Esforço:** P |
| **UX-6** | baixo | herdado | `isScraping` do search fica true para sempre; sem estado de erro/retry. **Esforço:** P |

## Track I — Melhorias (evoluções, não bugs)

| ID | Status | Item |
|----|--------|------|
| **IMP-1** | 🔴 aberto | **Score sem poder de ranking na própria validação** (corr ≈ 0 em `score-validation.data.ts`). Componentes confirmados ainda presentes: SELIC hardcoded `14.0` (`stock-score.ts:78`); setor por substring contra tabela estática (`stock-score.ts:46`). **Proposta:** SELIC via API BCB; scoring setor-relativo por percentil; re-fit dos pesos contra `backtest_results` — **depois** de ENG-5r/ENG-6r limparem o backtest. **Esforço:** G |
| **IMP-3r** | 🔶 parcial | Coverage/confidence já existe no score FII (`fii-score.ts:113,133,217` — `data_coverage`, `missing_data_penalty`). **Resta:** mesmo conceito no score de ações (hoje dado faltando pontua neutro), e ligar vacância/inadimplência (`fiiOperationalService`) nos paths de ranking/warmup (hoje só no endpoint single). **Esforço:** M/G |
| **IMP-4** | 🔴 aberto | FII sem fatores diferenciadores: classificação ainda por listas estáticas de tickers (`fii-classification.data.ts`); sem cap rate, mix de indexador ou duration; backtest exclui FIIs. **Proposta:** inferir tipo do dado CVM; cap rate vs NTN-B; estender backtest. **Esforço:** G |
| **IMP-5** | 🕒 recheck | Alocação proporcional-ao-score vs equal-weight do ContributionAdvisor — o allocation-engine foi reescrito no `80245df` (712 linhas); **re-verificar** se a inconsistência persiste antes de agir. **Esforço:** P (verificação) |
| **IMP-6** | 🔴 aberto (novo) | **Estimativa de renda da alocação está sempre `unavailable`** (`allocation-engine.ts:542-545`) — o fix do ENG-2 removeu o número fake mas não pôs o real no lugar. `dividend-income.ts` já sabe agregar renda mensal por ativo. **Proposta:** somar `allocationAmount * dy12m` por ativo com dado real; status `partial` quando parte do portfólio não tem DY. **Esforço:** M |

---

## Matriz de prioridade sugerida

**Fazer primeiro (alto impacto / esforço P):**
`SEC-2` (rotacionar key no banco — único item com credencial viva exposta),
`SEC-1r` (limpar coluna legada), `REL-1` (timezone da janela ETL), `ENG-8`
(prejuízo mascarado), `SSRF-3r` (redirects), `SEC-12a/b`.

**Alto impacto / esforço M:**
`SSRF-1` (teto de bytes), `PIPE-3 + IMP-3r` (sintéticos + coverage — juntos),
`REL-2` → `ENG-3r` (concorrência primeiro, depois remover LIMIT 100),
`ENG-5r` (timing do backtest), `IMP-6` (renda real na alocação), `SSRF-2r`.

**Investigação em runtime (G / precisa dado real):**
`PIPE-1`, `PIPE-2`, `PIPE-5`, `PIPE-6r` (cobertura CVM/CNPJ), `UX-2`, `SEC-2` (execução), `IMP-5` (recheck).

**Evolução (depois do backtest limpo):**
`IMP-1` (recalibração + SELIC dinâmica + setor-relativo), `IMP-4` (fatores FII), `UX-3/4/5/6`.

**Sequência de fases proposta:**

1. **Fase 0 — Residual de segurança** (~1 dia): SEC-2, SEC-1r, SSRF-3r, SSRF-1, SSRF-2r, SEC-12a/b.
2. **Fase 1 — Engine e confiabilidade** (~2-3 dias): ENG-8, REL-1, REL-2 → ENG-3r, PIPE-3 + IMP-3r (juntos), IMP-6, ENG-5r.
3. **Fase 2 — Pipeline/cobertura** (investigação em runtime): PIPE-1, PIPE-2, PIPE-6r, PIPE-5; UX-2.
4. **Fase 3 — Evolução do score**: IMP-1 (após backtest limpo), IMP-4, IMP-5 (recheck), UX-3/4/5/6.

---

## Pendências de verificação

- Itens `🕒 runtime` exigem Postgres/logs reais (read-only) — nada foi confirmado em banco nesta revisão.
- Track U (frontend) herdado da auditoria original sem re-verificação — revalidar visualmente.
- Verificação adversarial (segundo agente tentando refutar) não rodou para os achados novos desta revisão (REL-1/2/3, SEC-13, IMP-6); a evidência é citação direta de código com linha.

## Decisões que preciso de você

1. **SEC-1r:** dropar a coluna `key` + índice de vez (recomendado — nada mais lê) ou manter com valores hashonly por compatibilidade?
2. **PIPE-3 + IMP-3r:** confirmar que vão juntos (marcar sintético só faz sentido se o score souber tratar cadência desconhecida).
3. **ENG-3r:** remover o LIMIT 100 por completo (universo inteiro, exige REL-2 + warmup persistido) ou manter um cap ordenado por liquidez?
4. **Ordem Fase 1 vs Fase 2:** backtest limpo (ENG-5r) antes de recalibrar (IMP-1) — confirma essa dependência como aceita?
