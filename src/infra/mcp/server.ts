#!/usr/bin/env bun
/**
 * Urano MCP Server — Conecta Claude/ChatGPT aos dados da bolsa brasileira.
 *
 * Ferramentas expostas:
 *   get_stock_analysis  — Score completo de uma ação
 *   get_fii_analysis    — Score completo de um FII
 *   get_allocation      — Carteira recomendada por perfil de risco
 *   get_ranking         — Ranking de ações ou FIIs por score
 *   search_stocks       — Screener por critérios fundamentalistas
 *   compare_stocks      — Comparação lado a lado entre tickers
 *   get_macro           — Indicadores macroeconômicos (Selic, IPCA, etc.)
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

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('🚀 Urano MCP Server iniciado');
console.error(`   API: ${API_BASE}`);
