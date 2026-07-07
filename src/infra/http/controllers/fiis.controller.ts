import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrSet } from '../../services/redis.ts';
import { stockQuoteService, type StockQuote } from '../../services/stock-quote-service.ts';

const paramsSchema = z.object({
  ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
});

/**
 * FIIs — Fundos Imobiliários
 *
 * Fontes:
 *  - Dados cadastrais: CVM (cad_fi.csv)
 *  - Cotações em tempo real: Yahoo Finance (com cache Redis)
 *  - Histórico de preços: Yahoo Finance
 *
 * A integração com dados financeiros completos (distribuições, P/VP, NAV)
 * via INF_DIARIO da CVM está em desenvolvimento.
 */

// ─── Tipos ─────────────────────────────────────────────────────────────────

interface FiiBasic {
  ticker: string;
  name: string;
  cnpj: string;
  segment: string;
  admin: string;
}

interface FiiDetail extends FiiBasic {
  quote: StockQuote | null;
  source: string;
}

// ─── FIIs cadastrados ──────────────────────────────────────────────────────

const KNOWN_FIIS: FiiBasic[] = [
  { ticker: 'HGLG11', name: 'CSHG Logística FII', cnpj: '11364788000160', segment: 'Logística', admin: 'Credit Suisse Hedging-Griffo' },
  { ticker: 'KNRI11', name: 'Kinea Renda Imobiliária FII', cnpj: '12347360000193', segment: 'Lajes Corporativas', admin: 'Kinea Investimentos' },
  { ticker: 'XPLG11', name: 'XP Log FII', cnpj: '28417139000182', segment: 'Logística', admin: 'XP Asset Management' },
  { ticker: 'MXRF11', name: 'Maxi Renda FII', cnpj: '14822143000105', segment: 'Títulos e Valores Mobiliários', admin: 'BTG Pactual' },
  { ticker: 'BCFF11', name: 'BTG Pactual Fundo de Fundos FII', cnpj: '18950282000127', segment: 'FoF', admin: 'BTG Pactual' },
  { ticker: 'KNIP11', name: 'Kinea Índice de Preços FII', cnpj: '15555444000142', segment: 'Títulos e Valores Mobiliários', admin: 'Kinea Investimentos' },
  { ticker: 'VISC11', name: 'Vinci Shopping Centers FII', cnpj: '20912855000180', segment: 'Shopping', admin: 'Vinci Partners' },
  { ticker: 'HGRU11', name: 'CSHG Renda Urbana FII', cnpj: '24872469000100', segment: 'Renda Urbana', admin: 'Credit Suisse Hedging-Griffo' },
];

// ─── Controllers ───────────────────────────────────────────────────────────

/** GET /v1/fiis — Lista todos os FIIs com cotação (cache 60s) */
export async function listFiisController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const querySchema = z.object({
    segment: z.string().optional(),
    withQuote: z.string().optional().default('true').transform((v) => v === 'true'),
  });
  const { segment, withQuote } = querySchema.parse(request.query);

  let data = KNOWN_FIIS;
  if (segment) {
    const seg = segment.toLowerCase();
    data = data.filter((f) => f.segment.toLowerCase().includes(seg));
  }

  // Se solicitado, enriquece com cotações
  if (withQuote) {
    const cacheKey = `fiis:list:${segment ?? 'all'}`;
    const enriched = await getOrSet(cacheKey, 60, async () => {
      const tickers = data.map((f) => f.ticker);
      const quotes = await stockQuoteService.getQuotes(tickers);

      return data.map((f) => {
        const quote = quotes.get(f.ticker);
        return {
          ...f,
          quote: quote
            ? {
                price: quote.price,
                change: quote.change,
                changePercent: quote.changePercent,
                previousClose: quote.previousClose,
                volume: quote.volume,
                updatedAt: quote.updatedAt,
              }
            : null,
        };
      });
    });

    reply.send({ total: enriched.length, data: enriched });
  } else {
    reply.send({ total: data.length, data });
  }
}

/** GET /v1/fiis/:ticker — Detalhes do FII com cotação em tempo real */
export async function getFiiByTickerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { ticker } = paramsSchema.parse(request.params);
  const fii = KNOWN_FIIS.find((f) => f.ticker === ticker);

  if (!fii) {
    reply.status(404).send({ error: 'NotFound', message: `FII "${ticker}" não encontrado.` });
    return;
  }

  const cacheKey = `fii:detail:${ticker}`;

  const detail = await getOrSet(cacheKey, 30, async (): Promise<FiiDetail> => {
    let quote: StockQuote | null = null;
    try {
      quote = await stockQuoteService.getQuote(ticker);
    } catch {
      // Cotação indisponível não é erro crítico
    }

    return {
      ...fii,
      quote,
      source: 'CVM (cadastro) + Yahoo Finance (cotação)',
    };
  });

  reply.send(detail);
}

/** GET /v1/fiis/:ticker/history — Histórico de preços do FII */
export async function getFiiHistoryController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { ticker } = paramsSchema.parse(request.params);
  const fii = KNOWN_FIIS.find((f) => f.ticker === ticker);

  if (!fii) {
    reply.status(404).send({ error: 'NotFound', message: `FII "${ticker}" não encontrado.` });
    return;
  }

  const querySchema = z.object({
    range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).default('1y'),
  });
  const { range } = querySchema.parse(request.query);

  try {
    const history = await stockQuoteService.getHistory(ticker, range);

    reply.send({
      ticker,
      name: fii.name,
      segment: fii.segment,
      range,
      total: history.points.length,
      points: history.points,
      note: 'Histórico de preços de mercado via Yahoo Finance. Distribuições (dividendos/yield) via CVM em desenvolvimento.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    reply.status(502).send({
      error: 'HistoryUnavailable',
      message: `Histórico de preços indisponível para "${ticker}". ${message}`,
    });
  }
}
