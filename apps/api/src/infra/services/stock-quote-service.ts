import { getOrSet, redis } from './redis.ts';
import { withRetry, RateLimitError } from '../../shared/retry.ts';
import { yahooLimiter } from './rate-limiter.ts';
import {
  yahooCircuitBreaker,
  statusInvestCircuitBreaker,
  investidor10CircuitBreaker,
  CircuitOpenError,
} from './circuit-breaker.ts';
import { StatusInvestScraper } from './statusinvest-scraper.ts';
import { investidor10Provider } from './investidor10-provider.ts';
import { isFii } from '../../shared/ticker-utils.ts';

/**
 * Dados de cotação em tempo real de um ativo da B3.
 *
 * Mercado (preço/histórico): Investidor10 → Yahoo → StatusInvest
 * Fundamentals oficiais: CVM mensal (fora deste serviço)
 */
export interface StockHistoryPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type QuoteSource = 'investidor10' | 'statusinvest' | 'yahoo';

export interface StockHistory {
  ticker: string;
  symbol: string;
  range: string;
  points: StockHistoryPoint[];
  /** Provenance — free data package A */
  source: QuoteSource;
  asOf: string; // ISO timestamp when series was fetched
}

export interface StockQuote {
  ticker: string;
  symbol: string; // Símbolo no Yahoo Finance (ex: PETR4.SA)
  price: number;
  currency: string;
  change: number; // Variação absoluta
  changePercent: number; // Variação percentual
  previousClose: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  marketCap: number | null;
  updatedAt: string;
  /** Provenance — free data package A */
  source: QuoteSource;
  asOf: string; // ISO; same as updatedAt for live quotes
}

interface YahooFinanceHistoryResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

interface YahooFinanceResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        currency: string;
        regularMarketPrice: number;
        previousClose: number;
        regularMarketOpen: number;
        regularMarketDayHigh: number;
        regularMarketDayLow: number;
        regularMarketVolume: number;
        marketCap?: number;
        shortName?: string;
        longName?: string;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
}

/**
 * Serviço de cotações com cache Redis.
 *
 * Ordem de mercado (free):
 *  1. Investidor10 (JSON batch/chart) — primária
 *  2. Yahoo Finance
 *  3. StatusInvest (último recurso)
 *
 * Cache: cotação 5 min · histórico 30 min
 */
export class StockQuoteService {
  private readonly baseUrl =
    'https://query1.finance.yahoo.com/v8/finance/chart';
  private readonly statusInvest = new StatusInvestScraper();
  private readonly quoteTtlSec = 300;

  /**
   * Busca cotação atual de um ticker da B3.
   */
  async getQuote(ticker: string): Promise<StockQuote> {
    const cacheKey = `quote:${ticker.toUpperCase()}`;
    return getOrSet(cacheKey, this.quoteTtlSec, () => this.resolveQuote(ticker));
  }

  /**
   * Cadeia: Investidor10 → Yahoo → StatusInvest
   */
  private async resolveQuote(ticker: string): Promise<StockQuote> {
    const symbol = this.toYahooSymbol(ticker);
    const errors: string[] = [];

    // 1) Investidor10
    if (!(await this.isCircuitOpen(investidor10CircuitBreaker))) {
      try {
        const hit = await investidor10Provider.getQuote(ticker);
        const asOf = hit.lastUpdate
          ? this.i10UpdateToIso(hit.lastUpdate)
          : new Date().toISOString();
        console.log(`[quote] ✅ I10 ${ticker.toUpperCase()} R$ ${hit.price}`);
        return this.minimalQuote(ticker, hit.price, 'investidor10', asOf, symbol);
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) {
          errors.push(`i10:${(err as Error).message?.slice(0, 60)}`);
        }
      }
    }

    // 2) Yahoo
    try {
      return await withRetry(() => this.fetchQuote(symbol, ticker), {
        maxRetries: 1,
        initialDelay: 800,
        maxDelay: 8_000,
        timeout: 10_000,
      });
    } catch (err) {
      errors.push(`yahoo:${(err as Error).message?.slice(0, 60)}`);
    }

    // 3) StatusInvest (último)
    if (!(await this.isCircuitOpen(statusInvestCircuitBreaker))) {
      try {
        return await this.fetchFromStatusInvest(ticker);
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) {
          errors.push(`si:${(err as Error).message?.slice(0, 60)}`);
        }
      }
    }

    throw new Error(
      `Cotação indisponível para ${ticker} (${errors.join(' | ') || 'sem fontes'})`,
    );
  }

  /**
   * Lote: tenta batch I10 para misses de cache; resto via getQuote (cadeia completa).
   */
  async getQuotes(tickers: string[]): Promise<Map<string, StockQuote>> {
    const map = new Map<string, StockQuote>();
    const missing: string[] = [];

    for (const raw of tickers) {
      const t = raw.toUpperCase();
      try {
        const cached = await redis.get(`quote:${t}`);
        if (cached) {
          map.set(t, JSON.parse(cached) as StockQuote);
          continue;
        }
      } catch { /* redis offline */ }
      missing.push(t);
    }

    if (missing.length > 0 && !(await this.isCircuitOpen(investidor10CircuitBreaker))) {
      try {
        const batch = await investidor10Provider.getBatchQuotes(missing);
        for (const [t, hit] of batch) {
          const asOf = hit.lastUpdate
            ? this.i10UpdateToIso(hit.lastUpdate)
            : new Date().toISOString();
          const q = this.minimalQuote(t, hit.price, 'investidor10', asOf);
          map.set(t, q);
          try {
            await redis.setex(`quote:${t}`, this.quoteTtlSec, JSON.stringify(q));
          } catch { /* ok */ }
        }
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) {
          console.warn(`[quote] I10 batch: ${(err as Error).message?.slice(0, 80)}`);
        }
      }
    }

    for (const t of missing) {
      if (map.has(t)) continue;
      try {
        map.set(t, await this.getQuote(t));
      } catch {
        /* null skip */
      }
    }

    return map;
  }

  /**
   * Histórico diário: I10 chart → Yahoo.
   * Range Yahoo: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y'
   * I10 costuma cobrir ~1y; ranges longos preferem Yahoo se I10 for curto.
   */
  async getHistory(
    ticker: string,
    range: string = '1mo',
  ): Promise<StockHistory> {
    const symbol = this.toYahooSymbol(ticker);
    const cacheKey = `history:${ticker.toUpperCase()}:${range}`;

    return getOrSet(cacheKey, 1800, () => this.resolveHistory(ticker, symbol, range));
  }

  private async resolveHistory(
    ticker: string,
    symbol: string,
    range: string,
  ): Promise<StockHistory> {
    const minPoints = this.minPointsForRange(range);

    if (!(await this.isCircuitOpen(investidor10CircuitBreaker))) {
      try {
        const series = await investidor10Provider.getDailyChart(ticker);
        const sliced = this.sliceSeriesByRange(series, range);
        if (sliced.length >= Math.min(minPoints, 5)) {
          const points: StockHistoryPoint[] = sliced.map((p) => ({
            date: p.date,
            open: p.close,
            high: p.close,
            low: p.close,
            close: p.close,
            volume: 0,
          }));
          return {
            ticker: ticker.toUpperCase(),
            symbol,
            range,
            points,
            source: 'investidor10',
            asOf: new Date().toISOString(),
          };
        }
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) {
          console.warn(
            `[history] I10→Yahoo ${ticker}: ${(err as Error).message?.slice(0, 80)}`,
          );
        }
      }
    }

    return withRetry(() => this.fetchHistory(symbol, ticker, range), {
      maxRetries: 1,
      initialDelay: 1000,
      maxDelay: 15_000,
      timeout: 10_000,
    });
  }

  private async isCircuitOpen(
    breaker: { currentState: () => Promise<string> },
  ): Promise<boolean> {
    try {
      return (await breaker.currentState()) === 'OPEN';
    } catch {
      return false;
    }
  }

  private minimalQuote(
    ticker: string,
    price: number,
    source: QuoteSource,
    asOf: string,
    symbol?: string,
  ): StockQuote {
    const p = Math.round(price * 100) / 100;
    return {
      ticker: ticker.toUpperCase(),
      symbol: symbol ?? this.toYahooSymbol(ticker),
      price: p,
      currency: 'BRL',
      change: 0,
      changePercent: 0,
      previousClose: p,
      open: p,
      dayHigh: p,
      dayLow: p,
      volume: 0,
      marketCap: null,
      updatedAt: asOf,
      source,
      asOf,
    };
  }

  private i10UpdateToIso(lastUpdate: string): string {
    // "2026-07-15 17:46:00" → assume BRT
    const m = lastUpdate.trim().match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (m) {
      const [, d, hh, mi, ss = '00'] = m;
      return `${d}T${hh}:${mi}:${ss}-03:00`;
    }
    return new Date().toISOString();
  }

  private minPointsForRange(range: string): number {
    switch (range) {
      case '1mo':
        return 15;
      case '3mo':
        return 40;
      case '6mo':
        return 80;
      case '1y':
        return 150;
      case '2y':
        return 300;
      case '5y':
        return 600;
      default:
        return 15;
    }
  }

  private sliceSeriesByRange(
    series: Array<{ date: string; close: number }>,
    range: string,
  ): Array<{ date: string; close: number }> {
    if (series.length === 0) return series;
    const days: Record<string, number> = {
      '1mo': 31,
      '3mo': 93,
      '6mo': 186,
      '1y': 370,
      '2y': 740,
      '5y': 1850,
    };
    const window = days[range] ?? 370;
    const last = series[series.length - 1]!.date;
    const end = new Date(`${last}T00:00:00Z`).getTime();
    const start = end - window * 86_400_000;
    return series.filter((p) => {
      const t = new Date(`${p.date}T00:00:00Z`).getTime();
      return t >= start;
    });
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  /** Converte ticker B3 para símbolo Yahoo Finance (PETR4 → PETR4.SA) */
  private toYahooSymbol(ticker: string): string {
    const upper = ticker.toUpperCase();
    return upper.endsWith('.SA') ? upper : `${upper}.SA`;
  }

  /** Faz a requisição HTTP à API do Yahoo Finance com rate limit */
  private async fetchQuote(
    symbol: string,
    originalTicker: string,
  ): Promise<StockQuote> {
    // Circuit breaker: verifica se o Yahoo está acessível
    await yahooCircuitBreaker.beforeRequest();

    // Rate limit centralizado do Yahoo
    await yahooLimiter.acquire();

    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

    let response: Response;
    try {
      response = await withRetry(async () => {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Urano-FinBot/0.1',
            Accept: 'application/json',
          },
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const retrySec = retryAfter ? parseInt(retryAfter, 10) || 5 : 5;
          throw new RateLimitError(
            `Yahoo Finance HTTP 429 (Retry-After: ${retrySec}s)`,
            retrySec * 1000,
          );
        }

        if (!res.ok) {
          throw new Error(`Yahoo Finance retornou HTTP ${res.status} para ${symbol}`);
        }

        return res;
      }, {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 15_000,
      });

      // Sucesso: notifica circuit breaker
      await yahooCircuitBreaker.onSuccess();
    } catch (error) {
      if (error instanceof RateLimitError) {
        await yahooCircuitBreaker.onFailure('rate-limit', error.message);
      } else if (error instanceof Error && error.message.includes('HTTP 5')) {
        await yahooCircuitBreaker.onFailure('server-error', error.message);
      } else {
        await yahooCircuitBreaker.onFailure('network-error', (error as Error).message);
      }
      throw error;
    }

    const data = (await response.json()) as YahooFinanceResponse;

    if (data.chart.error) {
      throw new Error(
        `Erro Yahoo Finance para ${symbol}: ${data.chart.error.description}`,
      );
    }

    const result = data.chart.result?.[0];
    if (!result?.meta) {
      throw new Error(`Dados não disponíveis para ${symbol}`);
    }

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? price;
    const open = meta.regularMarketOpen ?? previousClose;
    const change = price - previousClose;
    const changePercent = previousClose !== 0
      ? (change / previousClose) * 100
      : 0;

    const asOf = new Date().toISOString();
    return {
      ticker: originalTicker.toUpperCase(),
      symbol,
      price: Math.round(price * 100) / 100,
      currency: meta.currency,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
      previousClose,
      open,
      dayHigh: meta.regularMarketDayHigh ?? price,
      dayLow: meta.regularMarketDayLow ?? price,
      volume: meta.regularMarketVolume ?? 0,
      marketCap: meta.marketCap ?? null,
      updatedAt: asOf,
      source: 'yahoo',
      asOf,
    };
  }

  /** Busca histórico de preços via Yahoo Finance chart API */
  private async fetchHistory(
    symbol: string,
    originalTicker: string,
    range: string,
  ): Promise<StockHistory> {
    // Circuit breaker: verifica se o Yahoo está acessível
    await yahooCircuitBreaker.beforeRequest();

    // Rate limit centralizado do Yahoo
    await yahooLimiter.acquire();

    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;

    let response: Response;
    try {
      response = await withRetry(async () => {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Urano-FinBot/0.1',
            Accept: 'application/json',
          },
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const retrySec = retryAfter ? parseInt(retryAfter, 10) || 5 : 5;
          throw new RateLimitError(
            `Yahoo Finance HTTP 429 (Retry-After: ${retrySec}s)`,
            retrySec * 1000,
          );
        }

        if (!res.ok) {
          throw new Error(`Yahoo Finance HTTP ${res.status} para ${symbol}`);
        }

        return res;
      }, {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 15_000,
      });

      await yahooCircuitBreaker.onSuccess();
    } catch (error) {
      if (error instanceof RateLimitError) {
        await yahooCircuitBreaker.onFailure('rate-limit', error.message);
      } else if (error instanceof Error && error.message.includes('HTTP 5')) {
        await yahooCircuitBreaker.onFailure('server-error', error.message);
      } else {
        await yahooCircuitBreaker.onFailure('network-error', (error as Error).message);
      }
      throw error;
    }

    const data = (await response.json()) as YahooFinanceHistoryResponse;
    const result = data.chart.result?.[0];

    if (!result?.timestamp) {
      throw new Error(`Histórico indisponível para ${symbol}`);
    }

    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    if (!quotes) throw new Error('Indicadores ausentes no histórico');

    const points: StockHistoryPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]!;
      points.push({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: Math.round((quotes.open[i] ?? 0) * 100) / 100,
        high: Math.round((quotes.high[i] ?? 0) * 100) / 100,
        low: Math.round((quotes.low[i] ?? 0) * 100) / 100,
        close: Math.round((quotes.close[i] ?? 0) * 100) / 100,
        volume: quotes.volume[i] ?? 0,
      });
    }

    const asOf = new Date().toISOString();
    return {
      ticker: originalTicker.toUpperCase(),
      symbol,
      range,
      points,
      source: 'yahoo',
      asOf,
    };
  }

  /**
   * Fallback: busca preço via StatusInvest quando Yahoo falha.
   * StatusInvest é mais estável para ativos brasileiros.
   */
  private async fetchFromStatusInvest(ticker: string): Promise<StockQuote> {
    const scraper = this.statusInvest;

    let price = 0;
    let avgDailyLiquidity = 0;
    let marketCap: number | null = null;

    // Uma rota só (FII vs ação) — evita 2 hits SI por ticker no warmup
    if (isFii(ticker)) {
      const r = await scraper.fetchFII(ticker);
      price = r.price;
    } else {
      const r = await scraper.fetchStock(ticker);
      price = r.price;
      avgDailyLiquidity = r.avgDailyLiquidity;
      marketCap = r.marketCap;
    }

    if (price <= 0) {
      throw new Error(`StatusInvest: preço não disponível para ${ticker}`);
    }

    console.log(`[quote] ✅ StatusInvest ${ticker} R$ ${price}`);

    const asOf = new Date().toISOString();
    return {
      ticker: ticker.toUpperCase(),
      symbol: `${ticker.toUpperCase()}.SA`,
      price,
      currency: 'BRL',
      change: 0,
      changePercent: 0,
      previousClose: price,
      open: price,
      dayHigh: price,
      dayLow: price,
      volume: avgDailyLiquidity || 0,
      marketCap,
      updatedAt: asOf,
      source: 'statusinvest',
      asOf,
    };
  }

  /**
   * Benchmark / índice via Yahoo (ex.: IBOV = ^BVSP).
   * Não usa StatusInvest — símbolos de índice são Yahoo-only.
   */
  async getIndexHistory(
    yahooSymbol: string,
    range: string = '1y',
  ): Promise<StockHistory> {
    const cacheKey = `index-history:${yahooSymbol}:${range}`;
    return getOrSet(cacheKey, 1800, () =>
      withRetry(() => this.fetchHistory(yahooSymbol, yahooSymbol, range), {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 15_000,
        timeout: 10_000,
      }));
  }

  async getIndexQuote(yahooSymbol: string): Promise<StockQuote> {
    const cacheKey = `index-quote:${yahooSymbol}`;
    return getOrSet(cacheKey, 120, () =>
      withRetry(() => this.fetchQuote(yahooSymbol, yahooSymbol.replace('^', '')), {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 15_000,
        timeout: 10_000,
      }));
  }
}

export const stockQuoteService = new StockQuoteService();
