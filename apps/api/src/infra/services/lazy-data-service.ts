/**
 * Lazy Data Service — Busca dados sob demanda quando não estão em cache.
 *
 * Se um ticker não tem dados no Redis ou PostgreSQL, este serviço
 * dispara o scraping imediatamente e retorna os dados, garantindo
 * que o usuário nunca veja uma página vazia.
 *
 * Fluxo:
 *  1. Verifica Redis (cache rápido)
 *  2. Verifica PostgreSQL (dados persistidos)
 *  3. Se não encontrou → dispara scraper (StatusInvest + Yahoo)
 *  4. Persiste no PostgreSQL + Redis para próximas consultas
 *  5. Retorna os dados
 */

import { statusInvestScraper } from './statusinvest-scraper.ts';
import { stockQuoteService } from './stock-quote-service.ts';
import { scoreWarmup, type CachedScore } from './score-warmup.ts';
import { redis } from './redis.ts';
import { sql } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { companies } from '../database/schema.ts';
import { getAssetType } from '../../shared/ticker-utils.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface LazyAssetData {
  ticker: string;
  name: string;
  type: 'stock' | 'fii';
  price: number;
  change: number;
  changePct: number;
  score: number;
  sector: string | null;
  // Métricas rápidas (disponíveis via StatusInvest)
  dy?: number;
  pl?: number;
  pvp?: number;
  roe?: number;
  // FII-specific
  category?: string;
  bookValue?: number;
  // Metadata
  source: 'cache' | 'scraped';
  updatedAt: string;
}

export interface LazySearchResult {
  query: string;
  results: LazyAssetData[];
  source: 'cache' | 'scraped' | 'live_scrape';
  totalMs: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class LazyDataService {
  /**
   * Busca dados de um ticker — cachê primeiro, scraping se necessário.
   */
  async getAssetData(ticker: string): Promise<LazyAssetData | null> {
    const t = ticker.toUpperCase().trim();
    if (!t || t.length < 4) return null;

    const type = getAssetType(t);

    // 1. Tenta cache Redis (score individual)
    const cacheKey = `score:${type}:${t}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedScore;
        // UX-3: busca cotação para changePct real (quote service tem cache 120s)
        let changePct: number | null = parsed.changePct ?? null;
        try {
          if (changePct == null) {
            const q = await stockQuoteService.getQuote(t);
            changePct = q.changePercent ?? null;
          }
        } catch { /* ok */ }
        return {
          ticker: t,
          name: parsed.name,
          type: parsed.type,
          price: parsed.price,
          change: 0,
          changePct: changePct ?? 0,
          score: parsed.score,
          sector: null,
          source: 'cache',
          updatedAt: parsed.updatedAt,
        };
      }
    } catch { /* segue */ }

    // 2. Tenta PostgreSQL
    const dbData = await this.fetchFromDb(t, type);
    if (dbData) return dbData;

    // 3. Scraping ao vivo!
    console.log(`[lazy] 🔍 Scraping ao vivo: ${t} (${type})...`);
    return await this.scrapeAndPersist(t, type);
  }

  /**
   * Busca múltiplos tickers (para search/ranking).
   * Tickters não encontrados disparam scraping.
   */
  async searchAssets(query: string): Promise<LazySearchResult> {
    const start = Date.now();
    const needle = query.toUpperCase().trim();

    // Se parece com um ticker (4-6 letras), busca exata + scraping
    const looksLikeTicker = /^[A-Z]{4}\d{1,2}$/.test(needle);

    if (looksLikeTicker) {
      // Busca direta pelo ticker
      const data = await this.getAssetData(needle);
      if (data) {
        return {
          query: needle,
          results: [data],
          source: data.source,
          totalMs: Date.now() - start,
        };
      }
    }

    // Busca textual no PostgreSQL (por nome ou ticker parcial)
    const rows = await db.execute(sql`
      SELECT ticker, name, sector FROM companies
      WHERE UPPER(ticker) LIKE ${`%${needle}%`}
         OR UPPER(name) LIKE ${`%${needle}%`}
      ORDER BY
        CASE WHEN UPPER(ticker) = ${needle} THEN 0
             WHEN UPPER(ticker) LIKE ${needle || ''}  THEN 1
             ELSE 2
        END,
        ticker
      LIMIT 20
    `);

    const dbResults = rows as unknown as { ticker: string; name: string; sector: string | null }[];

    if (dbResults.length > 0) {
      const results: LazyAssetData[] = [];
      for (const row of dbResults) {
        const data = await this.enrichFromCache(row.ticker, row.name, row.sector);
        if (data) results.push(data);
      }

      if (results.length > 0) {
        return {
          query: needle,
          results,
          source: 'cache',
          totalMs: Date.now() - start,
        };
      }
    }

    // Nada encontrado: sugere scraping se parece ticker
    if (looksLikeTicker) {
      return {
        query: needle,
        results: [],
        source: 'live_scrape',
        totalMs: Date.now() - start,
      };
    }

    return { query: needle, results: [], source: 'cache', totalMs: Date.now() - start };
  }

  /**
   * Garante que um ticker tenha dados, disparando scraping se necessário.
   * Não retorna nada — apenas popula o cache. Útil para pre-fetch.
   */
  async ensureData(ticker: string): Promise<void> {
    await this.getAssetData(ticker);
  }

  // ─── Privados ──────────────────────────────────────────────────────────

  private async fetchFromDb(ticker: string, _type: 'stock' | 'fii'): Promise<LazyAssetData | null> {
    try {
      const rows = await db.execute(sql`
        SELECT ticker, name, sector FROM companies
        WHERE UPPER(ticker) = ${ticker.toUpperCase()}
        LIMIT 1
      `);

      const company = (rows as unknown as { ticker: string; name: string; sector: string | null }[])[0];
      if (!company) return null;

      return await this.enrichFromCache(company.ticker, company.name, company.sector);
    } catch {
      return null;
    }
  }

  private async enrichFromCache(
    ticker: string,
    name: string,
    sector: string | null,
  ): Promise<LazyAssetData | null> {
    const type = getAssetType(ticker);

    // Score do cache Redis
    let score = 0;
    try {
      const cacheKey = `score:${type}:${ticker.toUpperCase()}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedScore;
        score = parsed.score;
      }
    } catch { /* ok */ }

    // Cotação
    let price = 0;
    let change = 0;
    let changePct = 0;
    try {
      const quote = await stockQuoteService.getQuote(ticker);
      price = quote.price;
      change = quote.change;
      changePct = quote.changePercent;
    } catch { /* ok */ }

    if (price <= 0) return null;

    return {
      ticker: ticker.toUpperCase(),
      name,
      type,
      price,
      change,
      changePct,
      score,
      sector,
      source: 'cache',
      updatedAt: new Date().toISOString(),
    };
  }

  private async scrapeAndPersist(ticker: string, type: 'stock' | 'fii'): Promise<LazyAssetData | null> {
    const start = Date.now();

    try {
      if (type === 'stock') {
        const data = await statusInvestScraper.fetchStock(ticker);

        // Persiste no PostgreSQL
        // Synthetic identifiers must still fit companies.cnpj CHAR(14).
        // `STK` also keeps the value visibly non-CNPJ until CVM replaces it.
        const placeholderCnpj = `STK${ticker.toUpperCase().padEnd(11, '0').slice(0, 11)}`;
        await db
          .insert(companies)
          .values({
            cnpj: placeholderCnpj,
            ticker: ticker.toUpperCase(),
            name: data.name || ticker.toUpperCase(),
            sector: data.sector || null,
          })
          .onConflictDoUpdate({
            target: companies.ticker,
            set: { name: data.name, sector: data.sector || null, updatedAt: new Date() },
          });

        // Cache no Redis
        await scoreWarmup.warmupSingle(ticker, 'stock').catch(() => {});

        console.log(`[lazy] ✅ ${ticker} scraped em ${Date.now() - start}ms`);

        return {
          ticker: ticker.toUpperCase(),
          name: data.name || ticker,
          type: 'stock',
          price: data.price,
          change: 0,
          changePct: 0,
          score: 50, // score básico até warmup calcular
          sector: data.sector || null,
          dy: data.dy12m,
          pl: data.pl,
          pvp: data.pvp,
          roe: data.roe,
          source: 'scraped',
          updatedAt: new Date().toISOString(),
        };
      } else {
        const data = await statusInvestScraper.fetchFII(ticker);

        const fakeCnpj = `FII${ticker.toUpperCase().padEnd(11, '0').slice(0, 11)}`;
        await db
          .insert(companies)
          .values({
            cnpj: fakeCnpj,
            ticker: ticker.toUpperCase(),
            name: data.name || ticker.toUpperCase(),
            sector: null,
          })
          .onConflictDoUpdate({
            target: companies.ticker,
            set: { name: data.name, updatedAt: new Date() },
          });

        await scoreWarmup.warmupSingle(ticker, 'fii').catch(() => {});

        console.log(`[lazy] ✅ ${ticker} (FII) scraped em ${Date.now() - start}ms`);

        return {
          ticker: ticker.toUpperCase(),
          name: data.name || ticker,
          type: 'fii',
          price: data.price,
          change: 0,
          changePct: 0,
          score: 50,
          sector: null,
          dy: data.dy12m,
          pvp: data.pvp,
          category: data.category,
          bookValue: data.bookValue,
          source: 'scraped',
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.error(`[lazy] ❌ Falha ao scrape ${ticker}:`, (err as Error).message);
      return null;
    }
  }
}

export const lazyDataService = new LazyDataService();
