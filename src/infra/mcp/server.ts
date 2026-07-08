#!/usr/bin/env bun
/**
 * Urano MCP Server — Conecta Claude/ChatGPT aos dados da bolsa brasileira.
 *
 * Ferramentas expostas:
 *   get_stock_analysis   — Score completo de uma ação
 *   get_fii_analysis     — Score completo de um FII
 *   get_allocation       — Carteira recomendada por perfil de risco
 *   get_ranking          — Ranking de ações ou FIIs por score
 *   search_stocks        — Screener por critérios fundamentalistas
 *   compare_stocks       — Comparação lado a lado entre tickers
 *   get_macro            — Indicadores macroeconômicos (Selic, IPCA, etc.)
 *   get_stock_stats      — Estatísticas: 52w range, YTD, volume
 *   get_corporate_events — Desdobramentos, grupamentos, bonificações
 *   screen_fiis          — Screener de FIIs por P/VP, DY, classificação
 *   get_fii_operational  — Dados operacionais: vacância, imóveis, inquilinos
 *
 * Uso:
 *   Claude Desktop: adicionar ao claude_desktop_config.json
 *   {
 *     "mcpServers": {
 *       "urano": {
 *         "command": "bun",
 *         "args": ["run", "/caminho/para/urano/src/infra/mcp/server.ts"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.URANO_API_URL || 'http://localhost:3000/v1';

async function api(path: string): Promise<unknown> {
  const key = process.env.URANO_API_KEY || 'dev';
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-api-key': key, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const key = process.env.URANO_API_KEY || 'dev';
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'urano',
  version: '1.0.0',
  description: 'Urano — API de análise fundamentalista de ações e FIIs brasileiros. Scores, alocação, ranking e dados macroeconômicos.',
});

// ── Ferramentas ─────────────────────────────────────────────────────────────

server.tool(
  'get_stock_analysis',
  'Análise completa de uma ação brasileira: score 0-100, valuation, rentabilidade, crescimento, dividendos, qualidade, momento. Inclui reasons, alerts e diagnóstico em português.',
  { ticker: z.string().describe('Ticker da ação (ex: PETR4, VALE3, WEGE3)') },
  async ({ ticker }) => {
    const data = await api(`/analysis/stocks/${ticker.toUpperCase()}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_fii_analysis',
  'Análise completa de um Fundo Imobiliário: score 0-100, P/VP, DY, rendimento mensal médio, tipo (tijolo/papel), subclassificação, recomendação.',
  { ticker: z.string().describe('Ticker do FII (ex: HGLG11, XPML11, KNCR11)') },
  async ({ ticker }) => {
    const data = await api(`/analysis/fiis/${ticker.toUpperCase()}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_allocation',
  'Sugere uma carteira de investimentos diversificada com base no valor a investir e perfil de risco (conservador, moderado, agressivo). Retorna quais ativos comprar, quanto alocar em cada um e por quê.',
  {
    totalAmount: z.number().positive().default(10000).describe('Valor total a investir em reais'),
    riskProfile: z.enum(['conservador', 'moderado', 'agressivo']).default('moderado').describe('Perfil de risco do investidor'),
  },
  async ({ totalAmount, riskProfile }) => {
    const data = await apiPost('/analysis/allocate', { totalAmount, riskProfile });
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_ranking',
  'Ranking das melhores ações ou FIIs por score. Permite filtrar por score mínimo.',
  {
    type: z.enum(['stock', 'fii']).default('stock').describe('Tipo de ativo: stock (ações) ou fii (fundos imobiliários)'),
    limit: z.number().int().min(1).max(20).default(10).describe('Quantidade de ativos no ranking'),
  },
  async ({ type, limit }) => {
    const data = await api(`/analysis/ranking?type=${type}&limit=${limit}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'compare_stocks',
  'Comparação lado a lado entre duas ou mais ações. Mostra score, P/L, ROE, DY e diagnóstico de cada uma.',
  {
    tickers: z.array(z.string()).min(2).max(5).describe('Lista de tickers a comparar (ex: ["PETR4", "VALE3", "WEGE3"])'),
  },
  async ({ tickers }) => {
    const results: Record<string, unknown> = {};
    for (const t of tickers) {
      try {
        const data = await api(`/analysis/stocks/${t.toUpperCase()}`) as Record<string, unknown>;
        results[t.toUpperCase()] = {
          score: data.score,
          diagnosis: data.diagnosis,
          valuation: (data.breakdown as Record<string, unknown>)?.valuation,
          profitability: (data.breakdown as Record<string, unknown>)?.profitability,
          peRatio: (data.indicators as Record<string, unknown>)?.peRatio,
          roe: (data.indicators as Record<string, unknown>)?.roe,
          dividendYield: (data.indicators as Record<string, unknown>)?.dividendYield,
        };
      } catch {
        results[t.toUpperCase()] = { error: 'Ticker não encontrado' };
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  },
);

server.tool(
  'get_macro',
  'Indicadores macroeconômicos do Brasil: SELIC, IPCA, PIB, câmbio USD/BRL. Dados oficiais do Banco Central.',
  {},
  async () => {
    const data = await api('/macro');
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_stock_stats',
  'Estatísticas de uma ação: preço atual, máxima/mínima 52 semanas, retorno no ano (YTD), volume médio diário, posição no range 52 semanas.',
  { ticker: z.string().describe('Ticker da ação (ex: PETR4, VALE3)') },
  async ({ ticker }) => {
    const data = await api(`/stocks/${ticker.toUpperCase()}/stats`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_corporate_events',
  'Eventos corporativos de uma ação: desdobramentos, grupamentos, bonificações. Útil para entender ajustes históricos de preço.',
  { ticker: z.string().describe('Ticker da ação (ex: MGLU3, PETR4)') },
  async ({ ticker }) => {
    const data = await api(`/stocks/${ticker.toUpperCase()}/corporate-events`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'screen_fiis',
  'Filtra FIIs por métricas: P/VP máximo, dividend yield mínimo, liquidez mínima, classificação (tijolo/papel/híbrido/fundo_de_fundos), ordenação por DY ou P/VP.',
  {
    pvp_lte: z.number().min(0).optional().describe('P/VP máximo (ex: 1.0 = abaixo do valor patrimonial)'),
    dy_gte: z.number().min(0).optional().describe('Dividend yield mínimo em % a.a. (ex: 8)'),
    liquidity_gte: z.number().min(0).optional().describe('Liquidez mínima em R$ (ex: 1000000)'),
    classification: z.enum(['tijolo', 'papel', 'hibrido', 'fundo_de_fundos']).optional().describe('Classificação do FII'),
    segment: z.string().optional().describe('Segmento (ex: Logística, Shopping, Lajes Corporativas)'),
    sort: z.enum(['dy', 'pvp', 'price', 'liquidity']).default('dy'),
    limit: z.number().int().min(1).max(20).default(10),
  },
  async (params) => {
    const qs = new URLSearchParams();
    if (params.pvp_lte !== undefined) qs.set('pvp_lte', String(params.pvp_lte));
    if (params.dy_gte !== undefined) qs.set('dy_gte', String(params.dy_gte));
    if (params.liquidity_gte !== undefined) qs.set('liquidity_gte', String(params.liquidity_gte));
    if (params.classification) qs.set('classification', params.classification);
    if (params.segment) qs.set('segment', params.segment);
    qs.set('sort', params.sort);
    qs.set('limit', String(params.limit));
    const data = await api(`/fiis/screener?${qs.toString()}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_fii_operational',
  'Dados operacionais completos de um FII: composição de ativos (% em imóveis, CRI, etc.), vacância, inadimplência, principais imóveis, concentração de inquilinos, administrador, data de início, mandato.',
  { ticker: z.string().describe('Ticker do FII (ex: HGLG11, XPML11, KNCR11)') },
  async ({ ticker }) => {
    const data = await api(`/fiis/${ticker.toUpperCase()}/operational`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'compare_assets',
  'Comparação lado a lado entre ações ou FIIs. Mostra score, P/L, P/VP, ROE, DY, margens e destaques de cada ativo alinhados para facilitar a análise comparativa. Indica o melhor da lista (bestPick) e a média dos scores.',
  {
    tickers: z.array(z.string()).min(2).max(10).describe('Lista de tickers a comparar (ex: ["PETR4", "VALE3", "WEGE3"])'),
    type: z.enum(['stock', 'fii']).default('stock').describe('Tipo de ativo'),
  },
  async ({ tickers, type }) => {
    const data = await apiPost('/analysis/compare', { tickers, type });
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'search_stocks',
  'Filtra ações por múltiplos critérios fundamentalistas: score, P/L, P/VP, EV/EBIT, ROE, ROA, margem líquida, LPA, DY, dívida, setor. Retorna as melhores ações que atendem aos critérios.',
  {
    minScore: z.number().int().min(0).max(100).optional().describe('Score mínimo (0-100)'),
    maxPE: z.number().min(0).optional().describe('P/L máximo (ex: 10)'),
    maxPVP: z.number().min(0).optional().describe('P/VP máximo (ex: 2)'),
    minROE: z.number().optional().describe('ROE mínimo em % (ex: 15)'),
    minROA: z.number().optional().describe('ROA mínimo em % (ex: 5)'),
    minNetMargin: z.number().optional().describe('Margem líquida mínima em % (ex: 10)'),
    minDY: z.number().min(0).optional().describe('Dividend yield mínimo em % (ex: 5)'),
    maxDE: z.number().min(0).optional().describe('Dívida/Equity máximo (ex: 2)'),
    sector: z.string().optional().describe('Setor (ex: Energia Elétrica, Bancos)'),
    sortBy: z.enum(['score', 'peRatio', 'pvp', 'roe', 'roa', 'dy', 'netMargin']).default('score'),
    limit: z.number().int().min(1).max(20).default(10),
  },
  async (params) => {
    const qs = new URLSearchParams();
    if (params.minScore !== undefined) qs.set('minScore', String(params.minScore));
    if (params.maxPE !== undefined) qs.set('maxPE', String(params.maxPE));
    if (params.maxPVP !== undefined) qs.set('maxPVP', String(params.maxPVP));
    if (params.minROE !== undefined) qs.set('minROE', String(params.minROE));
    if (params.minROA !== undefined) qs.set('minROA', String(params.minROA));
    if (params.minNetMargin !== undefined) qs.set('minNetMargin', String(params.minNetMargin));
    if (params.minDY !== undefined) qs.set('minDY', String(params.minDY));
    if (params.maxDE !== undefined) qs.set('maxDE', String(params.maxDE));
    if (params.sector) qs.set('sector', params.sector);
    qs.set('sortBy', params.sortBy);
    qs.set('limit', String(params.limit));
    const data = await api(`/screener?${qs.toString()}`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('🚀 Urano MCP Server iniciado');
console.error(`   API: ${API_BASE}`);
