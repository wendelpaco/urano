/**
 * Job Worker — Executa as tarefas de sincronização de dados.
 *
 * Para ações (stock): busca proventos do StatusInvest + cotação Yahoo.
 * Para FIIs: busca proventos + cotação Yahoo + P/VP do StatusInvest.
 *
 * A sincronização de fundamentos CVM é muito pesada (ZIP 12MB) para
 * rodar por ticker; continua sendo via CLI (worker:sync).
 */

import type { ClaimedJobUpdate, JobStore } from './job-store.ts';
import { statusInvestScraper } from '../services/statusinvest-scraper.ts';
import { fiisScraper } from '../services/fiis-scraper.ts';
import { stockQuoteService } from '../services/stock-quote-service.ts';
import { redis } from '../services/redis.ts';
import { snapshotWindow } from './time-window.ts';
import { db } from '../database/connection.ts';
import { companies } from '../database/schema.ts';
import { scoreWarmup } from '../services/score-warmup.ts';
import type {
  Job,
  JobBatchResult,
  JobExecutionResult,
  TerminalRunStatus,
} from './types.ts';

interface ActiveJobLease {
  jobId: string;
  version: Date;
  timer: ReturnType<typeof setInterval>;
  renewal: Promise<void>;
  stopped: boolean;
  lost: boolean;
}

class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease do job ${jobId} foi perdido para outra execução`);
    this.name = 'JobLeaseLostError';
  }
}

export class JobWorker {
  constructor(
    private store: JobStore,
    private readonly heartbeatIntervalMs = 30_000,
  ) {}

  async executeJob(job: Job): Promise<JobExecutionResult> {
    const start = Date.now();
    const lease = this.startLease(job);

    try {
      // Job de sistema: snapshot diário
      if (job.ticker === '_daily' && job.assetType === 'system') {
        // Verifica janela de horário (madrugada para não competir com usuários)
        if (!snapshotWindow.isOpen()) {
          const status = snapshotWindow.getStatus();
          console.log(`[worker] ⏰ Snapshot diário adiado: ${status.description}`);
          // Re-agenda para daqui a 30 min (quando tentar de novo)
          await this.finishClaim(job, lease, {
            status: 'pending',
            nextRunAt: new Date(Date.now() + 30 * 60_000),
            lastError: status.description,
          });
          return { status: 'partial', error: status.description };
        }
        return await this.runDailySnapshot(job, lease);
      }

      // Job de sistema: warmup de scores
      if (job.ticker === '_warmup' && job.assetType === 'system') {
        return await this.runScoreWarmup(job, lease);
      }

      // Cria registro de run já em `running`.
      const run = await this.store.createJobRun(job.id, job.ticker);

      try {
        const refresh = await this.refreshData(job.ticker, job.assetType);
        const outcome = refresh.warnings.length > 0 ? 'partial' : 'success';
        const warning = refresh.warnings.join('; ') || undefined;

        // Próximo run: agora + runInterval
        const nextRun = new Date(Date.now() + job.runInterval * 1000);

        await this.finishClaimAndRun(job, lease, run.id, {
          status: 'completed',
          lastRunAt: new Date(),
          nextRunAt: nextRun,
          retryCount: 0,
          lastError: warning?.slice(0, 500) ?? null,
        }, outcome, warning);

        console.log(
          `[worker] ${outcome === 'success' ? '✅' : '⚠️'} ${job.ticker} ` +
          `(${job.assetType}) — ${Date.now() - start}ms`,
        );
        return { status: outcome, error: warning };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (error instanceof JobLeaseLostError) {
          console.warn(`[worker] ❌ ${job.ticker} (${job.assetType}) — ${msg}`);
          return { status: 'failed', error: msg };
        }

        const newRetry = job.retryCount + 1;
        const shouldRetry = newRetry < job.maxRetries;

        const nextRun = shouldRetry
          ? new Date(Date.now() + 60_000) // retry em 1 min
          : new Date(Date.now() + job.runInterval * 1000);

        // Falha ao persistir qualquer um destes estados é propagada. O lease
        // expirará e o scheduler poderá recuperar o job sem declarar sucesso.
        await this.finishClaimAndRun(job, lease, run.id, {
          status: shouldRetry ? 'pending' : 'failed',
          lastError: msg.slice(0, 500),
          retryCount: newRetry,
          nextRunAt: nextRun,
          lastRunAt: new Date(),
        }, 'failed', msg);

        console.warn(
          `[worker] ❌ ${job.ticker} (${job.assetType}) — ${msg} (${Date.now() - start}ms)`,
        );
        return { status: 'failed', error: msg };
      }
    } finally {
      await this.stopLease(lease);
    }
  }

  async executeJobs(jobs: Job[], concurrency: number): Promise<JobBatchResult> {
    let success = 0;
    let partial = 0;
    let failed = 0;

    for (let i = 0; i < jobs.length; i += concurrency) {
      const batch = jobs.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((j) => this.executeJob(j)),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          failed++;
          console.error('[worker] Falha durável sem estado final:', result.reason);
          continue;
        }

        if (result.value.status === 'success') success++;
        else if (result.value.status === 'partial') partial++;
        else failed++;
      }
    }

    return { success, partial, failed };
  }

  // ─── System Jobs ──────────────────────────────────────────────────────

  private async runScoreWarmup(
    job: Job,
    lease: ActiveJobLease,
  ): Promise<JobExecutionResult> {
    const start = Date.now();
    const run = await this.store.createJobRun(job.id, '_warmup');

    try {
      const result = await scoreWarmup.warmupAll();
      const failures = result.stocks.failed + result.fiis.failed;
      const outcome = failures > 0 ? 'partial' : 'success';
      const warning = failures > 0
        ? `${result.stocks.failed} stocks, ${result.fiis.failed} FIIs failed`
        : undefined;

      const nextRun = new Date(Date.now() + job.runInterval * 1000);
      await this.finishClaimAndRun(job, lease, run.id, {
        status: 'completed',
        lastRunAt: new Date(),
        nextRunAt: nextRun,
        retryCount: 0,
        lastError: warning ?? null,
      }, outcome, warning);
      console.log(
        `[worker] 🔥 Warmup scores — ${(Date.now() - start)}ms ` +
          `(${result.stocks.cached} stocks, ${result.fiis.cached} FIIs)`,
      );
      return { status: outcome, error: warning };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof JobLeaseLostError) {
        console.error(`[worker] ❌ Warmup scores falhou: ${msg}`);
        return { status: 'failed', error: msg };
      }

      await this.finishClaimAndRun(job, lease, run.id, {
        status: 'failed',
        lastError: msg.slice(0, 500),
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + 600_000),
      }, 'failed', msg);
      console.error(`[worker] ❌ Warmup scores falhou: ${msg}`);
      return { status: 'failed', error: msg };
    }
  }

  private async runDailySnapshot(
    job: Job,
    lease: ActiveJobLease,
  ): Promise<JobExecutionResult> {
    const start = Date.now();
    const run = await this.store.createJobRun(job.id, '_daily');

    try {
      // Import dinâmico para não carregar o worker inteiro no startup
      const { exec } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        exec(
          'bun run src/infra/workers/daily-snapshot-worker.ts',
          { cwd: process.cwd(), timeout: 600_000 },
          (error, stdout) => {
            if (error) reject(error);
            else {
              const lines = stdout.split('\n').filter(l => l.includes('✅ Snapshot'));
              console.log(`[worker] 📸 ${lines[lines.length-1] || 'snapshot ok'}`);
              resolve();
            }
          },
        );
      });

      const nextRun = new Date(Date.now() + job.runInterval * 1000);
      await this.finishClaimAndRun(job, lease, run.id, {
        status: 'completed', lastRunAt: new Date(), nextRunAt: nextRun, retryCount: 0, lastError: null,
      }, 'success');
      console.log(`[worker] ✅ Snapshot diário — ${Date.now() - start}ms`);
      return { status: 'success' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof JobLeaseLostError) {
        console.error(`[worker] ❌ Snapshot diário falhou: ${msg}`);
        return { status: 'failed', error: msg };
      }

      await this.finishClaimAndRun(job, lease, run.id, {
        status: 'failed', lastError: msg.slice(0, 500), lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + 3600_000), // retry em 1h
      }, 'failed', msg);
      console.error(`[worker] ❌ Snapshot diário falhou: ${msg}`);
      return { status: 'failed', error: msg };
    }
  }

  private async refreshData(
    ticker: string,
    assetType: Job['assetType'],
  ): Promise<{ warnings: string[] }> {
    if (assetType === 'system') {
      throw new Error(`Asset type inválido para refresh: ${assetType}`);
    }

    const warnings: string[] = [];

    // 1. Cotação atualizada (cache 120s no próprio service, rate limit Yahoo)
    try {
      await stockQuoteService.getQuote(ticker);
    } catch (error) {
      // Cotação pode falhar — não é crítico
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`cotação indisponível: ${msg}`);
    }

    // 2. Scraping completo do StatusInvest (HTML + JSON API de proventos)
    //    O scraper já faz cache de dividendos no Redis (24h).
    //    Rate limit gerenciado pelo TokenBucket centralizado.
    try {
      if (assetType === 'stock') {
        const data = await statusInvestScraper.fetchStock(ticker);

        // Upsert na tabela companies para aparecer no ranking/search
        // Usa CNPJ placeholder (CVM sync substitui pelo real depois)
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
            set: { name: data.name || ticker.toUpperCase(), sector: data.sector || null, updatedAt: new Date() },
          });

        // Warmup do score após scraping
        await scoreWarmup.warmupSingle(ticker, 'stock');
      } else {
        const data = await fiisScraper.fetchFII(ticker);

        // Upsert na tabela companies (FIIs usam CNPJ fake padrão)
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
            set: { name: data.name || ticker.toUpperCase(), updatedAt: new Date() },
          });

        // Cache adicional específico de FIIs usado pela API
        if (data.pvp > 0) {
          await redis.setex(
            `fii:pvp:${ticker.toUpperCase()}`,
            86_400,
            String(data.pvp),
          );
        }

        // Cache do FII completo (24h) — usado pela API
        await redis.setex(
          `fii:full:${ticker.toUpperCase()}`,
          86_400,
          JSON.stringify(data),
        );

        // Warmup do score após scraping
        await scoreWarmup.warmupSingle(ticker, 'fii');
      }
    } catch (error) {
      // O refresh primário ou sua persistência falhou: o job precisa entrar em
      // retry/failed, nunca aparecer como concluído apenas porque havia cache.
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`refresh primário falhou: ${msg}`, { cause: error });
    }

    return { warnings };
  }

  private startLease(job: Job): ActiveJobLease {
    const lease: ActiveJobLease = {
      jobId: job.id,
      version: job.updatedAt,
      renewal: Promise.resolve(),
      stopped: false,
      lost: false,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
    };

    lease.timer = setInterval(() => {
      lease.renewal = lease.renewal.then(async () => {
        if (lease.stopped || lease.lost) return;

        try {
          const renewed = await this.store.renewJobLease(job.id, lease.version);
          if (!renewed) {
            lease.lost = true;
            lease.stopped = true;
            clearInterval(lease.timer);
            console.error(`[worker] Lease perdido para ${job.ticker}`);
            return;
          }
          lease.version = renewed;
        } catch (error) {
          // Conserva a versão e tenta novamente. Se outra réplica assumir após
          // o timeout, o próximo CAS/finalização detectará a perda do lease.
          console.error(
            `[worker] Falha ao renovar lease de ${job.ticker}:`,
            error instanceof Error ? error.message : error,
          );
        }
      });
    }, this.heartbeatIntervalMs);
    lease.timer.unref?.();
    return lease;
  }

  private async stopLease(lease: ActiveJobLease): Promise<void> {
    if (!lease.stopped) {
      lease.stopped = true;
      clearInterval(lease.timer);
    }
    await lease.renewal;
  }

  private async finishClaim(
    job: Job,
    lease: ActiveJobLease,
    updates: Parameters<JobStore['updateClaimedJob']>[2],
  ): Promise<void> {
    await this.stopLease(lease);
    if (lease.lost) throw new JobLeaseLostError(job.id);

    const updatedAt = await this.store.updateClaimedJob(
      job.id,
      lease.version,
      updates,
    );
    if (!updatedAt) {
      lease.lost = true;
      throw new JobLeaseLostError(job.id);
    }
    lease.version = updatedAt;
  }

  private async finishClaimAndRun(
    job: Job,
    lease: ActiveJobLease,
    runId: string,
    updates: ClaimedJobUpdate,
    runStatus: TerminalRunStatus,
    errorMessage?: string,
  ): Promise<void> {
    await this.stopLease(lease);

    if (!lease.lost) {
      const updatedAt = await this.store.completeClaimedJobRun(
        job.id,
        lease.version,
        runId,
        updates,
        runStatus,
        errorMessage,
      );
      if (updatedAt) {
        lease.version = updatedAt;
        return;
      }
      lease.lost = true;
    }

    // O reaper normalmente encerra o run ao expirar o lease. Este fallback
    // cobre alterações administrativas de estado sem deixar run órfão.
    await this.store
      .completeJobRun(runId, 'failed', `Lease perdido: ${job.id}`)
      .catch((error) => {
        console.error(
          `[worker] Falha ao encerrar run ${runId} após perda do lease:`,
          error instanceof Error ? error.message : error,
        );
      });
    throw new JobLeaseLostError(job.id);
  }
}
