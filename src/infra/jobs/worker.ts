/**
 * Job Worker — Executa as tarefas de sincronização de dados.
 *
 * Para ações (stock): busca proventos do StatusInvest + cotação Yahoo.
 * Para FIIs: busca proventos + cotação Yahoo + P/VP do StatusInvest.
 *
 * A sincronização de fundamentos CVM é muito pesada (ZIP 12MB) para
 * rodar por ticker; continua sendo via CLI (worker:sync).
 */

import { JobStore } from './job-store.ts';
import { statusInvestScraper } from '../services/statusinvest-scraper.ts';
import { stockQuoteService } from '../services/stock-quote-service.ts';
import { redis } from '../services/redis.ts';
import type { Job } from './types.ts';

export class JobWorker {
  constructor(private store: JobStore) {}

  async executeJob(job: Job): Promise<void> {
    const start = Date.now();

    // Cria registro de run
    const run = await this.store.createJobRun(job.id, job.ticker);

    // Marca como running
    await this.store.updateJob(job.id, { status: 'running' });

    try {
      await this.refreshData(job.ticker, job.assetType);

      // Próximo run: agora + runInterval
      const nextRun = new Date(Date.now() + job.runInterval * 1000);

      await this.store.updateJob(job.id, {
        status: 'completed',
        lastRunAt: new Date(),
        nextRunAt: nextRun,
        retryCount: 0,
        lastError: null,
      });

      await this.store.completeJobRun(run.id, true);

      console.log(
        `[worker] ✅ ${job.ticker} (${job.assetType}) — ${Date.now() - start}ms`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const newRetry = job.retryCount + 1;
      const shouldRetry = newRetry < job.maxRetries;

      const nextRun = shouldRetry
        ? new Date(Date.now() + 60_000) // retry em 1 min
        : new Date(Date.now() + job.runInterval * 1000);

      await this.store.updateJob(job.id, {
        status: shouldRetry ? 'pending' : 'failed',
        lastError: msg.slice(0, 500),
        retryCount: newRetry,
        nextRunAt: nextRun,
        lastRunAt: new Date(),
      });

      await this.store.completeJobRun(run.id, false, msg);

      console.warn(
        `[worker] ❌ ${job.ticker} (${job.assetType}) — ${msg} (${Date.now() - start}ms)`,
      );
    }
  }

  async executeJobs(jobs: Job[], concurrency: number): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (let i = 0; i < jobs.length; i += concurrency) {
      const batch = jobs.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((j) => this.executeJob(j)),
      );

      for (const r of results) {
        if (r.status === 'fulfilled') success++;
        else failed++;
      }
    }

    return { success, failed };
  }

  // ─── Refresh logic ─────────────────────────────────────────────────────

  private async refreshData(ticker: string, assetType: string): Promise<void> {
    // 1. Sempre busca cotação atualizada (cache 30s no próprio service)
    try {
      await stockQuoteService.getQuote(ticker);
    } catch {
      // Cotação pode falhar — não é crítico
    }

    // 2. Scraping completo do StatusInvest (HTML + JSON API de proventos)
    try {
      if (assetType === 'stock') {
        const data = await statusInvestScraper.fetchStock(ticker);

        // Cache de proventos (24h)
        if (data.dividendsHistory.length > 0) {
          await redis.setex(
            `dividends:${ticker.toUpperCase()}`,
            86_400,
            JSON.stringify(data.dividendsHistory),
          );
        }
      } else {
        const data = await statusInvestScraper.fetchFII(ticker);

        // Cache de proventos (24h)
        if (data.dividendsHistory.length > 0) {
          await redis.setex(
            `dividends:${ticker.toUpperCase()}`,
            86_400,
            JSON.stringify(data.dividendsHistory),
          );
        }

        // Cache de P/VP (24h)
        if (data.pvp > 0) {
          await redis.setex(
            `fii:pvp:${ticker.toUpperCase()}`,
            86_400,
            String(data.pvp),
          );
        }

        // Cache de vacância (24h)
        if (data.vacancy !== undefined) {
          await redis.setex(
            `fii:vacancy:${ticker.toUpperCase()}`,
            86_400,
            String(data.vacancy),
          );
        }
      }
    } catch {
      // StatusInvest pode falhar — dados anteriores permanecem no cache
    }
  }
}
