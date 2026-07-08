# Urano — Roadmap de Produto (validação → MCP consultor → público)

**Data:** 2026-07-08
**Status:** Aprovado (direção validada em brainstorming)
**Decisão de escopo:** Caminho A — validar o motor antes de qualquer UX nova. Escopo do produto: renda variável B3 (ações + FIIs). Usuário da fase atual: o próprio autor, via MCP/Claude. Público geral entra apenas na Fase 2.

## 1. Contexto e problema

O Urano hoje é uma API headless completa (39 rotas, 12 tools MCP, scores de ações e FIIs, screener, ranking, rebalance, backtest V2), mas:

1. **O score nunca foi validado.** O backtest V2 rodou, porém o output não foi analisado. Não se sabe se comprar top N por score bate IBOV/média do mercado. Toda recomendação construída sobre o score herda essa incerteza.
2. **O MCP é consulta, não consultoria.** As 12 tools respondem "o que é X?" e "quais os melhores?", mas nenhuma responde a pergunta que define o produto: *"tenho R$ 2.000 este mês — onde aporto e por quê?"* considerando a carteira atual do usuário.
3. **Não há observabilidade de dados.** Fundamentals desatualizados ou faltantes degradam o score silenciosamente; nada mede cobertura nem frescor.
4. **A fase pública tem um bloqueio regulatório conhecido.** Recomendação de investimento para terceiros é atividade regulada (consultoria: Resolução CVM 19/2021; análise: Resolução CVM 20/2021). Não bloqueia o uso pessoal, mas condiciona como a Fase 2 pode se apresentar.

## 2. Visão de produto

> Um consultor de renda variável B3 que qualquer pessoa consegue usar: diz onde aportar, quanto e por quê, em linguagem humana, com recomendações **comprovadamente** melhores que o acaso.

A palavra "comprovadamente" define a ordem do roadmap: primeiro provar, depois embalar.

## 3. Fases

### Fase 0 — Validação do motor (gate: edge comprovado ou limites entendidos)

Objetivo: responder com dados se o score prediz retorno. Nada de UX nova até este gate fechar.

**0a. Persistir resultados do backtest.** Hoje o backtest V2 imprime no console e o resultado se perde. Criar tabela `backtest_results` (ano, ticker, score, pilares, retorno 12m, run_id, created_at) e gravar cada rodada. Análise passa a ser reproduzível e comparável entre versões do score.

**0b. Análise da rodada atual.** Rodar o backtest completo com os anos disponíveis no banco e produzir um relatório respondendo:
- Correlação score → retorno 12m (geral e por pilar) — quais pilares carregam sinal e quais são ruído
- Estratégia top N (N = 5, 10, 15) vs IBOV e vs média do universo, ano a ano
- Consistência: em quantos anos a estratégia ganha? Drawdown relativo nos anos que perde?
- Buckets de score (decis): monotonicidade — decil 10 rende mais que decil 1?

**0c. Iteração de pesos (se necessário).** Se a correlação por pilar mostrar pilares mortos ou pesos invertidos, ajustar `stock-score.ts` e re-rodar. Critério de parada: melhora estabiliza ou risco de overfitting (ajustar pesos até o passado ficar bonito é curve-fitting — máximo 2 iterações de ajuste, mudanças justificáveis economicamente, não só estatisticamente).

**0d. Registro da conclusão.** Documento curto em `docs/` com o veredito: qual configuração de score foi validada, contra quais anos, com quais números. Vira a "etiqueta de confiança" que o MCP e a futura web citam.

**Critério de saída da Fase 0 (um dos dois):**
- ✅ Edge: top 10 por score ≥ média do universo na maioria dos anos testados, com decis monotônicos → score aprovado para recomendação
- ⚠️ Sem edge robusto: documentar o que o score *é* capaz de fazer (ex.: filtrar os piores decis, mesmo sem ordenar os melhores) e reposicionar a linguagem do produto (filtro de qualidade, não seletor de vencedores)

**FIIs:** o backtest atual exclui FIIs (sem fundamentals CVM históricos). Validação de FII fica explicitamente fora da Fase 0 — o FII score permanece com rótulo "heurística não validada" no `dataQuality`, e a validação entra como pesquisa futura (fonte candidata: histórico de cotas + proventos para backtest de renda total).

### Fase 1 — MCP consultor (gate: uso pessoal recorrente e satisfatório)

Objetivo: transformar o MCP de "consultas" em "consultor". Três entregas:

**1a. Tool `suggest_contribution` (aporte mensal).** A tool que define o produto:
- Input: valor disponível, posições atuais (opcional: `[{ticker, quantity}]`), perfil (conservador/moderado/agressivo), preferências (ex.: só ações, só FIIs, excluir setor)
- Pipeline interno: ranking por score (validado na Fase 0) → diversificação por setor/classe → rebalance contra posições atuais → lotes inteiros dentro do valor
- Output: lista de compras com quantidade, custo estimado e **justificativa em português por ativo** (reusa `reasons[]` do score), mais o que *não* foi comprado e por quê (concentração, score baixo, liquidez)
- Reusa: `allocation-engine.ts`, `execute-rebalance.ts`, ranking existente — é composição, não motor novo

**1b. Tool `explain_score`.** Dado um ticker, explica o score em linguagem de leigo: o que cada pilar mede, onde o ativo vai bem/mal, e cita a validação da Fase 0 ("este score acertou X% das vezes no backtest 2015-2024"). Base da confiança do usuário.

**1c. Data health.** Endpoint `GET /v1/health/data` + tool MCP correspondente:
- Cobertura: nº de empresas com fundamentals por ano fiscal, % do universo com dados < 12 meses
- Frescor: data do último sync por fonte (CVM, Yahoo, StatusInvest, BCB)
- Alertas: tickers no ranking com dados velhos (score potencialmente podre)
- O MCP consultor consulta isso antes de recomendar e avisa o usuário quando a base está degradada

**Critério de saída da Fase 1:** o autor usa `suggest_contribution` em aportes reais por ≥ 2 meses e as respostas são acionáveis sem precisar conferir manualmente em outras fontes.

### Fase 2 — Público (web app) — esboço, spec própria depois

Registrado para não perder, mas **fora do escopo desta spec** (terá brainstorming próprio quando a Fase 1 fechar):

- Web app (dashboard: ranking, análise por ticker, simulador de aporte)
- Onboarding para leigo (perfil de risco, glossário, linguagem sem jargão)
- **Compliance:** enquadramento como ferramenta educacional/informativa com disclaimers explícitos ("isto não é recomendação de investimento"), ou registro CVM. Decisão jurídica antes de qualquer marketing.
- Multi-usuário (users/JWT — hoje explicitamente fora, conforme spec 2026-07-07)
- Infra de produção: deploy, monitoramento, backup

## 4. Arquitetura (deltas)

```
src/
├── core/services/
│   └── contribution-advisor.ts    # NOVO (1a) — composição pura: ranking + diversificação + lotes
├── infra/
│   ├── database/schema.ts         # + tabela backtest_results (0a)
│   ├── workers/backtest.ts        # grava em backtest_results além do console (0a)
│   ├── http/controllers/
│   │   └── health.controller.ts   # NOVO (1c) — GET /v1/health/data
│   └── mcp/server.ts              # + suggest_contribution, explain_score, get_data_health
```

Princípio mantido: `core/` puro e testável; `infra/` faz I/O. `contribution-advisor.ts` recebe ranking, posições e preços como input — zero rede/banco.

## 5. Fluxo de dados (suggest_contribution)

```
MCP suggest_contribution({ amount: 2000, positions: [...], profile: "moderado" })
  → data health check (cobertura ok? senão, warning na resposta)
  → ranking ações + FIIs (cache 30min, já existe)
  → contribution-advisor.ts:
      filtra score mínimo do perfil → diversifica (máx % por setor/ativo)
      → rebalance vs posições → lotes inteiros dentro do amount
  → monta resposta: compras + justificativas (reasons do score) + descartes explicados
```

## 6. Tratamento de erros

- Data health degradado (fonte fora ou dados velhos) → recomendação sai com bloco `warnings[]`, nunca silenciosa
- Posições com ticker desconhecido → ignorado com aviso, não falha
- Valor insuficiente para 1 lote de qualquer sugestão → resposta explica e sugere acumular
- Backtest: falha de preço Yahoo em um ticker → ticker pulado e contado em `skipped` (comportamento atual mantido, mas agora persistido)

## 7. Testes

- `contribution-advisor.test.ts` — casos: carteira vazia, carteira concentrada (força diversificação), valor pequeno (< 1 lote), perfil conservador vs agressivo, ticker desconhecido
- `backtest` — teste do cálculo de correlação e buckets com fixtures estáticas (funções puras extraídas do worker)
- Golden tests existentes de score continuam como regressão durante a iteração 0c

## 8. Fora de escopo (registrado)

| Item | Motivo |
|---|---|
| Renda fixa / alocação completa | Decisão de escopo: só RV B3 |
| Validação do FII score | Sem fundamentals CVM históricos de FII; pesquisa futura |
| Web app / frontend | Fase 2, spec própria |
| Multi-usuário, alertas, imposto | Mantido fora conforme spec 2026-07-07 |
| ML / fatores novos no score | Só se a Fase 0 reprovar os pilares atuais; evitar perfeccionismo |

## 9. Riscos

- **Backtest reprova o score** — risco real e é exatamente o que a Fase 0 existe para descobrir cedo. Mitigação: critério de saída alternativo (reposicionar como filtro de qualidade)
- **Overfitting na iteração de pesos** — máximo 2 iterações, mudanças com justificativa econômica, validação em anos não usados no ajuste quando possível
- **Sobrevivência do universo (survivorship bias)** — o banco só tem empresas listadas hoje; empresas deslistadas/falidas não entram no backtest, inflando retornos. Registrar como limitação conhecida no relatório 0d
- **Yahoo Finance como fonte de preço histórico** — não documentado, pode falhar/mudar. Mitigação: retry existente + `skipped` contado; se degradar muito, avaliar fonte alternativa (B3 histórico oficial)

## 10. Ordem de execução

```
Fase 0: 0a (persistir) → 0b (rodar + analisar) → 0c (iterar, se preciso) → 0d (veredito)
Fase 1: 1c (data health) → 1a (suggest_contribution) → 1b (explain_score)
         (1c primeiro: advisor depende do health check)
Fase 2: brainstorming próprio após gate da Fase 1
```
