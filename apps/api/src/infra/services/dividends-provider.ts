/**
 * DividendsProvider — Fonte de proventos por cota via StatusInvest JSON API.
 *
 * Único pedaço do "scraper" que vale a pena: o endpoint retorna JSON, não HTML.
 * Cache Redis 24h (proventos mudam raramente), retry com backoff (Onda 1a),
 * e rate limiter interno (1 req/s) para não ser bloqueado.
 *
 * Fallback: se o endpoint falhar, retorna null → caller degrada com DMPL.
 */

import { getOrSet } from './redis.ts';
import { withRetry } from '../../shared/retry.ts';
import type { DividendEvent } from '../../core/services/dividends-analyzer.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface StatusInvestProvent {
  dataCom?: string;       // "2025-06-15"
  dataPagamento?: string;
  valor: string;          // "0.1023"
  tipo?: string;          // "Dividendo" | "JCP" | "Rendimento" | "Amortização"
  assetType?: number;     // 1 = ação, 2 = FII
}

type StatusInvestResponse = Array<{
  dataCom: string;
  valor: string;
  tipo: string;
  assetType?: number;
}>;

// ─── Rate Limiter (token bucket) ────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens por ms

  constructor(ratePerSecond: number) {
    this.maxTokens = ratePerSecond;
    this.tokens = ratePerSecond;
    this.lastRefill = Date.now();
    this.refillRate = ratePerSecond / 1000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Aguarda até ter token disponível
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((r) => setTimeout(r, waitMs));
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class DividendsProvider {
  private readonly baseUrl = 'https://statusinvest.com.br';
  private readonly rateLimiter = new TokenBucket(1); // 1 req/s

  /**
   * Busca proventos mensais de um ticker (ação ou FII).
   *
   * @param ticker Ticker B3 (ex: PETR4, KNCR11)
   * @returns DividendEvent[] ou null se indisponível
   */
  async fetchDividends(ticker: string): Promise<DividendEvent[] | null> {
    const cacheKey = `dividends:${ticker.toUpperCase()}`;

    try {
      return await getOrSet(cacheKey, 86_400, () =>
        withRetry(() => this.doFetch(ticker), {
          maxRetries: 1,
          initialDelay: 500,
          maxDelay: 2000,
          timeout: 15_000,
        }),
      );
    } catch {
      // Degradação: retorna null, caller usa fallback DMPL
      console.warn(`[DividendsProvider] Indisponível para ${ticker}, retornando null`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private async doFetch(ticker: string): Promise<DividendEvent[] | null> {
    const upper = ticker.toUpperCase();

    // Detecta se é FII (4 letras + 11) ou ação (4 letras + número 3-11)
    const isFii = /^[A-Z]{4}11$/.test(upper);
    const path = isFii
      ? `/fii/companytickerprovents`
      : `/acao/companytickerprovents`;

    const params = isFii
      ? `?ticker=${upper}`
      : `?ticker=${upper}&chartProventsType=2`;

    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}${path}${params}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Urano-FinBot/0.1',
        Accept: 'application/json',
        Referer: `${this.baseUrl}/${isFii ? 'fundos-imobiliarios' : 'acoes'}/${upper}`,
      },
    });

    if (!response.ok) {
      throw new Error(`StatusInvest HTTP ${response.status} para ${ticker}`);
    }

    const text = await response.text();
    if (!text || text.trim() === '[]' || text.trim() === 'null') {
      return []; // Ticker sem proventos registrados
    }

    const parsed = JSON.parse(text) as
      | StatusInvestResponse
      | { assetEarningsModels?: StatusInvestResponse }
      | { error?: string };

    // Formato 1: array direto (ações via chartProventsType=2)
    if (Array.isArray(parsed)) {
      return this.mapToEvents(parsed, upper);
    }

    // Formato 2: { assetEarningsModels: [...] } (FIIs e algumas ações)
    if ('assetEarningsModels' in parsed && Array.isArray(parsed.assetEarningsModels)) {
      return this.mapToEvents(parsed.assetEarningsModels, upper);
    }

    // Resposta com dados mas em formato desconhecido — loga e retorna vazio
    console.warn(
      `[DividendsProvider] Formato inesperado para ${ticker}:`,
      JSON.stringify(parsed).slice(0, 300),
    );
    return [];
  }

  private mapToEvents(
    raw: StatusInvestResponse,
    ticker: string,
  ): DividendEvent[] {
    const now = new Date();
    const fourYearsAgo = new Date(now);
    fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
    const cutoff = fourYearsAgo.toISOString().slice(0, 10);

    return raw
      .filter((item) => {
        // Filtra datas inválidas ou muito antigas
        const date = item.dataCom?.slice(0, 10);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
        return date >= cutoff;
      })
      .map((item) => ({
        date: item.dataCom!.slice(0, 10),
        value: parseFloat(item.valor) || 0,
        type: this.mapType(item.tipo),
      }))
      .filter((e) => e.value > 0);
  }

  /**
   * Mapeia o tipo do StatusInvest para o enum interno.
   * StatusInvest retorna: "Dividendo", "JCP", "Rendimento", "Amortização"
   */
  private mapType(tipo: string | undefined): DividendEvent['type'] {
    if (!tipo) return 'DIVIDEND';
    const t = tipo.toLowerCase();
    if (t.includes('jcp') || t.includes('juros')) return 'JCP';
    if (t.includes('rendimento')) return 'RENDIMENTO';
    if (t.includes('amortiz')) return 'AMORTIZACAO';
    return 'DIVIDEND';
  }
}

export const dividendsProvider = new DividendsProvider();
