import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrSet } from '../../services/redis.ts';

/**
 * Indicadores macroeconômicos do Brasil.
 * Fonte: API pública do Banco Central do Brasil (BCB).
 *
 * Séries temporais disponíveis:
 *   432  - Taxa de juros - Selic acumulada no mês (% a.m.)
 *   4189 - Taxa de juros - Selic acumulada no ano (% a.a.)
 *   433  - IPCA - variação mensal (%)
 *   13522- IPCA - variação acumulada em 12 meses (%)
 *   4389 - PIB - valor corrente (R$ milhões)
 *   1    - Taxa de câmbio - R$ / US$ (venda, fim de período)
 *
 * Cache Redis de 1 hora para indicadores macro (mudam pouco).
 */

interface MacroSeriesPoint {
  date: string;
  value: number;
}

interface MacroSeries {
  code: string;
  name: string;
  unit: string;
  latest: MacroSeriesPoint;
  history: MacroSeriesPoint[];
}

const MACRO_SERIES: Record<string, { name: string; unit: string }> = {
  '432': { name: 'SELIC (% a.m.)', unit: '%' },
  '4189': { name: 'SELIC (% a.a.)', unit: '%' },
  '433': { name: 'IPCA (% mensal)', unit: '%' },
  '13522': { name: 'IPCA 12 meses (%)', unit: '%' },
  '4389': { name: 'PIB (R$ milhões)', unit: 'BRL' },
  '1': { name: 'Câmbio USD/BRL', unit: 'BRL' },
};

async function fetchBcbSeries(code: string, limit = 12): Promise<MacroSeriesPoint[]> {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`BCB HTTP ${response.status}`);
    const data = (await response.json()) as Array<{ data: string; valor: string }>;
    return data.slice(-limit).map((d) => ({
      date: d.data,
      value: parseFloat(d.valor),
    }));
  } catch {
    return [];
  }
}

/**
 * GET /v1/macro
 * Lista todos os indicadores macro disponíveis com último valor.
 */
export async function listMacroController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cacheKey = 'macro:index';

  const indicators = await getOrSet(cacheKey, 3600, async () => {
    const results: Array<{ code: string; name: string; latest: MacroSeriesPoint | null }> = [];
    for (const [code, info] of Object.entries(MACRO_SERIES)) {
      const points = await fetchBcbSeries(code, 1);
      results.push({
        code,
        name: info.name,
        latest: points[0] ?? null,
      });
    }
    return results;
  });

  reply.send({ total: indicators.length, data: indicators });
}

/**
 * GET /v1/macro/:series
 * Retorna série histórica completa de um indicador macro.
 */
export async function getMacroSeriesController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { series } = z.object({ series: z.string() }).parse(request.params);

  const info = MACRO_SERIES[series];
  if (!info) {
    reply.status(404).send({
      error: 'NotFound',
      message: `Série "${series}" não encontrada. Códigos disponíveis: ${Object.keys(MACRO_SERIES).join(', ')}`,
    });
    return;
  }

  const { limit } = z.object({
    limit: z.string().optional().default('12').transform(Number).pipe(z.number().int().min(1).max(60)),
  }).parse(request.query);

  const cacheKey = `macro:${series}:${limit}`;
  const history = await getOrSet(cacheKey, 3600, () => fetchBcbSeries(series, limit));

  const latest = history[history.length - 1] ?? null;

  reply.send({
    code: series,
    name: info.name,
    unit: info.unit,
    latest,
    total: history.length,
    history,
  });
}
