import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stockQuoteService } from '../../services/stock-quote-service.ts';
import { redis } from '../../services/redis.ts';
import { technicalIndicators } from '../../services/analysis/technical-indicators.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const paramsSchema = z.object({
  ticker: z
    .string()
    .min(4)
    .max(10)
    .transform((t) => t.toUpperCase()),
});

const historyQuerySchema = z.object({
  range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).default('1mo'),
  format: z.enum(['json', 'csv']).optional().default('json'),
});

const batchQuerySchema = z.object({
  tickers: z
    .string()
    .transform((s) =>
      s.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean),
    )
    .pipe(z.array(z.string().min(4).max(10)).min(1).max(20)),
});

/**
 * GET /v1/stocks/:ticker/quote
 * Retorna cotação em tempo real com cache Redis (TTL 30s).
 */
export async function getStockQuoteController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');

  const { ticker } = parsed.data;

  try {
    const quote = await stockQuoteService.getQuote(ticker);
    reply.send(quote);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    request.log.warn(`Cotação indisponível para ${ticker}: ${message}`);

    reply.status(502).send({
      error: 'QuoteUnavailable',
      message: `Não foi possível obter cotação para "${ticker}". O mercado pode estar fechado ou o ticker é inválido.`,
      detail: message,
    });
  }
}

/**
 * GET /v1/stocks/:ticker/history?range=1mo
 * Retorna histórico de preços (1mo, 3mo, 6mo, 1y, 2y, 5y).
 */
export async function getStockHistoryController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Ticker inválido.');

  const queryParsed = historyQuerySchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida.');

  const { ticker } = paramsParsed.data;
  const { range, format } = queryParsed.data;

  try {
    const history = await stockQuoteService.getHistory(ticker, range);

    // CSV export
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${ticker}_history_${range}.csv"`);
      const header = 'date,open,high,low,close,volume\n';
      const rows = history.points.map((p) =>
        `${p.date},${p.open},${p.high},${p.low},${p.close},${p.volume}`,
      ).join('\n');
      reply.send(header + rows);
      return;
    }

    reply.send(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'HistoryUnavailable',
      message: `Histórico indisponível para "${ticker}".`,
      detail: message,
    });
  }
}

/**
 * GET /v1/stocks/quotes?tickers=PETR4,VALE3,ITUB4
 * Retorna cotações de múltiplos tickers de uma vez.
 */
export async function getBatchQuotesController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const queryParsed = batchQuerySchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida. Use ?tickers=PETR4,VALE3');

  const { tickers } = queryParsed.data;

  try {
    const quotes = await stockQuoteService.getQuotes(tickers);

    const data = tickers.map((ticker) => {
      const quote = quotes.get(ticker);
      return quote ?? { ticker, error: 'Não disponível' };
    });

    reply.send({ total: data.length, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'QuoteUnavailable',
      message: `Falha ao obter cotações em lote. ${message}`,
    });
  }
}

// ─── Stats ────────────────────────────────────────────────────────────

const statsQuerySchema = z.object({
  format: z.enum(['json', 'csv']).optional().default('json'),
});

const corporateEventsSchema = z.object({
  year: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)).pipe(z.number().int().min(1986).max(2030).optional()),
  format: z.enum(['json', 'csv']).optional().default('json'),
});

export interface StockStats {
  ticker: string;
  companyName?: string;
  /** Preço atual */
  currentPrice: number;
  /** Variação no dia (%) */
  dailyChangePct: number;
  /** Máxima 52 semanas */
  high52w: number;
  /** Mínima 52 semanas */
  low52w: number;
  /** Retorno no ano atual (%) */
  ytdReturnPct: number | null;
  /** Volume médio diário (52 semanas) */
  avgVolume52w: number;
  /** Faixa de variação 52w relativa ao preço atual (0-1) */
  range52wPct: number;
  /** Data do último fechamento disponível */
  lastCloseDate: string;
}

/**
 * GET /v1/stocks/:ticker/stats
 * Estatísticas: 52-week range, YTD return, avg volume.
 * Cache Redis 5 min.
 */
export async function getStockStatsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Ticker inválido.');

  const queryParsed = statsQuerySchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida.');

  const { ticker } = paramsParsed.data;
  const { format } = queryParsed.data;

  const cacheKey = `stats:${ticker}`;

  try {
    // Tenta cache
    let stats: StockStats | null = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) stats = JSON.parse(cached);
    } catch { /* Redis offline */ }

    if (!stats) {
      const [quote, history] = await Promise.all([
        stockQuoteService.getQuote(ticker).catch(() => null),
        stockQuoteService.getHistory(ticker, '1y').catch(() => null),
      ]);

      if (!quote && !history) {
        reply.status(404).send({ error: 'NotFound', message: `Dados não disponíveis para "${ticker}".` });
        return;
      }

      const points = history?.points ?? [];

      // 52-week range
      let high52w = quote?.dayHigh ?? 0;
      let low52w = quote?.dayLow ?? 0;
      let totalVolume = 0;

      for (const p of points) {
        if (p.high > high52w) high52w = p.high;
        if (p.low < low52w || low52w === 0) low52w = p.low;
        totalVolume += p.volume;
      }

      // YTD return: primeiro dia útil do ano vs preço atual
      let ytdReturnPct: number | null = null;
      const currentYear = new Date().getFullYear();
      const ytdPoints = points.filter((p) => p.date.startsWith(String(currentYear)));
      if (ytdPoints.length > 0 && quote) {
        const firstClose = ytdPoints[0]!.close;
        if (firstClose > 0) {
          ytdReturnPct = +(((quote.price - firstClose) / firstClose) * 100).toFixed(2);
        }
      }

      // Range 52w relativo
      const range52wPct = high52w > 0
        ? +(((quote?.price ?? 0) - low52w) / (high52w - low52w)).toFixed(4)
        : 0.5;

      const lastCloseDate = points.length > 0 ? points[points.length - 1]!.date : '';

      stats = {
        ticker,
        currentPrice: quote?.price ?? 0,
        dailyChangePct: quote?.changePercent ?? 0,
        high52w: +high52w.toFixed(2),
        low52w: +low52w.toFixed(2),
        ytdReturnPct,
        avgVolume52w: points.length > 0 ? Math.round(totalVolume / points.length) : 0,
        range52wPct,
        lastCloseDate,
      };

      // Cache 5 min
      try { await redis.setex(cacheKey, 300, JSON.stringify(stats)); } catch { /* ok */ }
    }

    // CSV export
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${ticker}_stats.csv"`);
      reply.send(
        'ticker,current_price,daily_change_pct,high_52w,low_52w,ytd_return_pct,avg_volume_52w,range_52w_pct,last_close_date\n' +
        `${stats.ticker},${stats.currentPrice},${stats.dailyChangePct},${stats.high52w},${stats.low52w},${stats.ytdReturnPct ?? ''},${stats.avgVolume52w},${stats.range52wPct},${stats.lastCloseDate}`,
      );
      return;
    }

    reply.send(stats);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'StatsUnavailable',
      message: `Estatísticas indisponíveis para "${ticker}".`,
      detail: message,
    });
  }
}

// ─── Corporate Events ────────────────────────────────────────────────────────

export interface CorporateEvent {
  ticker: string;
  date: string;            // data ex
  type: 'split' | 'reverse_split' | 'dividend' | 'bonus' | 'subscription';
  description: string;
  ratio?: number;          // ex: 2.0 = 2 para 1 (split); 0.5 = 1 para 2 (reverse)
  valuePerShare?: number;  // proventos em R$
}

/**
 * GET /v1/stocks/:ticker/corporate-events?year=2025
 *
 * Eventos corporativos: splits, bonificações, desdobramentos.
 * Dados via Yahoo Finance (events API). Cache Redis 24h.
 */
export async function getCorporateEventsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Ticker inválido.');

  const queryParsed = corporateEventsSchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida.');

  const { ticker } = paramsParsed.data;
  const { year, format } = queryParsed.data;
  const symbol = `${ticker}.SA`;

  const cacheKey = `events:${ticker}`;

  try {
    // Tenta cache 24h
    let events: CorporateEvent[] = [];
    try {
      const cached = await redis.get(cacheKey);
      if (cached) events = JSON.parse(cached);
    } catch { /* ok */ }

    if (events.length === 0) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y&includePrePost=false&events=div%2Csplit`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Urano-FinBot/0.1', Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Yahoo Finance HTTP ${response.status}`);
      }

      const data = await response.json() as {
        chart?: {
          result?: Array<{
            events?: {
              splits?: Record<string, { date: number; numerator: number; denominator: number; splitRatio: string }>;
              dividends?: Record<string, { date: number; amount: number }>;
            };
          }>;
        };
      };

      const result = data.chart?.result?.[0];
      if (result?.events) {
        // Splits (desdobramentos, grupamentos)
        if (result.events.splits) {
          for (const [, split] of Object.entries(result.events.splits)) {
            const ratio = split.numerator / split.denominator;
            events.push({
              ticker,
              date: new Date(split.date * 1000).toISOString().slice(0, 10),
              type: ratio > 1 ? 'split' : 'reverse_split',
              description: ratio > 1
                ? `Desdobramento ${split.numerator} para ${split.denominator}`
                : `Grupamento ${split.numerator} para ${split.denominator}`,
              ratio: +ratio.toFixed(4),
            });
          }
        }

        // Dividendos (da Yahoo, complementar aos dados CVM)
        if (result.events.dividends) {
          for (const [, div] of Object.entries(result.events.dividends)) {
            events.push({
              ticker,
              date: new Date(div.date * 1000).toISOString().slice(0, 10),
              type: 'dividend',
              description: `Provento de R$ ${div.amount.toFixed(4)} por ação`,
              valuePerShare: +div.amount.toFixed(4),
            });
          }
        }
      }

      events.sort((a, b) => b.date.localeCompare(a.date));

      // Cache 24h
      try { await redis.setex(cacheKey, 86400, JSON.stringify(events)); } catch { /* ok */ }
    }

    // Filtra por ano
    let filtered = events;
    if (year) {
      const yearStr = String(year);
      filtered = events.filter((e) => e.date.startsWith(yearStr));
    }

    // CSV export
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${ticker}_events.csv"`);
      const header = 'date,type,description,ratio,value_per_share\n';
      const rows = filtered.map((e) =>
        `${e.date},${e.type},"${e.description}",${e.ratio ?? ''},${e.valuePerShare ?? ''}`,
      ).join('\n');
      reply.send(header + rows);
      return;
    }

    reply.send({ ticker, total: filtered.length, data: filtered });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'EventsUnavailable',
      message: `Eventos corporativos indisponíveis para "${ticker}".`,
      detail: message,
    });
  }
}

// ─── GET /v1/stocks/:ticker/indicators ──────────────────────────────────────

export async function getTechnicalIndicatorsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    return sendZodError(reply, parsed.error, 'Ticker inválido.');
  }
  const { ticker } = parsed.data;

  const cacheKey = `indicators:${ticker.toUpperCase()}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      reply.send(JSON.parse(cached));
      return;
    }
  } catch { /* Redis offline */ }

  try {
    const history = await stockQuoteService.getHistory(ticker, '1y');

    if (!history.points || history.points.length < 20) {
      reply.status(404).send({
        error: 'NotEnoughData',
        message: `Dados insuficientes para ${ticker}. Mínimo 20 pontos.`,
      });
      return;
    }

    const result = technicalIndicators.calculate(ticker, history.points);

    try { await redis.setex(cacheKey, 900, JSON.stringify(result)); } catch { /* ok */ }

    reply.send(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'IndicatorsUnavailable',
      message: `Indicadores técnicos indisponíveis para "${ticker}".`,
      detail: message,
    });
  }
}
