import { getOrSet } from './redis.ts';
import { withRetry, RateLimitError } from '../../shared/retry.ts';
import { yahooLimiter } from './rate-limiter.ts';
import { yahooCircuitBreaker } from './circuit-breaker.ts';
import { StatusInvestScraper } from './statusinvest-scraper.ts';

/**
 * Dados de cotação em tempo real de um ativo da B3.
 * Obtidos via Yahoo Finance (gratuito, sem API key).
 */
export interface StockHistoryPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockHistory {
  ticker: string;
  symbol: string;
  range: string;
  points: StockHistoryPoint[];
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
 * Serviço de cotações em tempo real com cache Redis.
 *
 * Fonte primária: StatusInvest (mais confiável para B3)
 * Fallback: Yahoo Finance v8 API (gratuita, uso razoável)
 *
 * Cache:
 *  - Cotação: 120s (2 min, suficiente para dashboards)
 *  - Histórico: 30 min (dados diários, não mudam intraday)
 *
 * Rate limit: 5 req/s para Yahoo Finance (centralizado)
 */
export class StockQuoteService {
  private readonly baseUrl =
    'https://query1.finance.yahoo.com/v8/finance/chart';
  private readonly statusInvest = new StatusInvestScraper();

  /**
   * Busca cotação atual de um ticker da B3.
   *
   * Cache Redis de 120s (vs 30s anterior) — cotações B3 têm delay natural
   * de 15 min para dados gratuitos, então 2 min é seguro e reduz chamadas.
   */
  async getQuote(ticker: string): Promise<StockQuote> {
    const cacheKey = `quote:${ticker.toUpperCase()}`;

    return getOrSet(cacheKey, 120, () =>
      // StatusInvest como fonte PRIMÁRIA (dados B3 mais confiáveis para ações brasileiras)
      this.fetchFromStatusInvest(ticker).catch((siErr) => {
        console.warn(`[quote] StatusInvest falhou para ${ticker} (${(siErr as Error).message}), tentando Yahoo...`);
        const symbol = this.toYahooSymbol(ticker);
        return withRetry(() => this.fetchQuote(symbol, ticker), {
          maxRetries: 2,
          initialDelay: 1000,
          maxDelay: 15_000,
          timeout: 10_000,
        });
      }));
  }

  /**
   * Busca cotações de múltiplos tickers com controle de concorrência.
   * Processa em lotes de 2 para não estourar rate limit do Yahoo.
   */
  async getQuotes(tickers: string[]): Promise<Map<string, StockQuote>> {
    // Processa sequencialmente (cada chamada já tem cache Redis de 120s,
    // então chamadas repetidas são instantâneas). Para tickers novos,
    // o rate limiter do Yahoo garante espaçamento.
    const results: (StockQuote | null)[] = [];
    for (const ticker of tickers) {
      try {
        const quote = await this.getQuote(ticker);
        results.push(quote);
      } catch {
        results.push(null);
      }
    }

    const map = new Map<string, StockQuote>();
    for (let i = 0; i < tickers.length; i++) {
      const quote = results[i];
      const ticker = tickers[i]!;
      if (quote) {
        map.set(ticker.toUpperCase(), quote);
      }
    }

    return map;
  }

  /**
   * Busca histórico de preços de um ticker.
   *
   * Cache Redis de 30 min (vs 5 min anterior) — dados diários não mudam
   * intraday. A Yahoo API é chamada com muito menos frequência.
   *
   * @param ticker Ticker B3 (ex: PETR4)
   * @param range  Período: '1mo', '3mo', '6mo', '1y', '2y', '5y'
   */
  async getHistory(
    ticker: string,
    range: string = '1mo',
  ): Promise<StockHistory> {
    const symbol = this.toYahooSymbol(ticker);
    const cacheKey = `history:${ticker.toUpperCase()}:${range}`;

    return getOrSet(cacheKey, 1800, () =>
      withRetry(() => this.fetchHistory(symbol, ticker, range), {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 15_000,
        timeout: 10_000,
      }));
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
      updatedAt: new Date().toISOString(),
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

    return {
      ticker: originalTicker.toUpperCase(),
      symbol,
      range,
      points,
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

    try {
      const r = await scraper.fetchStock(ticker);
      price = r.price;
      avgDailyLiquidity = r.avgDailyLiquidity;
      marketCap = r.marketCap;
    } catch { /* ok */ }

    if (price <= 0) {
      try {
        const r = await scraper.fetchFII(ticker);
        price = r.price;
      } catch { /* ok */ }
    }

    if (price <= 0) {
      throw new Error(`StatusInvest: preço não disponível para ${ticker}`);
    }

    console.log(`[quote] ✅ StatusInvest resgatou ${ticker} a R$ ${price}`);

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
      updatedAt: new Date().toISOString(),
    };
  }
}

export const stockQuoteService = new StockQuoteService();
