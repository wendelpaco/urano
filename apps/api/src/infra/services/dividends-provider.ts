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
import { statusInvestLimiter } from './rate-limiter.ts';
import { getDividendsEndpoint } from '../../shared/ticker-utils.ts';
import type { DividendEvent } from '../../core/services/dividends-analyzer.ts';
import {
  loadFreshDividends,
  persistDividends,
} from '../database/dividend-queries.ts';

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

// ─── Provider ────────────────────────────────────────────────────────────────

export class DividendsProvider {
  private readonly baseUrl = 'https://statusinvest.com.br';

  /**
   * Busca proventos mensais de um ticker (ação ou FII).
   *
   * @param ticker Ticker B3 (ex: PETR4, KNCR11)
   * @returns DividendEvent[] ou null se indisponível
   */
  /**
   * Ordem free-only:
   * 1) Redis cache
   * 2) Postgres canônico se fresco (<24h)
   * 3) StatusInvest JSON → persiste no Postgres
   */
  async fetchDividends(ticker: string): Promise<DividendEvent[] | null> {
    const cacheKey = `dividends:${ticker.toUpperCase()}`;

    try {
      return await getOrSet(cacheKey, 86_400, async () => {
        // 2) DB canônico
        try {
          const fromDb = await loadFreshDividends(ticker);
          if (fromDb && fromDb.events.length >= 0) {
            // empty array is valid (ticker sem proventos mas sync recente)
            // only skip network if we have any row OR explicit empty sync — require events or known ticker fetch
            if (fromDb.events.length > 0) {
              return fromDb.events;
            }
          }
        } catch (err) {
          console.warn(
            `[DividendsProvider] DB read falhou para ${ticker}:`,
            (err as Error).message,
          );
        }

        // 3) Rede
        const events = await withRetry(() => this.doFetch(ticker), {
          maxRetries: 1,
          initialDelay: 500,
          maxDelay: 2000,
          timeout: 15_000,
        });

        if (events && events.length > 0) {
          void persistDividends(ticker, events, 'statusinvest').catch((e) =>
            console.warn(
              `[DividendsProvider] persist falhou ${ticker}:`,
              (e as Error).message,
            ),
          );
        }

        return events;
      });
    } catch {
      // Última chance: DB mesmo se “stale” não — só fresh. Degrada null → DMPL
      try {
        const fromDb = await loadFreshDividends(ticker);
        if (fromDb?.events.length) return fromDb.events;
      } catch { /* ok */ }

      console.warn(`[DividendsProvider] Indisponível para ${ticker}, retornando null`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private async doFetch(ticker: string): Promise<DividendEvent[] | null> {
    const upper = ticker.toUpperCase();

    // Usa utilitário centralizado que distingue Units de FIIs
    const { path, params, isFii } = getDividendsEndpoint(ticker);

    // Rate limit centralizado (compartilhado com outros scrapers do StatusInvest)
    await statusInvestLimiter.acquire();

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
