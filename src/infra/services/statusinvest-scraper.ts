/**
 * StatusInvest Scraper V2 — Extrai TODOS os indicadores disponíveis.
 *
 * Usa data-name attributes (estrutura real do HTML do StatusInvest em 2026).
 * Extrai: valuation, rentabilidade, crescimento, endividamento, eficiência, dividendos.
 */

import * as cheerio from 'cheerio';
import { withRetry } from '../../shared/retry.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

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

export interface DividendEntry {
  date: string;
  value: number;
  type: string;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private refillRate: number;
  constructor(ratePerSecond: number) {
    this.tokens = ratePerSecond;
    this.lastRefill = Date.now();
    this.refillRate = ratePerSecond / 1000;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    this.tokens = Math.min(2, this.tokens + (now - this.lastRefill) * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return; }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((r) => setTimeout(r, waitMs));
    this.tokens = 0; this.lastRefill = Date.now();
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class StatusInvestScraper {
  private readonly baseUrl = 'https://statusinvest.com.br';
  private readonly rateLimiter = new TokenBucket(1.5);

  private randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0]!;
  }

  async fetchStock(ticker: string): Promise<ScrapedIndicators> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/acoes/${t.toLowerCase()}`;
    await this.rateLimiter.acquire();
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const result: ScrapedIndicators = {
      ticker: t,
      name: $('h1.lh-4').first().text().trim() || $('.company-name').first().text().trim() || t,
      price: this.extractNumber($('.value').first().text()),
      dy: 0, pl: 0, pvp: 0, evEbitda: 0, evEbit: 0, pebit: 0, vpa: 0, lpa: 0, psr: 0, pegRatio: 0,
      ibovParticipation: null,
      roe: 0, roa: 0, roic: 0, grossMargin: 0, ebitdaMargin: 0, ebitMargin: 0, netMargin: 0,
      cagrRevenue5y: null, cagrEarnings5y: null,
      netDebtToEquity: 0, netDebtToEbitda: 0, currentRatio: 0,
      assetTurnover: 0, avgDailyLiquidity: 0, marketCap: null,
      dy12m: 0, dividendsHistory: [], sector: '',
    };

    // Extrai TODOS os indicadores via data-name
    const indicators: Record<string, string> = {};
    $('[data-name]').each((_, el) => {
      const name = $(el).attr('data-name')!;
      // O valor está no strong.value irmão/próximo
      const container = $(el).closest('.d-flex')?.parent() ?? $(el).parent();
      const valueEl = container.find('strong.value').first();
      const value = valueEl.text().trim();
      if (value) indicators[name] = value;
    });

    // Mapeia data-name → campos
    result.dy = this.extractPercent(indicators['D.Y']);
    result.pl = this.extractNumber(indicators['P/L']);
    result.pvp = this.extractNumber(indicators['P/VP']);
    result.evEbitda = this.extractNumber(indicators['EV/EBITDA']);
    result.evEbit = this.extractNumber(indicators['EV/EBIT']);
    result.pebit = this.extractNumber(indicators['P/EBIT']);
    result.vpa = this.extractNumber(indicators['VPA']);
    result.lpa = this.extractNumber(indicators['LPA']);
    result.psr = this.extractNumber(indicators['P/SR']);
    result.pegRatio = this.extractNumber(indicators['PEG Ratio']);

    result.roe = this.extractPercent(indicators['ROE']);
    result.roa = this.extractPercent(indicators['ROA']);
    result.roic = this.extractPercent(indicators['ROIC']);
    result.grossMargin = this.extractPercent(indicators['M. Bruta']);
    result.ebitdaMargin = this.extractPercent(indicators['M. EBITDA']);
    result.ebitMargin = this.extractPercent(indicators['M. EBIT']);
    result.netMargin = this.extractPercent(indicators['M. Líquida']);

    result.cagrRevenue5y = this.parseNullablePercent(indicators['CAGR Receitas 5 anos']);
    result.cagrEarnings5y = this.parseNullablePercent(indicators['CAGR Lucros 5 anos']);

    result.netDebtToEquity = this.extractNumber(indicators['Dív. líquida/PL']);
    result.netDebtToEbitda = this.extractNumber(indicators['Dív. líquida/EBITDA']);
    result.currentRatio = this.extractPercent(indicators['Liq. corrente']);
    result.assetTurnover = this.extractPercent(indicators['Giro ativos']);

    result.avgDailyLiquidity = this.extractNumber(indicators['Liquidez Média Diária']);

    // Setor
    const sectorEl = $('a[href*="/setores/"]').first();
    result.sector = sectorEl.text().trim() || '';
    result.ibovParticipation = this.parseNullablePercent(indicators['PART. IBOV']);

    // DY 12 meses (campo específico)
    const dy12El = $('[title="Dividend Yield com base nos últimos 12 meses"]');
    if (dy12El.length > 0) {
      const dy12Val = dy12El.closest('div').find('strong.value').first().text().trim();
      result.dy12m = this.extractPercent(dy12Val);
    }

    // Proventos
    result.dividendsHistory = await this.fetchDividendsHistory(t, 'stock');

    return result;
  }

  async fetchFII(ticker: string): Promise<ScrapedIndicators> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/fundos-imobiliarios/${t.toLowerCase()}`;
    await this.rateLimiter.acquire();
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const result: ScrapedIndicators = {
      ticker: t,
      name: $('h1.lh-4').first().text().trim() || $('.company-name').first().text().trim() || t,
      price: this.extractNumber($('.value').first().text()),
      dy: 0, pl: 0, pvp: 0, evEbitda: 0, evEbit: 0, pebit: 0, vpa: 0, lpa: 0, psr: 0, pegRatio: 0,
      ibovParticipation: null,
      roe: 0, roa: 0, roic: 0, grossMargin: 0, ebitdaMargin: 0, ebitMargin: 0, netMargin: 0,
      cagrRevenue5y: null, cagrEarnings5y: null,
      netDebtToEquity: 0, netDebtToEbitda: 0, currentRatio: 0,
      assetTurnover: 0, avgDailyLiquidity: 0, marketCap: null,
      dy12m: 0, dividendsHistory: [], sector: '',
    };

    // FIIs têm estrutura diferente - extrai indicadores via cards
    const indicators: Record<string, string> = {};

    // Busca por título h3.title + strong.value irmão
    $('.d-flex.justify-content-around .value').each((_, el) => {
      const container = $(el).closest('div');
      const title = container.find('h3.title, .sub-title').first().text().trim();
      const val = $(el).text().trim();
      if (title && val) indicators[title] = val;
    });

    // Também busca data-name
    $('[data-name]').each((_, el) => {
      const name = $(el).attr('data-name')!;
      const container = $(el).closest('.d-flex')?.parent() ?? $(el).parent();
      const val = container.find('strong.value').first().text().trim();
      if (val) indicators[name] = val;
    });

    result.pvp = this.extractNumber(indicators['P/VP']);
    result.avgDailyLiquidity = this.extractNumber(indicators['Liquidez Média Diária']);
    result.dy12m = this.extractPercent(indicators['Dividend Yield']);

    // DY de 12 meses
    const dy12El = $('[title="Dividend Yield com base nos últimos 12 meses"]');
    if (dy12El.length > 0 && result.dy12m === 0) {
      const dy12Val = dy12El.closest('div').find('strong.value').first().text().trim();
      result.dy12m = this.extractPercent(dy12Val);
    }

    // Sanity check
    if (result.dy12m > 100) {
      console.warn(`[scraper] DY ignorado para ${t}: ${result.dy12m}% (erro de parse)`);
      result.dy12m = 0;
    }

    result.dividendsHistory = await this.fetchDividendsHistory(t, 'fii');
    return result;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    return withRetry(async () => {
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.randomUA(),
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      });
      if (!response.ok) throw new Error(`StatusInvest HTTP ${response.status}`);
      return response.text();
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 15_000 });
  }

  private extractNumber(text: string | undefined): number {
    if (!text) return 0;
    const clean = text.trim().toUpperCase();
    let multiplier = 1;
    if (clean.endsWith('M')) multiplier = 1_000_000;
    else if (clean.endsWith('K')) multiplier = 1_000;
    else if (clean.endsWith('B')) multiplier = 1_000_000_000;
    const cleaned = clean.replace(/\./g, '').replace(/[^\d,-]/g, '').replace(',', '.');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : Math.abs(parsed) * multiplier;
  }

  private extractPercent(text: string | undefined): number {
    if (!text || text === '-') return 0;
    return this.extractNumber(text.replace('%', ''));
  }

  private parseNullablePercent(text: string | undefined): number | null {
    if (!text || text.trim() === '-' || text.trim() === '') return null;
    return this.extractPercent(text);
  }

  private async fetchDividendsHistory(
    ticker: string, assetType: 'stock' | 'fii',
  ): Promise<DividendEntry[]> {
    try {
      const endpoint = assetType === 'fii'
        ? `${this.baseUrl}/fii/companytickerprovents`
        : `${this.baseUrl}/acao/companytickerprovents`;
      const url = `${endpoint}?ticker=${ticker}&chartProventsType=2`;

      const resp = await fetch(url, { headers: { 'User-Agent': this.randomUA(), Accept: 'application/json' } });
      if (!resp.ok) return [];

      const raw = await resp.text();
      let data: unknown;
      try { data = JSON.parse(raw); } catch { return []; }

      // Formato antigo
      const old = data as { assetEarningsModels?: Array<{ et: string; pd?: string; ed?: string; v: number | string }> };
      if (old.assetEarningsModels?.length) {
        return old.assetEarningsModels
          .filter((i) => ['Rendimento','Dividendo','JCP','Amortização'].includes(i.et))
          .map((i) => ({
            date: (i.pd || i.ed || '').split('/').reverse().join('-'),
            value: typeof i.v === 'number' ? i.v : parseFloat(String(i.v).replace(',', '.') || '0'),
            type: i.et,
          })).filter((i) => i.date && i.value > 0);
      }

      // Formato novo: gera sintético dos anuais
      const nf = data as { earningsThisYear?: string; earningsLastYear?: string };
      if (nf.earningsThisYear || nf.earningsLastYear) {
        const thisY = parseFloat((nf.earningsThisYear || '0').replace(',', '.'));
        const lastY = parseFloat((nf.earningsLastYear || '0').replace(',', '.'));
        const monthly = (thisY || lastY) / 12;
        const events: DividendEntry[] = [];
        const now = new Date();
        for (let m = 0; m < 24; m++) {
          const d = new Date(now); d.setMonth(now.getMonth() - m); d.setDate(15);
          events.push({ date: d.toISOString().slice(0,10), value: Math.round(monthly*100)/100, type: assetType === 'fii' ? 'Rendimento' : 'DIVIDEND' });
        }
        return events;
      }
      return [];
    } catch { return []; }
  }
}

export const statusInvestScraper = new StatusInvestScraper();
