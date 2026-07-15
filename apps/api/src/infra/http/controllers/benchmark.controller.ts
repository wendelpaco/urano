/**
 * Benchmarks de mercado — fontes gratuitas (Yahoo Finance).
 *
 * GET /v1/benchmarks          — lista índices suportados + última cotação
 * GET /v1/benchmarks/:id      — cotação + histórico (range)
 *
 * IBOV: ^BVSP (Yahoo). Gratuito, sem API key, sem SLA.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stockQuoteService } from '../../services/stock-quote-service.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

/** Índices gratuitos via Yahoo. id estável na API; symbol = Yahoo. */
export const BENCHMARKS = {
  ibov: {
    id: 'ibov',
    name: 'Ibovespa',
    yahooSymbol: '^BVSP',
    currency: 'BRL',
    source: 'yahoo' as const,
  },
  // IFIX no Yahoo costuma ser ^IFIX.SA ou similar — pode falhar; exposto como experimental
  ifix: {
    id: 'ifix',
    name: 'IFIX (experimental)',
    yahooSymbol: 'IFIX.SA',
    currency: 'BRL',
    source: 'yahoo' as const,
  },
} as const;

export type BenchmarkId = keyof typeof BENCHMARKS;

/**
 * GET /v1/benchmarks
 */
export async function listBenchmarksController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const items = [];
  for (const b of Object.values(BENCHMARKS)) {
    try {
      const quote = await stockQuoteService.getIndexQuote(b.yahooSymbol);
      items.push({
        id: b.id,
        name: b.name,
        yahooSymbol: b.yahooSymbol,
        price: quote.price,
        changePercent: quote.changePercent,
        currency: quote.currency,
        source: quote.source,
        asOf: quote.asOf,
      });
    } catch (err) {
      items.push({
        id: b.id,
        name: b.name,
        yahooSymbol: b.yahooSymbol,
        price: null,
        changePercent: null,
        currency: b.currency,
        source: b.source,
        asOf: null,
        error: err instanceof Error ? err.message : 'unavailable',
      });
    }
  }

  reply.send({
    total: items.length,
    data: items,
    note: 'Fontes gratuitas (Yahoo). Sem SLA. Preferir cache; não usar como feed oficial B3.',
  });
}

/**
 * GET /v1/benchmarks/:id?range=1y
 */
export async function getBenchmarkController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = z
    .object({ id: z.enum(['ibov', 'ifix']) })
    .safeParse(request.params);
  if (!params.success) return sendZodError(reply, params.error, 'Benchmark inválido (ibov|ifix).');

  const query = z
    .object({
      range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).default('1y'),
    })
    .safeParse(request.query);
  if (!query.success) return sendZodError(reply, query.error, 'Query inválida.');

  const meta = BENCHMARKS[params.data.id];
  const { range } = query.data;

  try {
    const [quote, history] = await Promise.all([
      stockQuoteService.getIndexQuote(meta.yahooSymbol),
      stockQuoteService.getIndexHistory(meta.yahooSymbol, range),
    ]);

    reply.send({
      id: meta.id,
      name: meta.name,
      yahooSymbol: meta.yahooSymbol,
      quote: {
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        previousClose: quote.previousClose,
        source: quote.source,
        asOf: quote.asOf,
      },
      history: {
        range: history.range,
        source: history.source,
        asOf: history.asOf,
        points: history.points,
        total: history.points.length,
      },
      dataQuality: {
        freeSource: true,
        officialB3: false,
        note: 'Yahoo Finance — uso pessoal/fallback; não é feed oficial B3.',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'BenchmarkUnavailable',
      message: `Não foi possível obter ${meta.name} (${meta.yahooSymbol}).`,
      detail: message,
    });
  }
}
