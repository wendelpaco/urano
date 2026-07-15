/**
 * Fundamentus Scraper — Fonte complementar de fundamentos.
 *
 * Extrai indicadores detalhados do site fundamentus.com.br,
 * referência clássica para análise fundamentalista no Brasil.
 *
 * Dados disponíveis (mais granulares que StatusInvest):
 *  - Valuation: P/L, P/VP, P/EBIT, P/SR, EV/EBITDA, EV/EBIT
 *  - Rentabilidade: ROE, ROIC, ROA, margens (bruta, EBIT, líquida)
 *  - Crescimento: CAGR receita/lucro 5 anos
 *  - Endividamento: dívida bruta/PL, dívida líquida/EBIT
 *  - Balanço: ativo total, disponibilidade, patrimônio líquido
 *  - Mercado: valor de mercado, liquidez diária, free float
 *
 * Rate limit: 2 req/s (site é mais tolerante que StatusInvest).
 * Cache Redis: 6h (dados fundamentalistas mudam pouco intraday).
 */

import * as cheerio from 'cheerio';
import { withRetry, RateLimitError } from '../../../shared/retry.ts';
import { fundamentusLimiter } from '../rate-limiter.ts';
import { redis } from '../redis.ts';
import { userAgentPool } from '../user-agent-pool.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface FundamentusData {
  ticker: string;
  name: string;
  price: number;
  // Valuation
  pl: number;           // P/L (preço/lucro)
  pvp: number;          // P/VP (preço/valor patrimonial)
  pebit: number;        // P/EBIT
  psr: number;          // P/SR (preço/receita líquida)
  evEbitda: number;     // EV/EBITDA
  evEbit: number;       // EV/EBIT
  vpa: number;          // Valor patrimonial por ação
  lpa: number;          // Lucro por ação
  // Rentabilidade
  roe: number;          // % Retorno sobre patrimônio
  roic: number;         // % Retorno sobre capital investido
  roa: number;          // % Retorno sobre ativo
  grossMargin: number;  // % Margem bruta
  ebitMargin: number;   // % Margem EBIT
  netMargin: number;    // % Margem líquida
  // Crescimento
  cagrRevenue5y: number | null;
  cagrEarnings5y: number | null;
  // Endividamento
  grossDebtToEquity: number;   // Dívida bruta / PL
  netDebtToEbitda: number;     // Dívida líquida / EBITDA
  netDebtToEquity: number;     // Dívida líquida / PL
  // Balanço
  totalAssets: number;         // Ativo total (R$)
  currentAssets: number;       // Ativo circulante
  cashAndEquivalents: number;  // Disponibilidade
  equity: number;              // Patrimônio líquido
  // Mercado
  marketCap: number;           // Valor de mercado
  enterpriseValue: number;     // EV
  avgDailyLiquidity: number;   // Liquidez média diária
  freeFloat: number | null;    // % Free float
  sharesOutstanding: number;   // Total de ações
  // Dividendos
  dy: number;                  // % Dividend yield
  payout: number | null;       // % Payout
  // Setor
  sector: string;
  subsector: string;
  // Metadata
  extractedAt: string;
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

export class FundamentusScraper {
  private readonly baseUrl = 'https://www.fundamentus.com.br';

  async fetchStock(ticker: string): Promise<FundamentusData> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/detalhes.php?papel=${t}`;

    // Rate limit centralizado
    await fundamentusLimiter.acquire();

    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    // Extrai todas as tabelas da página
    const indicators = this.extractIndicators($);
    const price = this.extractPrice($);
    const name = this.extractName($);

    return {
      ticker: t,
      name,
      price,
      pl: this.num(indicators['P/L']),
      pvp: this.num(indicators['P/VP']),
      pebit: this.num(indicators['P/EBIT']),
      psr: this.num(indicators['PSR']),
      evEbitda: this.num(indicators['EV/EBITD*A']),
      evEbit: this.num(indicators['EV/EBIT']),
      vpa: this.num(indicators['VPA']),
      lpa: this.num(indicators['LPA']),
      roe: this.pct(indicators['ROE']),
      roic: this.pct(indicators['ROIC']),
      roa: this.pct(indicators['ROA']),
      grossMargin: this.pct(indicators['Marg. Bruta']),
      ebitMargin: this.pct(indicators['Marg. EBIT']),
      netMargin: this.pct(indicators['Marg. Líquida']),
      cagrRevenue5y: this.parseNullablePct(indicators['Cresc. Rec.5a']),
      cagrEarnings5y: this.parseNullablePct(indicators['Cresc. Luc.5a']),
      grossDebtToEquity: this.num(indicators['Dív.Bruta / PL']),
      netDebtToEbitda: this.num(indicators['Dív.Líquida / EBIT']),
      netDebtToEquity: this.num(indicators['Dív.Líquida / PL']),
      totalAssets: this.num(indicators['Ativo']),
      currentAssets: this.num(indicators['Ativo Circ.']),
      cashAndEquivalents: this.num(indicators['Disponib.']),
      equity: this.num(indicators['Patrim. Líq.']),
      marketCap: this.num(indicators['Valor Mercado']),
      enterpriseValue: this.num(indicators['Valor Firma']),
      avgDailyLiquidity: this.num(indicators['Liq.2m.']),
      freeFloat: this.parseNullablePct(indicators['Free Float']),
      sharesOutstanding: this.num(indicators['Ações']),
      dy: this.pct(indicators['Div.Yield']),
      payout: this.parseNullablePct(indicators['Payout']),
      sector: $('a[href*="setor"]').first().text().trim() || '',
      subsector: $('a[href*="subsetor"]').first().text().trim() || '',
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Busca dados com cache Redis (6h).
   */
  async fetchWithCache(ticker: string): Promise<FundamentusData | null> {
    const cacheKey = `fundamentus:${ticker.toUpperCase()}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as FundamentusData;
    } catch { /* ok */ }

    try {
      const data = await this.fetchStock(ticker);

      // Cache 6h
      await redis.setex(cacheKey, 21_600, JSON.stringify(data)).catch(() => {});

      return data;
    } catch (err) {
      console.warn(`[fundamentus] ❌ ${ticker}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Extração HTML ────────────────────────────────────────────────────

  /**
   * Extrai todos os indicadores das tabelas da página.
   * Fundamentus usa uma estrutura de tabelas com labels e valores.
   */
  private extractIndicators($: cheerio.CheerioAPI): Record<string, string> {
    const result: Record<string, string> = {};

    // Método 1: spans com classe "txt" (label) + spans com classe "dado" (valor)
    $('span.txt').each((_, el) => {
      const label = $(el).text().trim();
      if (!label) return;

      // O valor está no próximo span.dado (irmão ou próximo no DOM)
      const parent = $(el).parent();
      const valueEl = parent.find('span.dado').first();
      const value = valueEl.text().trim();
      if (value) result[label] = value;
    });

    // Método 2: tabelas com td (label) + td (valor)
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim();
        const value = $(cells[1]).text().trim();
        if (label && value && !result[label]) {
          result[label] = value;
        }
      }
    });

    return result;
  }

  private extractPrice($: cheerio.CheerioAPI): number {
    // Preço está em um span com classe "dado" dentro da tabela de cotação
    const priceText = $('span.dado:contains(","), span.dado')
      .filter((_, el) => $(el).text().includes(','))
      .first()
      .text()
      .trim();

    if (priceText) {
      return this.num(priceText);
    }

    // Fallback: busca qualquer valor que pareça preço (formato XX,XX)
    const body = $('body').text();
    const match = body.match(/[Cc]ota[çc][aã]o[:\s]*R?\$?\s*(\d+[,.]?\d*)/);
    if (match) return this.num(match[1]!);

    return 0;
  }

  private extractName($: cheerio.CheerioAPI): string {
    // Nome da empresa no título ou header
    const title = $('h2, h1, .titulo').first().text().trim();
    if (title) return title;

    // Fallback: primeiro span.txt que contém nome da empresa
    const nameSpan = $('span.txt').filter((_, el) => {
      const text = $(el).text().toUpperCase();
      return text.includes('S.A.') || text.includes('S/A') || text.includes('LTDA');
    }).first().text().trim();

    return nameSpan || '';
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    return withRetry(async () => {
      const headers = userAgentPool.getFingerprint(this.baseUrl) as unknown as Record<string, string>;
      const response = await fetch(url, { headers });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError(
          `Fundamentus HTTP 429`,
          (retryAfter ? parseInt(retryAfter, 10) : 5) * 1000,
        );
      }

      if (!response.ok) {
        throw new Error(`Fundamentus HTTP ${response.status}`);
      }

      return response.text();
    }, {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 30_000,
      timeout: 15_000,
    });
  }

  // ─── Helpers Numéricos ─────────────────────────────────────────────────

  private num(text: string | undefined): number {
    if (!text || text === '-' || text === '') return 0;
    // Fundamentus usa formato: "1.234,56" ou "12,34%" ou "1.234.567.890"
    let clean = text.replace(/%/g, '').trim();

    // Detecta se é negativo
    const isNegative = clean.startsWith('-');
    clean = clean.replace(/-/g, '');

    // Remove pontos de milhar e substitui vírgula por ponto
    // Ex: "1.234,56" → "1234.56"
    if (clean.includes(',') && clean.includes('.')) {
      // Formato brasileiro com separador de milhar
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (clean.includes(',')) {
      clean = clean.replace(',', '.');
    }

    const parsed = parseFloat(clean);
    if (isNaN(parsed)) return 0;
    return isNegative ? -parsed : parsed;
  }

  private pct(text: string | undefined): number {
    if (!text || text === '-' || text === '') return 0;
    // Já extrai o número, incluindo o sinal de %
    return this.num(text.replace('%', ''));
  }

  private parseNullablePct(text: string | undefined): number | null {
    if (!text || text.trim() === '-' || text.trim() === '') return null;
    return this.pct(text);
  }
}

export const fundamentusScraper = new FundamentusScraper();
