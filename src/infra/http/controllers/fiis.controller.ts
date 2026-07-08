import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrSet } from '../../services/redis.ts';
import { stockQuoteService, type StockQuote } from '../../services/stock-quote-service.ts';
import { dividendsProvider } from '../../services/dividends-provider.ts';
import { fiisScraper } from '../../services/fiis-scraper.ts';
import { fiiOperationalService, type FiiOperationalData } from '../../services/fii-operational.service.ts';
import { batchWithConcurrency } from '../../../shared/retry.ts';

function sendZodError(reply: FastifyReply, error: z.ZodError, message: string): void {
  reply.status(400).send({
    error: 'ValidationError',
    message,
    details: error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
  });
}

const paramsSchema = z.object({
  ticker: z.string().min(4).max(10).transform((t) => t.toUpperCase()),
});

const fiiHistoryQuerySchema = z.object({
  range: z.enum(['1mo', '3mo', '6mo', '1y', '2y', '5y']).default('1y'),
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
  // Logística
  { ticker: 'HGLG11', name: 'CSHG Logística FII', cnpj: '11364788000160', segment: 'Logística', admin: 'Credit Suisse Hedging-Griffo' },
  { ticker: 'XPLG11', name: 'XP Log FII', cnpj: '28417139000182', segment: 'Logística', admin: 'XP Asset Management' },
  { ticker: 'BTLG11', name: 'BTG Pactual Logística FII', cnpj: '19964177000176', segment: 'Logística', admin: 'BTG Pactual' },
  { ticker: 'VILG11', name: 'Vinci Logística FII', cnpj: '31476035000182', segment: 'Logística', admin: 'Vinci Partners' },
  { ticker: 'LVBI11', name: 'VBI Logístico FII', cnpj: '28600898000161', segment: 'Logística', admin: 'VBI Real Estate' },
  // Lajes Corporativas
  { ticker: 'KNRI11', name: 'Kinea Renda Imobiliária FII', cnpj: '12347360000193', segment: 'Lajes Corporativas', admin: 'Kinea Investimentos' },
  { ticker: 'RCRB11', name: 'Rio Bravo Renda Corporativa FII', cnpj: '11171833000170', segment: 'Lajes Corporativas', admin: 'Rio Bravo Investimentos' },
  { ticker: 'HGRE11', name: 'CSHG Real Estate FII', cnpj: '11364788000160', segment: 'Lajes Corporativas', admin: 'Credit Suisse Hedging-Griffo' },
  { ticker: 'BRCR11', name: 'BTG Pactual Corporate Office Fund FII', cnpj: '11318266000110', segment: 'Lajes Corporativas', admin: 'BTG Pactual' },
  // Shopping
  { ticker: 'VISC11', name: 'Vinci Shopping Centers FII', cnpj: '20912855000180', segment: 'Shopping', admin: 'Vinci Partners' },
  { ticker: 'XPML11', name: 'XP Malls FII', cnpj: '28981855000178', segment: 'Shopping', admin: 'XP Asset Management' },
  { ticker: 'MALL11', name: 'Malls Brasil Plural FII', cnpj: '20110654000140', segment: 'Shopping', admin: 'Plural Gestão' },
  { ticker: 'HSML11', name: 'Hedge Shopping Malls FII', cnpj: '36872408000160', segment: 'Shopping', admin: 'Hedge Investments' },
  // Títulos e Valores Mobiliários (Papel)
  { ticker: 'KNIP11', name: 'Kinea Índice de Preços FII', cnpj: '15555444000142', segment: 'Títulos e Valores Mobiliários', admin: 'Kinea Investimentos' },
  { ticker: 'KNCR11', name: 'Kinea Rendimentos Imobiliários FII', cnpj: '18644758000147', segment: 'Títulos e Valores Mobiliários', admin: 'Kinea Investimentos' },
  { ticker: 'MXRF11', name: 'Maxi Renda FII', cnpj: '14822143000105', segment: 'Títulos e Valores Mobiliários', admin: 'BTG Pactual' },
  { ticker: 'VGIR11', name: 'Valora CRI Índice de Preço FII', cnpj: '31587635000180', segment: 'Títulos e Valores Mobiliários', admin: 'Valora Investimentos' },
  { ticker: 'IRDM11', name: 'Iridium Recebíveis Imobiliários FII', cnpj: '29193901000110', segment: 'Títulos e Valores Mobiliários', admin: 'Iridium Gestão' },
  { ticker: 'URPR11', name: 'Urca Prime Renda FII', cnpj: '33283111000100', segment: 'Títulos e Valores Mobiliários', admin: 'Urca Investments' },
  { ticker: 'CPTS11', name: 'Capitânia Securities II FII', cnpj: '29414530000136', segment: 'Títulos e Valores Mobiliários', admin: 'Capitânia Investimentos' },
  { ticker: 'RECR11', name: 'REC Recebíveis Imobiliários FII', cnpj: '27141610000100', segment: 'Títulos e Valores Mobiliários', admin: 'REC Gestão' },
  { ticker: 'DEVA11', name: 'Devant Recebíveis Imobiliários FII', cnpj: '37173550000109', segment: 'Títulos e Valores Mobiliários', admin: 'Devant Asset' },
  { ticker: 'RBRR11', name: 'RBR Rendimento High Grade FII', cnpj: '34845460000178', segment: 'Títulos e Valores Mobiliários', admin: 'RBR Asset' },
  // Fundo de Fundos
  { ticker: 'BCFF11', name: 'BTG Pactual Fundo de Fundos FII', cnpj: '18950282000127', segment: 'FoF', admin: 'BTG Pactual' },
  { ticker: 'KISU11', name: 'Kinea FOF FII', cnpj: '36780740000194', segment: 'FoF', admin: 'Kinea Investimentos' },
  { ticker: 'ITIP11', name: 'Itaú FOF Renda Imobiliária FII', cnpj: '36814918000170', segment: 'FoF', admin: 'Itaú Asset' },
  // Renda Urbana / Híbrido
  { ticker: 'HGRU11', name: 'CSHG Renda Urbana FII', cnpj: '24872469000100', segment: 'Renda Urbana', admin: 'Credit Suisse Hedging-Griffo' },
  { ticker: 'TRXF11', name: 'TRX Real Estate FII', cnpj: '30527639000107', segment: 'Renda Urbana', admin: 'TRX Gestão' },
  // Agro
  { ticker: 'RZTR11', name: 'Riza Terrax FII', cnpj: '35690013000100', segment: 'Agro', admin: 'Riza Asset' },
  { ticker: 'SNAG11', name: 'Suno Agro FII', cnpj: '36077366000103', segment: 'Agro', admin: 'Suno Asset' },
  // Desenvolvimento Imobiliário
  { ticker: 'VGIP11', name: 'Valora CRI FII', cnpj: '33737372000109', segment: 'Títulos e Valores Mobiliários', admin: 'Valora Investimentos' },
  // Galpões / Industrial
  { ticker: 'GARE11', name: 'Guardian Logística FII', cnpj: '38099718000162', segment: 'Logística', admin: 'Guardian Asset' },
  { ticker: 'PATL11', name: 'Pátria Logístico FII', cnpj: '36157802000183', segment: 'Logística', admin: 'Pátria Investimentos' },
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
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');
  const { segment, withQuote } = parsed.data;

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
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

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
  const paramsParsed = paramsSchema.safeParse(request.params);
  if (!paramsParsed.success) return sendZodError(reply, paramsParsed.error, 'Ticker inválido.');
  const { ticker } = paramsParsed.data;

  const fii = KNOWN_FIIS.find((f) => f.ticker === ticker);

  if (!fii) {
    reply.status(404).send({ error: 'NotFound', message: `FII "${ticker}" não encontrado.` });
    return;
  }

  const queryParsed = fiiHistoryQuerySchema.safeParse(request.query);
  if (!queryParsed.success) return sendZodError(reply, queryParsed.error, 'Query inválida.');
  const { range } = queryParsed.data;

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

// ─── Screener ────────────────────────────────────────────────────────────────

const screenerSchema = z.object({
  // Filtros de segmento
  segment: z.string().optional(),
  // Filtros numéricos (gte = greater than or equal, lte = less than or equal)
  pvp_lte: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  pvp_gte: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  dy_gte: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  dy_lte: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  liquidity_gte: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)).pipe(z.number().min(0).optional()),
  // Classificação derivada (do score/balanço)
  classification: z.enum(['tijolo', 'papel', 'hibrido', 'fundo_de_fundos']).optional(),
  // Ordenação
  sort: z.enum(['dy', 'pvp', 'price', 'liquidity', 'ticker']).default('dy'),
  order: z.enum(['asc', 'desc']).default('desc'),
  // Paginação
  limit: z.string().optional().default('20').transform(Number).pipe(z.number().int().min(1).max(50)),
  offset: z.string().optional().default('0').transform(Number).pipe(z.number().int().min(0)),
  // Cache
  refresh: z.string().optional().default('false').transform((v) => v === 'true'),
});

export interface FiiScreenerResult {
  ticker: string;
  name: string;
  segment: string;
  price: number | null;
  dy: number | null;          // % a.a.
  pvp: number | null;
  liquidity: number | null;   // volume financeiro diário
  classification?: string;     // tijolo, papel, hibrido, fundo_de_fundos
}

/**
 * GET /v1/fiis/screener
 *
 * Filtra FIIs por métricas fundamentalistas específicas de fundos imobiliários.
 * Ex: ?pvp_lte=1&dy_gte=8&sort=dy&order=desc&limit=10
 *
 * Cache Redis 5 min (refresh=true ignora cache).
 */
// ─── Operational Data ────────────────────────────────────────────────────────

/**
 * GET /v1/fiis/:ticker/operational
 *
 * Retorna dados operacionais completos do FII:
 * composição de ativos, vacância, inadimplência, principais imóveis,
 * concentração de inquilinos, administrador, e métricas de mercado.
 *
 * Cache Redis 1h (dados operacionais mudam mensalmente).
 */
export async function getFiiOperationalController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Ticker inválido.');
  const { ticker } = parsed.data;

  try {
    const data = await fiiOperationalService.fetchOperationalData(ticker);
    reply.send(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'OperationalDataUnavailable',
      message: `Dados operacionais indisponíveis para "${ticker}". ${message}`,
    });
  }
}

export async function fiiScreenerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = screenerSchema.safeParse(request.query);
  if (!parsed.success) return sendZodError(reply, parsed.error, 'Query inválida.');

  const filters = parsed.data;

  // Cache key (ignora refresh param)
  const cacheKey = `fiis:screener:${JSON.stringify({ ...filters, refresh: undefined })}`;

  if (!filters.refresh) {
    try {
      const cached = await getOrSet(cacheKey, 300, async () => {
        return JSON.stringify(await buildScreenerResult(KNOWN_FIIS, filters));
      });
      reply.send(JSON.parse(cached));
      return;
    } catch {
      /* Redis offline — segue sem cache */
    }
  }

  try {
    const result = await buildScreenerResult(KNOWN_FIIS, filters);
    reply.send(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.status(502).send({
      error: 'ScreenerUnavailable',
      message: `Falha ao executar screener de FIIs. ${message}`,
    });
  }
}

/** Constrói o resultado do screener com dados de múltiplas fontes */
async function buildScreenerResult(
  fiis: FiiBasic[],
  filters: z.infer<typeof screenerSchema>,
) {
  // 1. Filtra por metadata (segmento)
  let candidates = fiis;
  if (filters.segment) {
    const seg = filters.segment.toLowerCase();
    candidates = candidates.filter((f) => f.segment.toLowerCase().includes(seg));
  }

  if (candidates.length === 0) {
    return { filters: { ...filters, refresh: undefined }, total: 0, data: [] };
  }

  // 2. Busca dados de mercado em paralelo (cotação + scraper)
  const enriched: FiiScreenerResult[] = await batchWithConcurrency(
    candidates,
    async (fii) => {
      const result: FiiScreenerResult = {
        ticker: fii.ticker,
        name: fii.name,
        segment: fii.segment,
        price: null,
        dy: null,
        pvp: null,
        liquidity: null,
      };

      // Cotação + liquidez (Yahoo)
      try {
        const quote = await stockQuoteService.getQuote(fii.ticker);
        result.price = quote.price;
        result.liquidity = quote.volume * quote.price;
      } catch { /* ok */ }

      // P/VP, DY, classificação (scraper ou cache Redis)
      try {
        const scraped = await fiisScraper.fetchFII(fii.ticker);
        if (scraped.pvp > 0) result.pvp = scraped.pvp;
        if (scraped.dy12m > 0) result.dy = scraped.dy12m;
        result.classification = scraped.category;
      } catch { /* ok */ }

      // Fallback DY: calcula dos proventos se scraper falhou
      if (result.dy === null) {
        try {
          const proventos = await dividendsProvider.fetchDividends(fii.ticker);
          if (proventos && proventos.length > 0 && result.price && result.price > 0) {
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - 12);
            const cutoffStr = cutoff.toISOString().slice(0, 10);
            const sum12m = proventos
              .filter((e) => e.date >= cutoffStr)
              .reduce((s, e) => s + e.value, 0);
            if (sum12m > 0) {
              result.dy = +((sum12m / result.price) * 100).toFixed(2);
            }
          }
        } catch { /* ok */ }
      }

      return result;
    },
    3, // concorrência limitada para respeitar rate limit do scraper
  );

  // 3. Aplica filtros numéricos
  let filtered = enriched;

  if (filters.pvp_gte !== undefined) {
    filtered = filtered.filter((f) => f.pvp !== null && f.pvp >= filters.pvp_gte!);
  }
  if (filters.pvp_lte !== undefined) {
    filtered = filtered.filter((f) => f.pvp !== null && f.pvp <= filters.pvp_lte!);
  }
  if (filters.dy_gte !== undefined) {
    filtered = filtered.filter((f) => f.dy !== null && f.dy >= filters.dy_gte!);
  }
  if (filters.dy_lte !== undefined) {
    filtered = filtered.filter((f) => f.dy !== null && f.dy <= filters.dy_lte!);
  }
  if (filters.liquidity_gte !== undefined) {
    filtered = filtered.filter((f) => f.liquidity !== null && f.liquidity >= filters.liquidity_gte!);
  }
  if (filters.classification) {
    filtered = filtered.filter((f) => f.classification === filters.classification);
  }

  // 4. Ordena
  const sortKey = filters.sort;
  const sortOrder = filters.order === 'asc' ? 1 : -1;

  filtered.sort((a, b) => {
    const va = a[sortKey] ?? (sortOrder === 1 ? Infinity : -Infinity);
    const vb = b[sortKey] ?? (sortOrder === 1 ? Infinity : -Infinity);
    if (va === vb) return 0;
    return (va as number) > (vb as number) ? sortOrder : -sortOrder;
  });

  // 5. Pagina
  const total = filtered.length;
  const paged = filtered.slice(filters.offset, filters.offset + filters.limit);

  return {
    filters: {
      segment: filters.segment ?? null,
      pvp_gte: filters.pvp_gte ?? null,
      pvp_lte: filters.pvp_lte ?? null,
      dy_gte: filters.dy_gte ?? null,
      dy_lte: filters.dy_lte ?? null,
      liquidity_gte: filters.liquidity_gte ?? null,
      classification: filters.classification ?? null,
      sort: filters.sort,
      order: filters.order,
      limit: filters.limit,
      offset: filters.offset,
    },
    total,
    data: paged,
  };
}
