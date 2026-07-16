/**
 * Pure StatusInvest HTML parsers — no network, no Redis.
 * Used by StatusInvestScraper and golden/fixture tests.
 */

import * as cheerio from 'cheerio';

// ─── Types (owned here so parse stays free of circular deps) ─────────────────

/** Indicadores de ações extraídos do StatusInvest */
export interface ScrapedIndicators {
  ticker: string;
  name: string;
  price: number;
  // Valuation
  dy: number;
  pl: number;
  pvp: number;
  evEbitda: number;
  evEbit: number;
  pebit: number;
  vpa: number;
  lpa: number;
  psr: number;
  pegRatio: number;
  ibovParticipation: number | null;
  // Rentabilidade
  roe: number;
  roa: number;
  roic: number;
  grossMargin: number;
  ebitdaMargin: number;
  ebitMargin: number;
  netMargin: number;
  // Crescimento
  cagrRevenue5y: number | null;
  cagrEarnings5y: number | null;
  // Endividamento
  netDebtToEquity: number;
  netDebtToEbitda: number;
  currentRatio: number;
  // Eficiência
  assetTurnover: number;
  // Mercado
  avgDailyLiquidity: number;
  marketCap: number | null;
  // Dividendos
  dy12m: number;
  dividendsHistory: DividendEntry[];
  // Setor
  sector: string;
}

/** Indicadores de FIIs extraídos do StatusInvest */
export interface FiisData {
  ticker: string;
  name: string;
  price: number;
  dy12m: number;           // % a.a.
  pvp: number;
  bookValue: number;       // valor patrimonial por cota
  min52w: number;
  max52w: number;
  valorization12m: number; // %
  volatility: number;      // % a.a.
  dyCagr3y: number | null; // %
  valueCagr3y: number | null; // %
  avgMonthlyIncome24m: number;
  numShareholders: number;
  cashValue: number;
  ifixParticipation: number | null; // %
  category: 'papel' | 'tijolo' | 'hibrido';
  dividendsHistory: DividendEntry[];
  /** Totais anuais de proventos */
  earningsThisYear: number;
  earningsLastYear: number;
  provisionedThisYear: number;
}

export interface DividendEntry {
  date: string;
  value: number;
  type: string;
}

// ─── Numeric helpers ─────────────────────────────────────────────────────────

export function extractNumber(text: string | undefined): number {
  if (!text) return 0;
  const clean = text.trim().toUpperCase();
  let multiplier = 1;
  if (clean.endsWith('M')) multiplier = 1_000_000;
  else if (clean.endsWith('K')) multiplier = 1_000;
  else if (clean.endsWith('B')) multiplier = 1_000_000_000;
  const cleaned = clean.replace(/\./g, '').replace(/[^\d,-]/g, '').replace(',', '.');
  const parsed = parseFloat(cleaned);
  // Preserve sign: negative P/L, margins and net debt are meaningful — Math.abs
  // silently turned loss-making companies into positive-indicator ones.
  return isNaN(parsed) ? 0 : parsed * multiplier;
}

export function extractPercent(text: string | undefined): number {
  if (!text || text === '-') return 0;
  return extractNumber(text.replace('%', ''));
}

export function extractNullablePercent(text: string | undefined): number | null {
  if (!text || text.trim() === '-' || text.trim() === '') return null;
  return extractPercent(text);
}

export function determineFiiCategory(name: string): 'papel' | 'tijolo' | 'hibrido' {
  const n = name.toLowerCase();
  if (
    n.includes('logística') || n.includes('logistic') || n.includes('galpão') ||
    n.includes('shopping') || n.includes('mall') || n.includes('laje') ||
    n.includes('corporativ') || n.includes('industrial') || n.includes('imobiliári') ||
    n.includes('imobiliario') || n.includes('agro')
  ) return 'tijolo';
  if (
    n.includes('receb') || n.includes('renda') || n.includes('yield') ||
    n.includes('cri') || n.includes('papel') || n.includes('crédito') ||
    n.includes('credito')
  ) return 'papel';
  if (n.includes('híbrido') || n.includes('hibrido') || n.includes('fundo de fundos')) return 'hibrido';
  return 'tijolo';
}

/** Empty dividends placeholder when only HTML is available (no API call). */
const EMPTY_DIVIDENDS: DividendEntry[] = [];

/**
 * Parse a StatusInvest stock page HTML into ScrapedIndicators.
 * Does not fetch dividends — history is always empty; caller may enrich.
 */
export function parseStatusInvestHtml(html: string, ticker: string): ScrapedIndicators {
  const t = ticker.toUpperCase();
  const $ = cheerio.load(html);

  const result: ScrapedIndicators = {
    ticker: t,
    name: $('h1.lh-4').first().text().trim() || $('.company-name').first().text().trim() || t,
    price: extractNumber($('.value').first().text()),
    dy: 0, pl: 0, pvp: 0, evEbitda: 0, evEbit: 0, pebit: 0, vpa: 0, lpa: 0, psr: 0, pegRatio: 0,
    ibovParticipation: null,
    roe: 0, roa: 0, roic: 0, grossMargin: 0, ebitdaMargin: 0, ebitMargin: 0, netMargin: 0,
    cagrRevenue5y: null, cagrEarnings5y: null,
    netDebtToEquity: 0, netDebtToEbitda: 0, currentRatio: 0,
    assetTurnover: 0, avgDailyLiquidity: 0, marketCap: null,
    dy12m: 0, dividendsHistory: EMPTY_DIVIDENDS, sector: '',
  };

  const indicators: Record<string, string> = {};
  $('[data-name]').each((_, el) => {
    const name = $(el).attr('data-name')!;
    const container = $(el).closest('.d-flex')?.parent() ?? $(el).parent();
    const valueEl = container.find('strong.value').first();
    const value = valueEl.text().trim();
    if (value) indicators[name] = value;
  });

  result.dy = extractPercent(indicators['D.Y']);
  result.pl = extractNumber(indicators['P/L']);
  result.pvp = extractNumber(indicators['P/VP']);
  result.evEbitda = extractNumber(indicators['EV/EBITDA']);
  result.evEbit = extractNumber(indicators['EV/EBIT']);
  result.pebit = extractNumber(indicators['P/EBIT']);
  result.vpa = extractNumber(indicators['VPA']);
  result.lpa = extractNumber(indicators['LPA']);
  result.psr = extractNumber(indicators['P/SR']);
  result.pegRatio = extractNumber(indicators['PEG Ratio']);

  result.roe = extractPercent(indicators['ROE']);
  result.roa = extractPercent(indicators['ROA']);
  result.roic = extractPercent(indicators['ROIC']);
  result.grossMargin = extractPercent(indicators['M. Bruta']);
  result.ebitdaMargin = extractPercent(indicators['M. EBITDA']);
  result.ebitMargin = extractPercent(indicators['M. EBIT']);
  result.netMargin = extractPercent(indicators['M. Líquida']);

  result.cagrRevenue5y = extractNullablePercent(indicators['CAGR Receitas 5 anos']);
  result.cagrEarnings5y = extractNullablePercent(indicators['CAGR Lucros 5 anos']);

  result.netDebtToEquity = extractNumber(indicators['Dív. líquida/PL']);
  result.netDebtToEbitda = extractNumber(indicators['Dív. líquida/EBITDA']);
  result.currentRatio = extractPercent(indicators['Liq. corrente']);
  result.assetTurnover = extractPercent(indicators['Giro ativos']);

  result.avgDailyLiquidity = extractNumber(indicators['Liquidez Média Diária']);

  // PIPE-1/UX-2: StatusInvest usa /setor/ (singular) desde ~2025.
  // Mantém fallback para o plural antigo.
  let sectorEl = $('a[href*="/setor/"]').first();
  if (sectorEl.length === 0) sectorEl = $('a[href*="/setores/"]').first();
  // Limpa sujeira (ícones Material Icons como "arrow_forward", quebras de linha)
  result.sector = sectorEl.text()
    .replace(/arrow_forward|keyboard_arrow_down|chevron_right/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
  result.ibovParticipation = extractNullablePercent(indicators['PART. IBOV']);

  const dy12El = $('[title="Dividend Yield com base nos últimos 12 meses"]');
  if (dy12El.length > 0) {
    const dy12Val = dy12El.closest('div').find('strong.value').first().text().trim();
    result.dy12m = extractPercent(dy12Val);
  }

  return result;
}

/**
 * Extract FII indicator key/value pairs from a loaded Cheerio document.
 */
export function extractAllFIIndicators($: cheerio.CheerioAPI): Record<string, string> {
  const result: Record<string, string> = {};

  $('.sub-title').each((_, el) => {
    const key = $(el).text().trim();
    const container = $(el).parent();
    const val = container.find('.sub-value, strong.value, .value').first().text().trim();
    if (key && val) result[key] = val;
  });

  $('h3.title').each((_, el) => {
    const key = $(el).clone().children().remove().end().text().trim();
    if (!key || result[key]) return;
    const container = $(el).closest('div');
    const val = container.find('strong.value, .value').first().text().trim();
    if (val && val !== '--') result[key] = val;
  });

  $('[data-name]').each((_, el) => {
    const key = $(el).attr('data-name')!;
    const val = $(el).closest('div').find('strong.value').first().text().trim();
    if (val) result[key] = val;
  });

  return result;
}

/**
 * Parse a StatusInvest FII page HTML into FiisData (without dividend API).
 * Dividends and annual earnings are left empty / zero — caller may enrich.
 */
export function parseStatusInvestFiiHtml(html: string, ticker: string): FiisData {
  const t = ticker.toUpperCase();
  const $ = cheerio.load(html);

  const name = $('h1.lh-4, .company-name').first().text().trim() || t;
  const price = extractNumber($('.value').first().text());
  const indicators = extractAllFIIndicators($);
  const category = determineFiiCategory(name);

  return {
    ticker: t,
    name,
    price,
    dy12m: extractPercent(indicators['Dividend Yield']),
    pvp: extractNumber(indicators['P/VP']),
    bookValue: extractNumber(indicators['Val. patrimonial p/cota']),
    min52w: extractNumber(indicators['Min. 52 semanas']),
    max52w: extractNumber(indicators['Máx. 52 semanas']),
    valorization12m: extractPercent(indicators['Valorização (12m)']),
    volatility: extractPercent(indicators['Volatilidade']),
    dyCagr3y: extractNullablePercent(indicators['DY CAGR (3 anos)']),
    valueCagr3y: extractNullablePercent(indicators['Valor CAGR (3 anos)']),
    avgMonthlyIncome24m: extractNumber(indicators['RENDIMENTO MENSAL MÉDIO (24M)']),
    numShareholders: parseInt(indicators['Nº de Cotistas']?.replace(/\D/g, '') || '0', 10),
    cashValue: extractNumber(indicators['Valor em caixa']),
    ifixParticipation: extractNullablePercent(indicators['PARTICIPAÇÃO NO IFIX']),
    category,
    dividendsHistory: EMPTY_DIVIDENDS,
    earningsThisYear: 0,
    earningsLastYear: 0,
    provisionedThisYear: 0,
  };
}
