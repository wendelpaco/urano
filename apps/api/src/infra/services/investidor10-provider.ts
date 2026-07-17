/**
 * Investidor10Provider — cotação e histórico via JSON público do site.
 *
 * Primária de *mercado* (preço/série), não de fundamentals (CVM mensal).
 *
 * Endpoints usados:
 *  - GET /api/cotacoes/batch?tickers=A,B
 *  - GET /api/cotacoes/acao/chart/{TICKER}/
 *  - GET /api/quotations/one-day/{TICKER}/  (opcional, enriquecimento)
 *
 * Rate limit + circuit breaker compartilhados com o resto da app.
 */

import { RateLimitError } from '../../shared/retry.ts';
import { investidor10Limiter } from './rate-limiter.ts';
import {
  investidor10CircuitBreaker,
  CircuitOpenError,
} from './circuit-breaker.ts';
import { readBodyWithCap } from '../../shared/safe-fetch.ts';

export type I10QuoteHit = {
  ticker: string;
  price: number;
  lastUpdate: string | null;
};

export type I10ChartPoint = {
  /** ISO date YYYY-MM-DD */
  date: string;
  close: number;
};

const BASE = 'https://investidor10.com.br';
const UA =
  'Mozilla/5.0 (compatible; Urano-FinBot/0.1; +https://github.com/local/urano)';

function headers(ticker?: string): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: ticker
      ? `${BASE}/acoes/${ticker.toLowerCase()}/`
      : `${BASE}/`,
  };
}

/** "14/07/2025 00:00" | "2026-07-15 17:46:00" → ISO date or full ISO when time present */
function parseI10DateTime(raw: string): { date: string; asOf: string } {
  const s = raw.trim();
  // DD/MM/YYYY[ HH:MM[:SS]]
  const br = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (br) {
    const dd = br[1]!;
    const mm = br[2]!;
    const yyyy = br[3]!;
    const hh = br[4] ?? '00';
    const mi = br[5] ?? '00';
    const ss = br[6] ?? '00';
    const date = `${yyyy}-${mm}-${dd}`;
    return { date, asOf: `${date}T${hh}:${mi}:${ss}-03:00` };
  }
  // YYYY-MM-DD HH:MM:SS
  const iso = s.match(
    /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (iso) {
    const date = iso[1]!;
    const hh = iso[2] ?? '00';
    const mi = iso[3] ?? '00';
    const ss = iso[4] ?? '00';
    return { date, asOf: `${date}T${hh}:${mi}:${ss}-03:00` };
  }
  // fallback
  const d = s.slice(0, 10);
  return { date: d, asOf: new Date().toISOString() };
}

export class Investidor10Provider {
  /**
   * Cotação em lote. Mais eficiente que N requests no warmup/alocação.
   * Tickers sem preço no payload são omitidos do Map.
   */
  async getBatchQuotes(tickers: string[]): Promise<Map<string, I10QuoteHit>> {
    const clean = [
      ...new Set(
        tickers
          .map((t) => t.toUpperCase().trim())
          .filter((t) => t.length >= 4),
      ),
    ];
    const out = new Map<string, I10QuoteHit>();
    if (clean.length === 0) return out;

    // API aceita lista; fatia para não estourar URL
    const chunkSize = 40;
    for (let i = 0; i < clean.length; i += chunkSize) {
      const chunk = clean.slice(i, i + chunkSize);
      const part = await this.fetchBatchChunk(chunk);
      for (const [k, v] of part) out.set(k, v);
    }
    return out;
  }

  async getQuote(ticker: string): Promise<I10QuoteHit> {
    const map = await this.getBatchQuotes([ticker]);
    const hit = map.get(ticker.toUpperCase());
    if (!hit || !(hit.price > 0)) {
      throw new Error(`Investidor10: preço indisponível para ${ticker}`);
    }
    return hit;
  }

  /**
   * Série diária (close). O endpoint costuma devolver ~1y de pontos em BRL.
   * `real` = BRL; ignoramos dolar/euro no caminho crítico.
   */
  async getDailyChart(ticker: string): Promise<I10ChartPoint[]> {
    const upper = ticker.toUpperCase();
    await investidor10CircuitBreaker.beforeRequest();
    await investidor10Limiter.acquire();

    const url = `${BASE}/api/cotacoes/acao/chart/${encodeURIComponent(upper)}/`;
    try {
      const res = await fetch(url, { headers: headers(upper), redirect: 'error' });
      if (res.status === 429) {
        const sec = parseInt(res.headers.get('Retry-After') ?? '15', 10) || 15;
        investidor10Limiter.penalize(sec * 1000);
        await investidor10CircuitBreaker.onFailure(
          'rate-limit',
          `I10 chart 429 ${upper}`,
        );
        throw new RateLimitError(`Investidor10 HTTP 429 (chart ${upper})`, sec * 1000);
      }
      if (!res.ok) {
        if (res.status >= 500) {
          await investidor10CircuitBreaker.onFailure(
            'server-error',
            `I10 chart HTTP ${res.status}`,
          );
        }
        throw new Error(`Investidor10 chart HTTP ${res.status} para ${upper}`);
      }

      // SSRF-1r: leitura streaming com teto de 2 MiB.
      const raw = await readBodyWithCap(res, 2 * 1024 * 1024);
      const data = JSON.parse(raw) as {
        real?: Array<{ price: number; created_at: string }>;
      };
      const series = data.real ?? [];
      const points: I10ChartPoint[] = [];
      for (const p of series) {
        if (!(typeof p.price === 'number' && p.price > 0) || !p.created_at) continue;
        const { date } = parseI10DateTime(p.created_at);
        points.push({ date, close: p.price });
      }
      // dedup por data (fica o último do dia)
      const byDate = new Map<string, number>();
      for (const p of points) byDate.set(p.date, p.close);
      const ordered = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, close]) => ({ date, close }));

      if (ordered.length === 0) {
        throw new Error(`Investidor10 chart vazio para ${upper}`);
      }

      await investidor10CircuitBreaker.onSuccess();
      return ordered;
    } catch (err) {
      if (err instanceof CircuitOpenError || err instanceof RateLimitError) throw err;
      if (err instanceof Error && !err.message.includes('HTTP')) {
        await investidor10CircuitBreaker.onFailure('network-error', err.message);
      }
      throw err;
    }
  }

  /**
   * Vacância física de FII via página HTML (StatusInvest não publica esse
   * indicador para a maioria dos fundos; Investidor10 é fallback gratuito).
   */
  async getFiiVacancy(ticker: string): Promise<number | null> {
    const upper = ticker.toUpperCase();
    await investidor10CircuitBreaker.beforeRequest();
    await investidor10Limiter.acquire();

    const url = `${BASE}/fiis/${upper.toLowerCase()}/`;
    try {
      const res = await fetch(url, { headers: headers(upper), redirect: 'error' });
      if (res.status === 429) {
        const sec = parseInt(res.headers.get('Retry-After') ?? '15', 10) || 15;
        investidor10Limiter.penalize(sec * 1000);
        await investidor10CircuitBreaker.onFailure('rate-limit', 'I10 fii-page 429');
        throw new RateLimitError(`Investidor10 HTTP 429 (fii ${upper})`, sec * 1000);
      }
      if (!res.ok) {
        if (res.status >= 500) {
          await investidor10CircuitBreaker.onFailure(
            'server-error',
            `I10 fii-page HTTP ${res.status}`,
          );
        }
        await investidor10CircuitBreaker.onSuccess();
        return null;
      }

      // SSRF-1r: leitura streaming com teto de 2 MiB.
      const html = await readBodyWithCap(res, 2 * 1024 * 1024);
      const m = html.match(/VAC[ÂA]NCIA.*?<div class="value">\s*<span>\s*([\d,.]+)\s*%/is);
      await investidor10CircuitBreaker.onSuccess();
      if (!m) return null;
      const pct = parseFloat(m[1]!.replace(',', '.'));
      return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
    } catch (err) {
      if (err instanceof CircuitOpenError || err instanceof RateLimitError) throw err;
      if (err instanceof Error && !err.message.includes('HTTP')) {
        await investidor10CircuitBreaker.onFailure('network-error', err.message);
      }
      return null;
    }
  }

  private async fetchBatchChunk(
    tickers: string[],
  ): Promise<Map<string, I10QuoteHit>> {
    const out = new Map<string, I10QuoteHit>();
    await investidor10CircuitBreaker.beforeRequest();
    await investidor10Limiter.acquire();

    const url = `${BASE}/api/cotacoes/batch?tickers=${encodeURIComponent(tickers.join(','))}`;
    try {
      const res = await fetch(url, { headers: headers(tickers[0]), redirect: 'error' });
      if (res.status === 429) {
        const sec = parseInt(res.headers.get('Retry-After') ?? '15', 10) || 15;
        investidor10Limiter.penalize(sec * 1000);
        await investidor10CircuitBreaker.onFailure('rate-limit', 'I10 batch 429');
        throw new RateLimitError('Investidor10 HTTP 429 (batch)', sec * 1000);
      }
      if (!res.ok) {
        if (res.status >= 500) {
          await investidor10CircuitBreaker.onFailure(
            'server-error',
            `I10 batch HTTP ${res.status}`,
          );
        }
        throw new Error(`Investidor10 batch HTTP ${res.status}`);
      }

      // SSRF-1r: leitura streaming com teto de 2 MiB.
      const rawBatch = await readBodyWithCap(res, 2 * 1024 * 1024);
      const data = JSON.parse(rawBatch) as Record<
        string,
        { price?: number; last_update?: string }
      >;
      for (const [rawTicker, body] of Object.entries(data ?? {})) {
        const ticker = rawTicker.toUpperCase();
        const price = Number(body?.price);
        if (!(price > 0)) continue;
        out.set(ticker, {
          ticker,
          price,
          lastUpdate: body.last_update ?? null,
        });
      }

      await investidor10CircuitBreaker.onSuccess();
      return out;
    } catch (err) {
      if (err instanceof CircuitOpenError || err instanceof RateLimitError) throw err;
      if (err instanceof Error && !err.message.includes('HTTP')) {
        await investidor10CircuitBreaker.onFailure('network-error', err.message);
      }
      throw err;
    }
  }
}

export const investidor10Provider = new Investidor10Provider();

/** Exposto para testes unitários de parse de data. */
export const _test = { parseI10DateTime };
