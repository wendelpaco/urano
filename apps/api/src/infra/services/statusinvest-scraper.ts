/**
 * StatusInvest Scraper V4 — Scraper UNIFICADO para Ações e FIIs.
 *
 * Centraliza TODO o scraping do StatusInvest em um único serviço.
 * Rate limit compartilhado via TokenBucket centralizado.
 * Circuit breaker protege contra rajadas de 429.
 *
 * Extrai:
 *  - Ações: valuation, rentabilidade, crescimento, endividamento, dividendos
 *  - FIIs: P/VP, DY, valor patrimonial, volatilidade, CAGR, imóveis, inquilinos
 *
 * Cache Redis:
 *  - Dividendos: 24h
 *  - FII completo: 24h (usado pela API)
 */

import * as cheerio from 'cheerio';
import { withRetry, RateLimitError } from '../../shared/retry.ts';
import { statusInvestLimiter } from './rate-limiter.ts';
import { statusInvestCircuitBreaker } from './circuit-breaker.ts';
import { userAgentPool, type RequestFingerprint } from './user-agent-pool.ts';
import { getOrSet, redis } from './redis.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

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

// ─── Scraper Unificado ───────────────────────────────────────────────────────

export class StatusInvestScraper {
  private readonly baseUrl = 'https://statusinvest.com.br';

  /** Obtém headers HTTP rotacionados via User-Agent Pool */
  private getHeaders(referer?: string): Record<string, string> {
    const fp = userAgentPool.getFingerprint(referer);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(fp)) {
      if (value !== undefined) {
        headers[key] = value;
      }
    }
    return headers;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AÇÕES
  // ═══════════════════════════════════════════════════════════════════════

  async fetchStock(ticker: string): Promise<ScrapedIndicators> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/acoes/${t.toLowerCase()}`;

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

    result.cagrRevenue5y = this.extractNullablePercent(indicators['CAGR Receitas 5 anos']);
    result.cagrEarnings5y = this.extractNullablePercent(indicators['CAGR Lucros 5 anos']);

    result.netDebtToEquity = this.extractNumber(indicators['Dív. líquida/PL']);
    result.netDebtToEbitda = this.extractNumber(indicators['Dív. líquida/EBITDA']);
    result.currentRatio = this.extractPercent(indicators['Liq. corrente']);
    result.assetTurnover = this.extractPercent(indicators['Giro ativos']);

    result.avgDailyLiquidity = this.extractNumber(indicators['Liquidez Média Diária']);

    const sectorEl = $('a[href*="/setores/"]').first();
    result.sector = sectorEl.text().trim() || '';
    result.ibovParticipation = this.extractNullablePercent(indicators['PART. IBOV']);

    const dy12El = $('[title="Dividend Yield com base nos últimos 12 meses"]');
    if (dy12El.length > 0) {
      const dy12Val = dy12El.closest('div').find('strong.value').first().text().trim();
      result.dy12m = this.extractPercent(dy12Val);
    }

    result.dividendsHistory = await this.fetchDividendsHistory(t, 'stock');
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FIIS
  // ═══════════════════════════════════════════════════════════════════════

  async fetchFII(ticker: string): Promise<FiisData> {
    const t = ticker.toUpperCase();
    const url = `${this.baseUrl}/fundos-imobiliarios/${t.toLowerCase()}`;

    const html = await this.fetchPage(url);
    const $ = cheerio.load(html);

    const name = $('h1.lh-4, .company-name').first().text().trim() || t;
    const price = this.extractNumber($('.value').first().text());

    // Extração completa de indicadores (método unificado para FIIs)
    const indicators = this.extractAllFIIndicators($);

    // Dividendos (JSON API com cache)
    const divData = await this.fetchFIIDividendsData(t);

    // Categoria
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
   * Usa 3 métodos complementares para capturar todos os dados.
   */
  private extractAllFIIndicators($: cheerio.CheerioAPI): Record<string, string> {
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

  // ═══════════════════════════════════════════════════════════════════════
  // DIVIDENDOS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Busca histórico de dividendos (ações) com cache Redis 24h.
   */
  private async fetchDividendsHistory(
    ticker: string,
    assetType: 'stock' | 'fii',
  ): Promise<DividendEntry[]> {
    const cacheKey = `dividends:${ticker.toUpperCase()}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as DividendEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch { /* Redis offline */ }

    // Busca da API
    const endpoint = assetType === 'fii'
      ? `${this.baseUrl}/fii/companytickerprovents`
      : `${this.baseUrl}/acao/companytickerprovents`;
    const url = `${endpoint}?ticker=${ticker}&chartProventsType=2`;

    const entries = await this.fetchDividendsFromApi(url, assetType);

    if (entries.length > 0) {
      try { await redis.setex(cacheKey, 86_400, JSON.stringify(entries)); } catch { /* ok */ }
    }

    return entries;
  }

  /**
   * Busca dividendos de FIIs (JSON API com cache Redis 24h).
   * Retorna histórico + totais anuais.
   */
  private async fetchFIIDividendsData(ticker: string): Promise<{
    history: DividendEntry[];
    earningsThisYear: number;
    earningsLastYear: number;
    provisionedThisYear: number;
    rendiment: number;
  }> {
    const cacheKey = `dividends:${ticker.toUpperCase()}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as DividendEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const totals = await this.fetchFIIDividendsTotals(ticker);
          return { history: parsed, ...totals };
        }
      }
    } catch { /* Redis offline */ }

    const data = await this.fetchFIIDividendsFromApi(ticker);

    if (data.history.length > 0) {
      try { await redis.setex(cacheKey, 86_400, JSON.stringify(data.history)); } catch { /* ok */ }
    }

    return data;
  }

  /** Busca apenas os totais anuais (cache miss). */
  private async fetchFIIDividendsTotals(ticker: string): Promise<{
    earningsThisYear: number;
    earningsLastYear: number;
    provisionedThisYear: number;
    rendiment: number;
  }> {
    try {
      const url = `${this.baseUrl}/fii/companytickerprovents?ticker=${ticker}`;
      const r = await fetch(url, {
        headers: this.getHeaders(this.baseUrl + '/'),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const data = await r.json() as {
        earningsThisYear?: string;
        earningsLastYear?: string;
        provisionedThisYear?: string;
        rendiment?: string;
      };

      return {
        earningsThisYear: parseFloat((data.earningsThisYear || '0').replace(',', '.')),
        earningsLastYear: parseFloat((data.earningsLastYear || '0').replace(',', '.')),
        provisionedThisYear: parseFloat((data.provisionedThisYear || '0').replace(',', '.')),
        rendiment: parseFloat((data.rendiment || '0').replace(',', '.')),
      };
    } catch {
      return { earningsThisYear: 0, earningsLastYear: 0, provisionedThisYear: 0, rendiment: 0 };
    }
  }

  /** Busca completa da JSON API de dividendos de FIIs. */
  private async fetchFIIDividendsFromApi(ticker: string): Promise<{
    history: DividendEntry[];
    earningsThisYear: number;
    earningsLastYear: number;
    provisionedThisYear: number;
    rendiment: number;
  }> {
    try {
      const url = `${this.baseUrl}/fii/companytickerprovents?ticker=${ticker}`;
      const r = await fetch(url, {
        headers: this.getHeaders(this.baseUrl + '/'),
      });
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
          const value = typeof item.v === 'number'
            ? item.v
            : parseFloat(String(item.v || '0').replace(',', '.'));
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

  /**
   * Busca dividendos da JSON API (ações e FIIs).
   */
  private async fetchDividendsFromApi(
    url: string,
    assetType: 'stock' | 'fii',
  ): Promise<DividendEntry[]> {
    try {
      const resp = await fetch(url, {
        headers: this.getHeaders(this.baseUrl + '/'),
      });

      if (!resp.ok) return [];

      const raw = await resp.text();
      let data: unknown;
      try { data = JSON.parse(raw); } catch { return []; }

      // Formato antigo (lista de proventos)
      const old = data as { assetEarningsModels?: Array<{ et: string; pd?: string; ed?: string; v: number | string }> };
      if (old.assetEarningsModels?.length) {
        return old.assetEarningsModels
          .filter((i) => ['Rendimento', 'Dividendo', 'JCP', 'Amortização'].includes(i.et))
          .map((i) => ({
            date: (i.pd || i.ed || '').split('/').reverse().join('-'),
            value: typeof i.v === 'number' ? i.v : parseFloat(String(i.v).replace(',', '.') || '0'),
            type: i.et,
          }))
          .filter((i) => i.date && i.value > 0);
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
          const d = new Date(now);
          d.setMonth(now.getMonth() - m);
          d.setDate(15);
          events.push({
            date: d.toISOString().slice(0, 10),
            value: Math.round(monthly * 100) / 100,
            type: assetType === 'fii' ? 'Rendimento' : 'DIVIDEND',
          });
        }
        return events;
      }
      return [];
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HTTP
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch de página HTML com:
   * - Rate limit centralizado (TokenBucket)
   * - Circuit breaker (abre após 5 falhas 429)
   * - Retry inteligente (3 tentativas, jitter, Retry-After)
   */
  private async fetchPage(url: string): Promise<string> {
    // Circuit breaker: verifica se o circuito está aberto
    await statusInvestCircuitBreaker.beforeRequest();

    // Rate limit: aguarda token disponível
    await statusInvestLimiter.acquire();

    try {
      const html = await withRetry(async () => {
        const headers = this.getHeaders(this.baseUrl + '/');
        const response = await fetch(url, { headers });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const retrySec = retryAfter ? parseInt(retryAfter, 10) || 5 : 5;
          throw new RateLimitError(
            `StatusInvest HTTP 429 (Retry-After: ${retrySec}s)`,
            retrySec * 1000,
          );
        }

        if (!response.ok) {
          throw new Error(`StatusInvest HTTP ${response.status}`);
        }

        return response.text();
      }, {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 30_000,
        timeout: 15_000,
      });

      // Sucesso: notifica circuit breaker
      await statusInvestCircuitBreaker.onSuccess();
      return html;
    } catch (error) {
      // Classifica o erro para o circuit breaker
      if (error instanceof RateLimitError) {
        await statusInvestCircuitBreaker.onFailure('rate-limit', error.message);
      } else if (error instanceof Error && error.message.includes('HTTP 5')) {
        await statusInvestCircuitBreaker.onFailure('server-error', error.message);
      } else {
        await statusInvestCircuitBreaker.onFailure('network-error', (error as Error).message);
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS NUMÉRICOS
  // ═══════════════════════════════════════════════════════════════════════

  private extractNumber(text: string | undefined): number {
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

  private extractPercent(text: string | undefined): number {
    if (!text || text === '-') return 0;
    return this.extractNumber(text.replace('%', ''));
  }

  private extractNullablePercent(text: string | undefined): number | null {
    if (!text || text.trim() === '-' || text.trim() === '') return null;
    return this.extractPercent(text);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLASSIFICAÇÃO DE FIIS
  // ═══════════════════════════════════════════════════════════════════════

  private determineCategory(name: string): 'papel' | 'tijolo' | 'hibrido' {
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
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const statusInvestScraper = new StatusInvestScraper();
