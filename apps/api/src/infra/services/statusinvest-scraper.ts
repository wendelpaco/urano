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

import { withRetry, RateLimitError } from '../../shared/retry.ts';
import { statusInvestLimiter } from './rate-limiter.ts';
import { statusInvestCircuitBreaker } from './circuit-breaker.ts';
import { userAgentPool } from './user-agent-pool.ts';
import { redis } from './redis.ts';
import {
  parseStatusInvestHtml,
  parseStatusInvestFiiHtml,
  type ScrapedIndicators,
  type FiisData,
  type DividendEntry,
} from './scrapers/statusinvest-parse.ts';

// Re-export types for existing consumers
export type { ScrapedIndicators, FiisData, DividendEntry };

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
    const result = parseStatusInvestHtml(html, t);
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
    const parsed = parseStatusInvestFiiHtml(html, t);

    // Dividendos (JSON API com cache)
    const divData = await this.fetchFIIDividendsData(t);

    return {
      ...parsed,
      dy12m: parsed.dy12m || divData.rendiment,
      dividendsHistory: divData.history,
      earningsThisYear: divData.earningsThisYear,
      earningsLastYear: divData.earningsLastYear,
      provisionedThisYear: divData.provisionedThisYear,
    };
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
      // SSRF-3r: StatusInvest JSON API não deve redirecionar
      const r = await fetch(url, {
        headers: this.getHeaders(this.baseUrl + '/'),
        redirect: 'error',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      // SSRF-1: limita leitura a 512 KiB para JSON de dividendos
      const text = await r.text();
      if (text.length > 512 * 1024) throw new Error('Resposta de dividendos muito grande');
      const data = JSON.parse(text) as {
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
        redirect: 'error',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const rawText = await r.text();
      if (rawText.length > 512 * 1024) throw new Error('Resposta de dividendos FII muito grande');
      const data = JSON.parse(rawText) as {
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
        redirect: 'error',
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

      // PIPE-3: formato novo — gera sintético dos anuais com marcação explícita.
      // Eventos fabricados não têm cadência mensal real; o score deve tratar
      // cobertura via IMP-3r em vez de fingir 12/12 meses.
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
            type: 'SINTETICO_ANUAL',
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
    // Circuit breaker: rejeita cedo se StatusInvest está em cooldown (evita spam de 429)
    await statusInvestCircuitBreaker.beforeRequest();

    // Rate limit serializado (1 token; fila global entre scrapers/warmup/dividends)
    await statusInvestLimiter.acquire();

    try {
      // maxRetries baixo: retentar 429 em massa piora o ban. Preferir fallback Yahoo.
      const html = await withRetry(async () => {
        const headers = this.getHeaders(this.baseUrl + '/');
        // SSRF-3r: não segue redirects — endpoint do SI não deve redirecionar
        const response = await fetch(url, { headers, redirect: 'error' });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const retrySec = retryAfter ? parseInt(retryAfter, 10) || 15 : 15;
          const retryMs = retrySec * 1000;
          // Pausa o bucket global — outras corrotinas também esperam
          statusInvestLimiter.penalize(retryMs);
          throw new RateLimitError(
            `StatusInvest HTTP 429 (Retry-After: ${retrySec}s)`,
            retryMs,
          );
        }

        if (!response.ok) {
          throw new Error(`StatusInvest HTTP ${response.status}`);
        }

        return response.text();
      }, {
        maxRetries: 1,
        initialDelay: 2000,
        maxDelay: 20_000,
        timeout: 15_000,
      });

      await statusInvestCircuitBreaker.onSuccess();
      return html;
    } catch (error) {
      if (error instanceof RateLimitError) {
        await statusInvestCircuitBreaker.onFailure('rate-limit', error.message);
      } else if (error instanceof Error && error.message.includes('HTTP 5')) {
        await statusInvestCircuitBreaker.onFailure('server-error', error.message);
      }
      // 404 / client-error não contam no circuit (não é outage da fonte)
      throw error;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const statusInvestScraper = new StatusInvestScraper();
