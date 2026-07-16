/**
 * Ticker Utilities — Classificação de tickers B3.
 *
 * No mercado brasileiro, tickers terminados em "11" são ambíguos:
 *   - FIIs (Fundos Imobiliários):    HGLG11, KNCR11, XPML11
 *   - Units (combos ON+PN de ações): KLBN11, SANB11, TAEE11, ENGI11, ALUP11, BPAC11
 *
 * A classificação NÃO pode usar apenas regex/endsWith('11').
 * É necessário consultar a lista de Units conhecidas.
 */

import { z } from 'zod';

/** Formato de ticker B3: 4 letras + 1–2 dígitos (PETR4, HGLG11, BOVA11, AAPL34). */
export const B3_TICKER_REGEX = /^[A-Z]{4}\d{1,2}$/;

/**
 * Schema Zod para um parâmetro de ticker vindo do cliente. Restringe o charset
 * ao formato B3 — sem isso, `.min(4).max(10)` aceita algo como "../../a", que
 * interpolado na URL de um scraper vira path traversal dentro do mesmo domínio.
 */
export const tickerParamSchema = z
  .string()
  .trim()
  .min(4)
  .max(10)
  .transform((t) => t.toUpperCase())
  .refine((t) => B3_TICKER_REGEX.test(t), {
    message: 'Ticker inválido. Use o formato B3 (ex.: PETR4, HGLG11).',
  });

// ─── Units Conhecidas (ações que terminam em 11) ────────────────────────────

/**
 * Tickers terminados em "11" que são UNITS (ações), NÃO FIIs.
 *
 * Fonte: mapeamento TICKER_TO_CNPJ em sync-company-fundamentals.ts.
 * Estes tickers têm CNPJ real de empresa listada na B3.
 */
const KNOWN_STOCK_UNITS = new Set([
  'KLBN11',  // Klabin S.A. — Unit
  'SANB11',  // Banco Santander Brasil — Unit
  'TAEE11',  // Transmissora Aliança de Energia Elétrica — Unit
  'ENGI11',  // Energisa — Unit
  'ALUP11',  // Alupar Investimentos — Unit
  'BPAC11',  // Banco BTG Pactual — Unit
]);

// ─── Classificação ──────────────────────────────────────────────────────────

/** Tipo de ativo na B3 */
export type AssetType = 'stock' | 'fii';

/**
 * Determina se um ticker é um FII (Fundo de Investimento Imobiliário).
 *
 * Regras:
 * 1. Se está na lista de Units conhecidas → NÃO é FII (é ação)
 * 2. Se termina em "11" e tem formato FII (4 letras + 11) → É FII
 * 3. Caso contrário → NÃO é FII (é ação)
 *
 * @param ticker Ticker B3 (ex: 'HGLG11', 'PETR4', 'KLBN11')
 */
export function isFii(ticker: string): boolean {
  const upper = ticker.toUpperCase().trim();

  // Units conhecidas são ações, não FIIs
  if (KNOWN_STOCK_UNITS.has(upper)) return false;

  // FIIs: 4 letras + "11"
  return /^[A-Z]{4}11$/.test(upper);
}

/**
 * Retorna o tipo de ativo ('stock' | 'fii') para um ticker.
 */
export function getAssetType(ticker: string): AssetType {
  return isFii(ticker) ? 'fii' : 'stock';
}

/**
 * Verifica se um ticker é uma Unit (ação ON+PN).
 */
export function isUnit(ticker: string): boolean {
  return KNOWN_STOCK_UNITS.has(ticker.toUpperCase().trim());
}

/**
 * Retorna o endpoint de proventos do StatusInvest para o tipo de ativo.
 */
export function getDividendsEndpoint(ticker: string): {
  path: string;
  params: string;
  isFii: boolean;
} {
  const fii = isFii(ticker);
  const upper = ticker.toUpperCase();

  if (fii) {
    // chartProventsType=2 devolve assetEarningsModels com histórico longo (~10y).
    // Sem o param a API costuma truncar a ~12–24 meses (backtest FII fica sem DY).
    return {
      path: '/fii/companytickerprovents',
      params: `?ticker=${upper}&chartProventsType=2`,
      isFii: true,
    };
  }

  return {
    path: '/acao/companytickerprovents',
    params: `?ticker=${upper}&chartProventsType=2`,
    isFii: false,
  };
}
