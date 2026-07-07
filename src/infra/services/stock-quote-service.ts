import { getOrSet } from './redis.ts';

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
 * Serviço de cotações em tempo real com cache Redis (TTL 30 segundos).
 *
 * Fonte: Yahoo Finance v8 API (gratuita, uso razoável).
 * Formato do ticker na B3: PETR4 → PETR4.SA
 */
export class StockQuoteService {
  private readonly baseUrl =
    'https://query1.finance.yahoo.com/v8/finance/chart';

  /**
   * Busca cotação atual de um ticker da B3.
   *
   * Cache Redis de 30s para respeitar rate limits e reduzir latência.
   * Se Redis indisponível, busca direto na API.
   */
  async getQuote(ticker: string): Promise<StockQuote> {
    const symbol = this.toYahooSymbol(ticker);
    const cacheKey = `quote:${ticker.toUpperCase()}`;

    return getOrSet(cacheKey, 30, () => this.fetchQuote(symbol, ticker));
  }

  /**
   * Busca cotações de múltiplos tickers simultaneamente.
   */
  async getQuotes(tickers: string[]): Promise<Map<string, StockQuote>> {
    const results = await Promise.all(
      tickers.map((t) => this.getQuote(t).catch(() => null)),
    );

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
   * @param ticker Ticker B3 (ex: PETR4)
   * @param range  Período: '1mo', '3mo', '6mo', '1y', '2y', '5y'
   */
  async getHistory(
    ticker: string,
    range: string = '1mo',
  ): Promise<StockHistory> {
    const symbol = this.toYahooSymbol(ticker);
    const cacheKey = `history:${ticker.toUpperCase()}:${range}`;

    return getOrSet(cacheKey, 300, () => this.fetchHistory(symbol, ticker, range));
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  /** Converte ticker B3 para símbolo Yahoo Finance (PETR4 → PETR4.SA) */
  private toYahooSymbol(ticker: string): string {
    const upper = ticker.toUpperCase();
    // Se já tem sufixo .SA, não duplica
    return upper.endsWith('.SA') ? upper : `${upper}.SA`;
  }

  /** Faz a requisição HTTP à API do Yahoo Finance */
  private async fetchQuote(
    symbol: string,
    originalTicker: string,
  ): Promise<StockQuote> {
    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Urano-FinBot/0.1',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Yahoo Finance retornou HTTP ${response.status} para ${symbol}`,
      );
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
    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Urano-FinBot/0.1',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance HTTP ${response.status} para ${symbol}`);
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
}

export const stockQuoteService = new StockQuoteService();
