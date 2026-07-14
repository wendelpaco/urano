/**
 * StatusInvest FII Scraper — Extração completa de dados de FIIs.
 *
 * Coleta via Cheerio (HTML) + JSON API:
 * - Valuation: P/VP, preço, DY 12m, valor patrimonial
 * - Rentabilidade: DY CAGR 3a, valor CAGR 3a, rendimento médio 24m
 * - Risco: volatilidade, min/max 52s, nº cotistas
 * - Dividendos: histórico completo (JSON API)
 * - Mercado: liquidez, valor em caixa, IFIX
 */

import * as cheerio from 'cheerio';
import { withRetry } from '../../shared/retry.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

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
  date: string;    // YYYY-MM-DD
  value: number;   // R$/cota
  type: string;    // Rendimento, Amortização, etc.
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number; private lastRefill: number; private refillRate: number;
  constructor(rate: number) {
    this.tokens = rate; this.lastRefill = Date.now(); this.refillRate = rate / 1000;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    this.tokens = Math.min(2, this.tokens + (now - this.lastRefill) * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return; }
    await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) / this.refillRate)));
    this.tokens = 0; this.lastRefill = Date.now();
  }
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class FiisScraper {
  private readonly baseUrl = 'https://statusinvest.com.br';
  private readonly rateLimiter = new TokenBucket(1.5);

  async fetchFII(ticker: string): Promise<FiisData> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/fundos-imobiliarios/${t.toLowerCase()}`;

    await this.rateLimiter.acquire();
    const html = await withRetry(async () => {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 15_000 });

    const $ = cheerio.load(html);

    // ── Dados básicos ──────────────────────────────────────────────────
    const name = $('h1.lh-4, .company-name').first().text().trim() || t;
    const price = this.extractNumber($('.value').first().text());

    // ── Indicadores via cards ──────────────────────────────────────────
    const indicators = this.extractAllIndicators($);

    // ── Dividendos (JSON API + parse HTML) ─────────────────────────────
    const divData = await this.fetchDividendsData(t);

    // ── Categoria ──────────────────────────────────────────────────────
    const category = this.determineCategory(name);

    return {
      ticker: t,
      name,
      price,
      dy12m: this.extractPercent(indicators['Dividend Yield']) || divData.rendiment,
      pvp: this.extractNumber(indicators['P/VP']),
      bookValue: this.extractNumber(indicators['Val. patrimonial p/cota']),
      min52w: this.extractNumber(indicators['Min. 52 semanas']),
      max52w: this.extractNumber(indicators['Máx. 52 semanas']),
      valorization12m: this.extractPercent(indicators['Valorização (12m)']),
      volatility: this.extractPercent(indicators['Volatilidade']),
      dyCagr3y: this.extractNullablePercent(indicators['DY CAGR (3 anos)']),
      valueCagr3y: this.extractNullablePercent(indicators['Valor CAGR (3 anos)']),
      avgMonthlyIncome24m: this.extractNumber(indicators['RENDIMENTO MENSAL MÉDIO (24M)']),
      numShareholders: parseInt(indicators['Nº de Cotistas']?.replace(/\D/g, '') || '0'),
      cashValue: this.extractNumber(indicators['Valor em caixa']),
      ifixParticipation: this.extractNullablePercent(indicators['PARTICIPAÇÃO NO IFIX']),
      category,
      dividendsHistory: divData.history,
      earningsThisYear: divData.earningsThisYear,
      earningsLastYear: divData.earningsLastYear,
      provisionedThisYear: divData.provisionedThisYear,
    };
  }

  /**
   * Extrai todos os indicadores dos cards da página de FII.
   * A página usa estrutura: <h3 class="title">Nome</h3> ... <strong class="value">VALOR</strong>
   */
  private extractAllIndicators($: cheerio.CheerioAPI): Record<string, string> {
    const result: Record<string, string> = {};

    // Método 1: cards com sub-title / value
    $('.sub-title').each((_, el) => {
      const key = $(el).text().trim();
      const container = $(el).parent();
      const val = container.find('.sub-value, strong.value, .value').first().text().trim();
      if (key && val) result[key] = val;
    });

    // Método 2: títulos h3 + next value
    $('h3.title').each((_, el) => {
      const key = $(el).clone().children().remove().end().text().trim();
      if (!key || result[key]) return;
      // Procura o valor no container pai
      const container = $(el).closest('div');
      const val = container.find('strong.value, .value').first().text().trim();
      if (val && val !== '--') result[key] = val;
    });

    // Método 3: data-name (se existir)
    $('[data-name]').each((_, el) => {
      const key = $(el).attr('data-name')!;
      const val = $(el).closest('div').find('strong.value').first().text().trim();
      if (val) result[key] = val;
    });

    return result;
  }

  /**
   * Busca dividendos via JSON API + parse dos cards da página.
   */
  private async fetchDividendsData(ticker: string): Promise<{
    history: DividendEntry[];
    earningsThisYear: number;
    earningsLastYear: number;
    provisionedThisYear: number;
    rendiment: number;
  }> {
    try {
      const url = `${this.baseUrl}/fii/companytickerprovents?ticker=${ticker}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const data = await r.json() as {
        earningsThisYear?: string;
        earningsLastYear?: string;
        provisionedThisYear?: string;
        rendiment?: string;
        assetEarningsModels?: Array<{
          ed?: string; pd?: string; et?: string; v: number | string; sv?: string;
        }>;
      };

      const history: DividendEntry[] = [];
      if (data.assetEarningsModels?.length) {
        for (const item of data.assetEarningsModels) {
          const date = (item.pd || item.ed || '');
          const value = typeof item.v === 'number' ? item.v : parseFloat(String(item.v || '0').replace(',', '.'));
          if (date && value > 0) {
            history.push({
              date: date.split('/').reverse().join('-'),
              value,
              type: item.et || 'Rendimento',
            });
          }
        }
      }

      return {
        history,
        earningsThisYear: parseFloat((data.earningsThisYear || '0').replace(',', '.')),
        earningsLastYear: parseFloat((data.earningsLastYear || '0').replace(',', '.')),
        provisionedThisYear: parseFloat((data.provisionedThisYear || '0').replace(',', '.')),
        rendiment: parseFloat((data.rendiment || '0').replace(',', '.')),
      };
    } catch {
      return { history: [], earningsThisYear: 0, earningsLastYear: 0, provisionedThisYear: 0, rendiment: 0 };
    }
  }

  private determineCategory(name: string): 'papel' | 'tijolo' | 'hibrido' {
    const n = name.toLowerCase();
    if (n.includes('logística') || n.includes('logistic') || n.includes('galpão') ||
        n.includes('shopping') || n.includes('mall') || n.includes('laje') ||
        n.includes('corporativ') || n.includes('industrial') || n.includes('imobiliári') ||
        n.includes('imobiliario') || n.includes('agro')) return 'tijolo';
    if (n.includes('receb') || n.includes('renda') || n.includes('yield') ||
        n.includes('cri') || n.includes('papel') || n.includes('crédito') ||
        n.includes('credito')) return 'papel';
    if (n.includes('híbrido') || n.includes('hibrido') || n.includes('fundo de fundos')) return 'hibrido';
    return 'tijolo';
  }

  // ─── Helpers numéricos ───────────────────────────────────────────────

  private extractNumber(text: string | undefined): number {
    if (!text) return 0;
    const clean = text.trim().toUpperCase();
    let mul = 1;
    if (clean.endsWith('M')) mul = 1_000_000;
    else if (clean.endsWith('K')) mul = 1_000;
    else if (clean.endsWith('B')) mul = 1_000_000_000;
    const n = clean.replace(/\./g, '').replace(/[^\d,-]/g, '').replace(',', '.');
    const p = parseFloat(n);
    return isNaN(p) ? 0 : Math.abs(p) * mul;
  }

  private extractPercent(text: string | undefined): number {
    if (!text) return 0;
    return this.extractNumber(text.replace('%', ''));
  }

  private extractNullablePercent(text: string | undefined): number | null {
    if (!text || text.trim() === '-' || text.trim() === '') return null;
    return this.extractPercent(text);
  }
}

export const fiisScraper = new FiisScraper();
