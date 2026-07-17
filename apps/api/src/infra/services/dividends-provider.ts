/**
 * DividendsProvider — Fonte de proventos por cota via StatusInvest JSON API.
 *
 * Único pedaço do "scraper" que vale a pena: o endpoint retorna JSON, não HTML.
 * Cache Redis 24h (proventos mudam raramente), retry com backoff (Onda 1a),
 * e rate limiter interno (1 req/s) para não ser bloqueado.
 *
 * Fallback: se o endpoint falhar, retorna null → caller degrada com DMPL.
 */

import { getOrSet, redis } from './redis.ts';
import { withRetry, RateLimitError } from '../../shared/retry.ts';
import { statusInvestLimiter } from './rate-limiter.ts';
import { statusInvestCircuitBreaker } from './circuit-breaker.ts';
import { getDividendsEndpoint } from '../../shared/ticker-utils.ts';
import { readBodyWithCap } from '../../shared/safe-fetch.ts';
import type { DividendEvent } from '../../core/services/dividends-analyzer.ts';
import {
  loadFreshDividends,
  persistDividends,
} from '../database/dividend-queries.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Item cru do StatusInvest (ações e FIIs usam campos diferentes). */
interface StatusInvestProvent {
  dataCom?: string; // ISO "2025-06-15" (ações)
  dataPagamento?: string;
  valor?: string | number; // "0.1023" ou 0.1023
  tipo?: string; // "Dividendo" | "JCP" | "Rendimento" | "Amortização"
  assetType?: number;
  // FII companytickerprovents:
  ed?: string; // data-com DD/MM/YYYY
  pd?: string; // pagamento DD/MM/YYYY
  v?: number; // valor por cota
  et?: string; // tipo ("Rendimento")
  etd?: string;
}

type StatusInvestResponse = StatusInvestProvent[];

/** Converte "DD/MM/YYYY" ou "YYYY-MM-DD" → ISO date ou null. */
function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function parseValor(item: StatusInvestProvent): number {
  if (typeof item.v === 'number' && Number.isFinite(item.v)) return item.v;
  if (typeof item.valor === 'number' && Number.isFinite(item.valor)) return item.valor;
  if (typeof item.valor === 'string') {
    const n = parseFloat(item.valor.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

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

        // 3) Rede — sem retry em 429 (penalty global + circuit já protegem)
        const events = await withRetry(() => this.doFetch(ticker), {
          maxRetries: 0,
          initialDelay: 1000,
          maxDelay: 5000,
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

  /**
   * Como fetchDividends, mas NUNCA bate rede — só cache Redis ou DB canônico.
   * Miss vira null (DY fica indisponível na resposta; próximo warmup/sync popula).
   *
   * Uso: rotas de alto volume (ranking, N tickers por request) que não podem
   * esperar o rate limiter do StatusInvest (0.5 req/s serializado e global —
   * concorrência do batch não ajuda, N tickers frios = N * ~2s mínimo).
   */
  async getCachedDividends(ticker: string): Promise<DividendEvent[] | null> {
    const cacheKey = `dividends:${ticker.toUpperCase()}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as DividendEvent[];
    } catch { /* redis offline */ }

    try {
      const fromDb = await loadFreshDividends(ticker);
      if (fromDb && fromDb.events.length > 0) return fromDb.events;
    } catch { /* ok */ }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private async doFetch(ticker: string): Promise<DividendEvent[] | null> {
    const upper = ticker.toUpperCase();

    // Usa utilitário centralizado que distingue Units de FIIs
    const { path, params, isFii } = getDividendsEndpoint(ticker);

    // Se SI em cooldown, não gasta request — caller usa DB/null
    await statusInvestCircuitBreaker.beforeRequest();
    await statusInvestLimiter.acquire();

    const url = `${this.baseUrl}${path}${params}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Urano-FinBot/0.1',
        Accept: 'application/json',
        Referer: `${this.baseUrl}/${isFii ? 'fundos-imobiliarios' : 'acoes'}/${upper}`,
      },
      redirect: 'error',
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retrySec = retryAfter ? parseInt(retryAfter, 10) || 15 : 15;
      const retryMs = retrySec * 1000;
      statusInvestLimiter.penalize(retryMs);
      await statusInvestCircuitBreaker.onFailure(
        'rate-limit',
        `StatusInvest dividends 429 (Retry-After: ${retrySec}s)`,
      );
      throw new RateLimitError(
        `StatusInvest HTTP 429 (Retry-After: ${retrySec}s)`,
        retryMs,
      );
    }

    if (!response.ok) {
      throw new Error(`StatusInvest HTTP ${response.status} para ${ticker}`);
    }

    await statusInvestCircuitBreaker.onSuccess();

    // SSRF-1r: leitura streaming com teto de 512 KiB.
    const text = await readBodyWithCap(response, 512 * 1024);
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
    _ticker: string,
  ): DividendEvent[] {
    // Histórico longo para backtest FII/ações (fonte free retorna ~10y em FII)
    const now = new Date();
    const lookback = new Date(now);
    lookback.setFullYear(lookback.getFullYear() - 12);
    const cutoff = lookback.toISOString().slice(0, 10);

    const events: DividendEvent[] = [];
    for (const item of raw) {
      // Prefer data-com; fallback pagamento. Aceita ISO ou BR.
      const date =
        toIsoDate(item.dataCom) ??
        toIsoDate(item.ed) ??
        toIsoDate(item.dataPagamento) ??
        toIsoDate(item.pd);
      if (!date || date < cutoff) continue;
      const value = parseValor(item);
      if (!(value > 0)) continue;
      events.push({
        date,
        value,
        type: this.mapType(item.tipo ?? item.et ?? item.etd),
      });
    }
    // Dedup por data+valor (API às vezes repete ajustados)
    const seen = new Set<string>();
    return events.filter((e) => {
      const k = `${e.date}|${e.value}|${e.type}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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
