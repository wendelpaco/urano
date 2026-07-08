/**
 * StatusInvest Scraper — Scraping de dados via Cheerio (parse de HTML).
 *
 * Portado do easy-invest. Usa fetch() + cheerio.load() para extrair
 * indicadores fundamentalistas, cotações e proventos do StatusInvest.
 *
 * NÃO abre navegador — é scraping de HTML estático, leve e rápido.
 */

import * as cheerio from 'cheerio';
import { withRetry } from '../../shared/retry.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface ScrapedStock {
  ticker: string;
  name: string;
  price: number;
  dy: number;
  pl: number;
  pvp: number;
  roe: number;
  sector: string;
  avgDailyLiquidity: number;
  dividendsHistory: DividendEntry[];
}

export interface ScrapedFII {
  ticker: string;
  name: string;
  price: number;
  dy: number;
  pvp: number;
  vacancy?: number;
  category: 'papel' | 'tijolo' | 'hibrido';
  avgDailyLiquidity: number;
  dividendsHistory: DividendEntry[];
}

export interface DividendEntry {
  date: string;
  value: number;
  type: string;
}

// ─── Rate Limiter simples ────────────────────────────────────────────────────

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

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((r) => setTimeout(r, waitMs));
    this.tokens = 0;
    this.lastRefill = Date.now();
  }
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

export class StatusInvestScraper {
  private readonly baseUrl = 'https://statusinvest.com.br';
  private readonly rateLimiter = new TokenBucket(1.5); // 1.5 req/s

  private randomUA(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] ?? USER_AGENTS[0]!;
  }

  // ─── Ações ────────────────────────────────────────────────────────────

  async fetchStock(ticker: string): Promise<ScrapedStock> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/acoes/${t.toLowerCase()}`;

    await this.rateLimiter.acquire();
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const name =
      $('h1.lh-4').first().text().trim() || $('.company-name').first().text().trim() || t;

    const price = this.extractNumber($('.value').first().text());

    const dy = this.extractIndicator($, 'DY', 'Dividend Yield', 'D. Yield');
    const pl = this.extractIndicator($, 'P/L', 'Preço sobre Lucro');
    const pvp = this.extractIndicator($, 'P/VP', 'Preço sobre Valor Patrimonial');
    const roe = this.extractIndicator($, 'ROE', 'Return on Equity');

    // Setor
    let sector = '';
    const sectorLink = $('a[href*="/setores/"]').first().text().trim();
    if (sectorLink) sector = sectorLink;

    $('strong, span, div').each((_, el) => {
      if ($(el).text().trim() === 'Setor' || $(el).text().trim() === 'Setor de Atuação') {
        const val = $(el).next().text().trim() || $(el).parent().next().text().trim();
        if (val && val !== '--') sector = val;
        return false;
      }
    });

    const liquidity = this.extractIndicator($, 'Liquidez Média Diária', 'Vol. Médio (2m)');
    const dividendsHistory = await this.fetchDividendsHistory(t, 'stock');

    return { ticker: t, name, price, dy, pl, pvp, roe, sector: sector || 'Não classificado', avgDailyLiquidity: liquidity, dividendsHistory };
  }

  // ─── FIIs ─────────────────────────────────────────────────────────────

  async fetchFII(ticker: string): Promise<ScrapedFII> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/fundos-imobiliarios/${t.toLowerCase()}`;

    await this.rateLimiter.acquire();
    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const name =
      $('h1.lh-4').first().text().trim() || $('.company-name').first().text().trim() || t;

    const price = this.extractNumber($('.value').first().text());

    // DY de 12 meses
    let dy = 0;
    const dyEl = $('[title="Dividend Yield com base nos últimos 12 meses"]');
    if (dyEl.length > 0) {
      const val = dyEl.find('.value, strong.value').first().text().trim();
      if (val && val !== '--') dy = this.extractPercentage(val);
    }
    if (dy === 0) {
      dy = this.extractIndicator($, 'DY', 'Dividend Yield');
    }

    // Sanity check: DY > 100% é erro de parse (pegou valor total em vez de percentual)
    if (dy > 100) {
      console.warn(`[scraper] DY ignorado para ${t}: ${dy}% (erro de parse)`);
      dy = 0;
    }

    const pvp = this.extractIndicator($, 'P/VP', 'Preço sobre Valor Patrimonial');

    // Vacância
    const rawVacancy = this.extractIndicator($, 'Vacância', 'Vacancy');
    const vacancy = rawVacancy > 0 ? rawVacancy : undefined;

    // Categoria
    const category = this.determineFIICategory(name);

    const liquidity = this.extractIndicator($, 'Liquidez Média Diária', 'Liquidez Diária', 'Vol. Médio (2m)');

    const dividendsHistory = await this.fetchDividendsHistory(t, 'fii');

    return { ticker: t, name, price, dy, pvp, vacancy, category, avgDailyLiquidity: liquidity, dividendsHistory };
  }

  // ─── Proventos via JSON API ───────────────────────────────────────────

  private async fetchDividendsHistory(
    ticker: string,
    assetType: 'stock' | 'fii',
  ): Promise<DividendEntry[]> {
    try {
      const endpoint =
        assetType === 'fii'
          ? `${this.baseUrl}/fii/companytickerprovents`
          : `${this.baseUrl}/acao/companytickerprovents`;

      const url = `${endpoint}?ticker=${ticker}&chartProventsType=2`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.randomUA(),
          Accept: 'application/json',
        },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as {
        assetEarningsModels?: Array<{
          et: string;   // "Rendimento" | "Dividendo" | "JCP" | "Amortização"
          pd?: string;  // data de pagamento
          ed?: string;  // data COM
          v: number | string;
        }>;
      };

      if (!data.assetEarningsModels || !Array.isArray(data.assetEarningsModels)) {
        return [];
      }

      return data.assetEarningsModels
        .filter((item) =>
          item.et === 'Rendimento' ||
          item.et === 'Dividendo' ||
          item.et === 'JCP' ||
          item.et === 'Amortização',
        )
        .map((item) => ({
          date: (item.pd || item.ed || '').slice(0, 10),
          value: typeof item.v === 'number' ? item.v : parseFloat(String(item.v).replace(',', '.') || '0'),
          type: item.et,
        }))
        .filter((item) => item.date && item.value > 0);
    } catch {
      return [];
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': this.randomUA(),
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          },
        });

        if (!response.ok) {
          throw new Error(`StatusInvest HTTP ${response.status} para ${url}`);
        }

        return response.text();
      },
      { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 15_000 },
    );
  }

  private extractNumber(text: string | undefined): number {
    if (!text) return 0;
    const clean = text.trim().toUpperCase();

    let multiplier = 1;
    if (clean.endsWith('M')) multiplier = 1_000_000;
    else if (clean.endsWith('K')) multiplier = 1_000;
    else if (clean.endsWith('B')) multiplier = 1_000_000_000;

    const withoutThousands = clean.replace(/\./g, '');
    const cleaned = withoutThousands.replace(/[^\d,-]/g, '');
    const normalized = cleaned.replace(',', '.');
    const parsed = parseFloat(normalized);

    return isNaN(parsed) ? 0 : Math.abs(parsed) * multiplier;
  }

  private extractPercentage(text: string | undefined): number {
    if (!text) return 0;
    return this.extractNumber(text.replace('%', ''));
  }

  private extractIndicator($: cheerio.CheerioAPI, ...labels: string[]): number {
    for (const label of labels) {
      // Tenta encontrar o strong/title com o label e pegar o valor associado
      const selectors = [
        `strong:contains("${label}")`,
        `.title:contains("${label}")`,
        `[title*="${label}"]`,
      ];

      for (const sel of selectors) {
        const el = $(sel).first();
        if (el.length === 0) continue;

        const valueText =
          el.next().text() ||
          el.parent().find('.value').first().text() ||
          el.siblings('.value').first().text();

        if (valueText) {
          const value = label.includes('Y') || label.includes('%')
            ? this.extractPercentage(valueText)
            : this.extractNumber(valueText);
          if (value !== 0) return value;
        }
      }
    }
    return 0;
  }

  private determineFIICategory(name: string): 'papel' | 'tijolo' | 'hibrido' {
    const n = name.toLowerCase();

    if (n.includes('logística') || n.includes('logistic') || n.includes('galpão') ||
        n.includes('galpao') || n.includes('industrial')) return 'tijolo';
    if (n.includes('laje') || n.includes('corporativ') || n.includes('escritório') ||
        n.includes('escritorio')) return 'tijolo';
    if (n.includes('shopping') || n.includes('mall')) return 'tijolo';
    if (n.includes('receb') || n.includes('renda') || n.includes('yield') ||
        n.includes('cri')) return 'papel';
    if (n.includes('híbrido') || n.includes('hibrido')) return 'hibrido';

    return 'tijolo'; // default conservador
  }
}

export const statusInvestScraper = new StatusInvestScraper();
