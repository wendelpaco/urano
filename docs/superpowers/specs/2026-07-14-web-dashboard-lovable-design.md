# Urano — Web Dashboard (Lovable) — Design

**Data:** 2026-07-14
**Status:** Aprovado
**Escopo:** Dashboard pessoal (single-user), fora da ordem original do roadmap (spec 2026-07-08 previa Fase 2 só após fechar Fase 1) — decisão consciente de adiantar por conveniência de uso pessoal.

## 1. Contexto

Urano é API headless (Fastify) de análise fundamentalista B3 (ações + FIIs): score, ranking, screener, contribution-advisor (aporte), carteiras (CRUD + rebalance), data health. Auth via header `x-api-key`, sem multi-user/JWT. Este spec cobre só a camada web que consome essa API — nenhuma mudança no backend.

## 2. Decisões

- **Público:** só o autor. Sem compliance/disclaimer regulatório, sem onboarding leigo — isso é Fase 2 pública, fora de escopo aqui.
- **Auth no front:** tela de configuração salva `x-api-key` + URL base da API em `localStorage`. Toda chamada HTTP injeta o header. Sem backend/proxy intermediário — risco aceito por ser uso pessoal.
- **Ferramenta:** Lovable (gera frontend). Usa o design system nativo dele (shadcn/ui + Tailwind), direcionado para tema dark/denso ("terminal financeiro"), não custom do zero.
- **Estilo visual:** dark mode, tabelas densas, monospace para números, verde/vermelho para sinal de score/variação. Referência: Bloomberg Terminal / TradingView / StatusInvest PRO.

## 3. Telas (MVP)

| Tela | Fonte(s) da API | Notas |
|---|---|---|
| Ranking | `GET /analysis/ranking` | ações + FIIs, filtro tipo, sort |
| Screener | `GET /screener` | 15 filtros (PE, PVP, ROE, DY, setor...), `sortBy`/`order` |
| Detalhe do ativo | `GET /analysis/stocks/:ticker`, `/analysis/fiis/:ticker`, `/stocks/:ticker/history`, `/dividends/:ticker` | score, pilares, `reasons[]`, cotação, histórico, proventos |
| Simulador de Aporte | `POST /analysis/contribution` | form: amount, profile, positions, onlyTypes, excludeSectors → compras + justificativa + descartes |
| Carteiras | `/wallets*`, `POST /wallets/:id/rebalance` | CRUD carteira + ativos |
| Data Health | `GET /health/data` | cobertura/frescor por fonte + `warnings[]`, exibido também como banner global |

## 4. Tratamento de erros

- Erros da API seguem `{error, message, details?}` (zod validation) — exibir inline no form de origem, nunca só toast genérico.
- `warnings[]` de data health nunca silenciosos — banner persistente enquanto houver warning ativo (mesma filosofia do backend: nunca degradar silenciosamente).
- 401 → redireciona para tela de Config com mensagem de key inválida/expirada.

## 5. Fora de escopo

- Multi-usuário, login/senha, compliance regulatório (CVM 19/20), onboarding leigo — tudo isso é Fase 2 pública (spec própria futura).
- Backend/proxy para esconder a api-key do browser.
- Autenticação SSO/OAuth.
