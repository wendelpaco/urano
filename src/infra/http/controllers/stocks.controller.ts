import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stockQuoteService } from '../../services/stock-quote-service.ts';

const paramsSchema = z.object({
  ticker: z
    .string()
    .min(4)
    .max(10)
    .transform((t) => t.toUpperCase()),
});

/**
 * GET /v1/stocks/:ticker/quote
 * Retorna cotação em tempo real com cache Redis (TTL 30s).
 */
export async function getStockQuoteController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { ticker } = paramsSchema.parse(request.params);

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
  const { ticker } = paramsSchema.parse(request.params);
  const querySchema = z.object({
    range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).default('1mo'),
  });
  const { range } = querySchema.parse(request.query);

  try {
    const history = await stockQuoteService.getHistory(ticker, range);
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
  const querySchema = z.object({
    tickers: z
      .string()
      .transform((s) =>
        s.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean),
      )
      .pipe(z.array(z.string().min(4).max(10)).min(1).max(20)),
  });

  const { tickers } = querySchema.parse(request.query);

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
