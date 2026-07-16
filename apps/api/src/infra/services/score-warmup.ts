/**
 * Score Warmup Service — Pré-aquece o cache de scores e rankings.
 *
 * Chamado pelo worker após ciclos de scraping para garantir que
 * o primeiro acesso ao ranking/search já encontre os dados no Redis,
 * sem precisar calcular tudo on-the-fly.
 *
 * Estratégia:
 *  - Cache individual:  score:stock:PETR4 → 1h TTL
 *
 * O warmup calcula scores individuais após cada scraping e
 * não publica rankings canônicos: o cálculo individual não possui todos os
 * inputs usados pelo endpoint de ranking.
 */

import { sql } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { stockQuoteService } from './stock-quote-service.ts';
import { dividendsProvider } from './dividends-provider.ts';
import { calcAllIndicators } from '../../core/services/indicators.ts';
import { StockScoreCalculator } from '../../core/services/stock-score.ts';
import { FIIScoreCalculatorV4 } from '../../core/services/fii-score.ts';
import {
  incomeDistributionsSince,
  sumIncomeDistributions,
} from '../../core/services/dividend-income.ts';
import { refreshCanonicalDecisionUniverseIfNeeded } from '../../core/services/allocation-engine.ts';
import { batchWithConcurrency } from '../../shared/retry.ts';
import { isFii } from '../../shared/ticker-utils.ts';
import { redis } from './redis.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface CachedScore {
  ticker: string;
  name: string;
  type: 'stock' | 'fii';
  score: number;
  price: number;
  updatedAt: string;
}

export interface WarmupResult {
  stocks: { total: number; cached: number; failed: number };
  fiis: { total: number; cached: number; failed: number };
  rankingUpdated: boolean;
  elapsedMs: number;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const SCORE_TTL = 3600; // 1 hora para scores individuais
// Concorrência 1: StatusInvest só aguenta ~0.5 req/s; paralelismo vira 429 em cascata
const CONCURRENCY = 1;

// ─── Service ─────────────────────────────────────────────────────────────────

export class ScoreWarmupService {
  /**
   * Calcula e armazena o score de UM ticker (chamado pelo worker após scraping).
   */
  async warmupSingle(ticker: string, assetType: 'stock' | 'fii'): Promise<boolean> {
    const cacheKey = `score:${assetType}:${ticker.toUpperCase()}`;

    try {
      // Evita recomputar se o cache ainda está fresco (80% do TTL)
      const existing = await redis.get(cacheKey);
      if (existing) {
        const parsed = JSON.parse(existing) as CachedScore;
        const age = Date.now() - new Date(parsed.updatedAt).getTime();
        if (age < SCORE_TTL * 0.8 * 1000) {
          return true; // Cache ainda quente, não precisa recalcular
        }
      }
    } catch { /* segue */ }

    try {
      let score: number;
      let name = ticker;
      let price = 0;

      if (assetType === 'stock') {
        const result = await this.computeStockScore(ticker);
        if (!result) return false;
        score = result.score;
        name = result.name;
        price = result.price;
      } else {
        const result = await this.computeFIIScore(ticker);
        if (!result) return false;
        score = result.score;
        name = result.name;
        price = result.price;
      }

      const cached: CachedScore = {
        ticker: ticker.toUpperCase(),
        name,
        type: assetType,
        score: Math.round(score),
        price: Math.round(price * 100) / 100,
        updatedAt: new Date().toISOString(),
      };

      await redis.setex(cacheKey, SCORE_TTL, JSON.stringify(cached));
      return true;
    } catch (error) {
      console.warn(
        `[warmup] Falha ao aquecer ${assetType}:${ticker.toUpperCase()}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Warmup COMPLETO: recalcula scores de TODOS os tickers e atualiza o ranking.
   *
   * Chamado periodicamente (ex: a cada 30 min) ou após batch de scraping.
   */
  async warmupAll(): Promise<WarmupResult> {
    const start = Date.now();
    const result: WarmupResult = {
      stocks: { total: 0, cached: 0, failed: 0 },
      fiis: { total: 0, cached: 0, failed: 0 },
      rankingUpdated: false,
      elapsedMs: 0,
    };

    try {
      // Busca todos os tickers do banco
      const rows = await db.execute(sql`
        SELECT ticker, name FROM companies ORDER BY ticker
      `);

      const allTickers = rows as unknown as { ticker: string; name: string }[];
      if (allTickers.length === 0) {
        result.elapsedMs = Date.now() - start;
        return result;
      }

      // Separa stocks e FIIs
      const stocks = allTickers.filter((r) => !isFii(r.ticker));
      const fiis = allTickers.filter((r) => isFii(r.ticker));

      result.stocks.total = stocks.length;
      result.fiis.total = fiis.length;

      console.log(
        `[warmup] Iniciando warmup de ${stocks.length} ações + ${fiis.length} FIIs...`,
      );

      // Warmup de ações em batch
      if (stocks.length > 0) {
        await batchWithConcurrency(
          stocks,
          async (row) => {
            try {
              const cached = await this.warmupSingle(row.ticker, 'stock');
              if (cached) result.stocks.cached++;
              else result.stocks.failed++;
            } catch {
              result.stocks.failed++;
            }
          },
          CONCURRENCY,
        );
      }

      // Warmup de FIIs em batch
      if (fiis.length > 0) {
        await batchWithConcurrency(
          fiis,
          async (row) => {
            try {
              const cached = await this.warmupSingle(row.ticker, 'fii');
              if (cached) result.fiis.cached++;
              else result.fiis.failed++;
            } catch {
              result.fiis.failed++;
            }
          },
          CONCURRENCY,
        );
      }

      // Snapshot completo para endpoints de decisao. A atualizacao roda no
      // worker, nunca no request HTTP, e preserva o cache anterior se falhar.
      await refreshCanonicalDecisionUniverseIfNeeded();
      result.rankingUpdated = true;

      result.elapsedMs = Date.now() - start;
      console.log(
        `[warmup] ✅ Concluído em ${(result.elapsedMs / 1000).toFixed(1)}s: ` +
          `${result.stocks.cached} ações, ${result.fiis.cached} FIIs`,
      );
    } catch (err) {
      console.error('[warmup] ❌ Erro:', (err as Error).message);
      result.elapsedMs = Date.now() - start;
      // Falha sistêmica (por exemplo, banco indisponível) precisa chegar ao
      // worker; retornar contadores zerados faria o job parecer bem-sucedido.
      throw err;
    }

    return result;
  }

  // ─── Cálculo de Scores Individuais ─────────────────────────────────────

  private async computeStockScore(
    ticker: string,
  ): Promise<{ score: number; name: string; price: number } | null> {
    // Busca fundamentals do banco
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (c.ticker)
        c.ticker, c.name, c.sector,
        cf.net_income_parent, cf.equity, cf.revenue, cf.reference_date
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE c.ticker = ${ticker.toUpperCase()}
      ORDER BY c.ticker, cf.source = 'DFP' DESC, cf.reference_date DESC
      LIMIT 1
    `);

    const data = (rows as unknown as Record<string, unknown>[])[0];

    // Cotação
    let price = 0;
    try {
      const q = await stockQuoteService.getQuote(ticker);
      price = q.price;
    } catch {
      // Tenta Redis direto
      try {
        const cached = await redis.get(`quote:${ticker.toUpperCase()}`);
        if (cached) {
          const q = JSON.parse(cached) as { price: number };
          price = q.price;
        }
      } catch { /* ok */ }
    }
    if (price <= 0) return null;

    // Se tem fundamentals, usa StockScore completo
    if (data && data.net_income_parent !== null) {
      const indicators = calcAllIndicators(data, price);

      // DY
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date();
          cutoff.setMonth(cutoff.getMonth() - 12);
          const c = cutoff.toISOString().slice(0, 10);
          const sum12m = sumIncomeDistributions(
            incomeDistributionsSince(proventos, c),
          );
          if (sum12m > 0) {
            indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
          }
        }
      } catch { /* ok */ }

      const result = StockScoreCalculator.calculate(
        indicators,
        (data.sector as string) || null,
        String(data.name),
      );

      return {
        score: result.score,
        name: String(data.name || ticker),
        price,
      };
    }

    // Sem fundamentals: score baseado apenas em cotação + dividendos
    let dy = 0;
    try {
      const proventos = await dividendsProvider.fetchDividends(ticker);
      if (proventos && price > 0) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 12);
        const c = cutoff.toISOString().slice(0, 10);
        const sum12m = sumIncomeDistributions(
          incomeDistributionsSince(proventos, c),
        );
        if (sum12m > 0) dy = +(sum12m / price * 100).toFixed(2);
      }
    } catch { /* ok */ }

    // Score simplificado (sem fundamentals, só cotação + DY)
    const baseScore = 50;
    const dyBonus = Math.min(dy * 4, 20); // até 5% DY = +20 pontos
    const score = Math.min(100, Math.round(baseScore + dyBonus));

    return {
      score,
      name: String(data?.name || ticker),
      price,
    };
  }

  private async computeFIIScore(
    ticker: string,
  ): Promise<{ score: number; name: string; price: number } | null> {
    let price = 0;
    let liquidity: number | null = null;

    try {
      const q = await stockQuoteService.getQuote(ticker);
      price = q.price;
      liquidity = q.volume > 0 && q.price > 0 ? q.volume * q.price : null;
    } catch { return null; }
    if (price <= 0) return null;

    let dy = 0;
    const dividendEvents: Array<{ date: string; value: number; type: string }> = [];
    try {
      const proventos = await dividendsProvider.fetchDividends(ticker);
      if (proventos && price > 0) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 12);
        const c = cutoff.toISOString().slice(0, 10);
        const recent = incomeDistributionsSince(proventos, c);
        for (const e of recent) {
          dividendEvents.push({ date: e.date, value: e.value, type: e.type || 'Rendimento' });
        }
        const sum12m = sumIncomeDistributions(recent);
        if (sum12m > 0) dy = +(sum12m / price * 100).toFixed(2);
      }
    } catch { /* ok */ }

    // Busca P/VP do Redis (cache do worker)
    let pvp: number | null = null;
    try {
      const cachedPvp = await redis.get(`fii:pvp:${ticker.toUpperCase()}`);
      if (cachedPvp) pvp = parseFloat(cachedPvp);
    } catch { /* ok */ }

    let name = ticker;
    try {
      const fullData = await redis.get(`fii:full:${ticker.toUpperCase()}`);
      if (fullData) {
        const parsed = JSON.parse(fullData) as { name?: string };
        if (parsed.name) name = parsed.name;
      }
    } catch { /* ok */ }

    const score = FIIScoreCalculatorV4.calculate({
      ticker: ticker.toUpperCase(),
      price,
      dy,
      pvp,
      liquidity,
      dividendsHistory: dividendEvents,
    });

    return {
      score: score.overall_score,
      name,
      price,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const scoreWarmup = new ScoreWarmupService();
