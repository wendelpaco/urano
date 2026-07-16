/**
 * JobStore — CRUD de jobs e job_runs no PostgreSQL via Drizzle.
 */

import { eq, and, asc, desc, sql, lte, inArray } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { jobs, jobRuns } from '../database/schema.ts';
import type {
  Job,
  JobRun,
  CreateJobInput,
  JobStatus,
  RunStatus,
  TerminalRunStatus,
} from './types.ts';

export interface ClaimedJobUpdate {
  status: JobStatus;
  lastError?: string | null;
  retryCount?: number;
  lastRunAt?: Date;
  nextRunAt?: Date;
  enabled?: boolean;
}

export class JobStore {
  constructor(private readonly database: typeof db = db) {}

  // ─── Jobs ──────────────────────────────────────────────────────────────

  async createJob(input: CreateJobInput): Promise<Job> {
    const [row] = await this.database
      .insert(jobs)
      .values({
        ticker: input.ticker,
        assetType: input.assetType,
        priority: input.priority ?? 0,
        runInterval: input.runInterval ?? 3600,
        enabled: input.enabled ?? true,
      })
      .onConflictDoUpdate({
        target: [jobs.ticker, jobs.assetType],
        set: { priority: input.priority ?? 0, runInterval: input.runInterval ?? 3600, updatedAt: new Date() },
      })
      .returning();

    return this.mapJob(row!);
  }

  async getJobById(jobId: string): Promise<Job | null> {
    const [row] = await this.database.select().from(jobs).where(eq(jobs.id, jobId));
    return row ? this.mapJob(row) : null;
  }

  async getJobByTicker(
    ticker: string,
    assetType: string,
  ): Promise<Job | null> {
    const [row] = await this.database
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.ticker, ticker), eq(jobs.assetType, assetType)),
      );
    return row ? this.mapJob(row) : null;
  }

  async getJobsDue(): Promise<Job[]> {
    const rows = await this.database
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.enabled, true),
          sql`${jobs.status} != 'running'`,
          lte(jobs.nextRunAt, new Date()),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.nextRunAt));

    return rows.map((r) => this.mapJob(r));
  }

  /**
   * Reserva jobs vencidos de forma atômica.
   *
   * O lock com SKIP LOCKED impede duas réplicas de receberem o mesmo job.
   * A mudança para `running` acontece dentro da mesma transação, antes de os
   * locks serem liberados. `updatedAt` funciona como início/renovação do lease.
   */
  async claimJobsDue(limit: number): Promise<Job[]> {
    if (!Number.isInteger(limit) || limit <= 0) return [];

    return this.database.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.enabled, true),
            sql`${jobs.status} != 'running'`,
            lte(jobs.nextRunAt, new Date()),
          ),
        )
        .orderBy(desc(jobs.priority), asc(jobs.nextRunAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (candidates.length === 0) return [];

      const claimed = await tx
        .update(jobs)
        .set({ status: 'running', updatedAt: new Date() })
        .where(inArray(jobs.id, candidates.map((row) => row.id)))
        .returning();

      const order = new Map(candidates.map((row, index) => [row.id, index]));
      claimed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return claimed.map((row) => this.mapJob(row));
    });
  }

  /**
   * Renova o lease por compare-and-swap. Uma execução cujo lease expirou não
   * consegue renovar (nem finalizar) o claim de uma nova réplica.
   */
  async renewJobLease(jobId: string, leaseVersion: Date): Promise<Date | null> {
    const renewedAt = new Date(Math.max(Date.now(), leaseVersion.getTime() + 1));
    const [row] = await this.database
      .update(jobs)
      .set({ updatedAt: renewedAt })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'running'),
          eq(jobs.updatedAt, leaseVersion),
        ),
      )
      .returning({ updatedAt: jobs.updatedAt });
    return row?.updatedAt ?? null;
  }

  /** Finaliza/reagenda somente se o chamador ainda possuir o lease. */
  async updateClaimedJob(
    jobId: string,
    leaseVersion: Date,
    updates: ClaimedJobUpdate,
  ): Promise<Date | null> {
    const updatedAt = new Date(Math.max(Date.now(), leaseVersion.getTime() + 1));
    const [row] = await this.database
      .update(jobs)
      .set({ ...updates, updatedAt })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'running'),
          eq(jobs.updatedAt, leaseVersion),
        ),
      )
      .returning({ updatedAt: jobs.updatedAt });
    return row?.updatedAt ?? null;
  }

  /**
   * Finaliza o claim e seu registro de execução na mesma transação.
   * Se o CAS do lease falhar, o job_run não é alterado. Se a escrita do run
   * falhar, a mudança de status do job também é revertida.
   */
  async completeClaimedJobRun(
    jobId: string,
    leaseVersion: Date,
    runId: string,
    updates: ClaimedJobUpdate,
    runStatus: TerminalRunStatus,
    errorMessage?: string,
  ): Promise<Date | null> {
    return this.database.transaction(async (tx) => {
      const updatedAt = new Date(Math.max(Date.now(), leaseVersion.getTime() + 1));
      const [claimedJob] = await tx
        .update(jobs)
        .set({ ...updates, updatedAt })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            eq(jobs.updatedAt, leaseVersion),
          ),
        )
        .returning({ updatedAt: jobs.updatedAt });

      if (!claimedJob) return null;

      const [completedRun] = await tx
        .update(jobRuns)
        .set({
          status: runStatus,
          completedAt: new Date(),
          durationMs: sql`EXTRACT(EPOCH FROM (NOW() - ${jobRuns.startedAt})) * 1000`,
          errorMessage: errorMessage || null,
        })
        .where(
          and(
            eq(jobRuns.id, runId),
            eq(jobRuns.jobId, jobId),
            eq(jobRuns.status, 'running'),
          ),
        )
        .returning({ id: jobRuns.id });

      if (!completedRun) {
        throw new Error(`job_run ${runId} não está em estado running`);
      }

      return claimedJob.updatedAt;
    });
  }

  /** Libera claims obtidos por um scheduler que entrou em shutdown antes do dispatch. */
  async releaseClaims(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    await this.database
      .update(jobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(inArray(jobs.id, jobIds), eq(jobs.status, 'running')));
  }

  async getEnabledJobs(): Promise<Job[]> {
    const rows = await this.database
      .select()
      .from(jobs)
      .where(eq(jobs.enabled, true))
      .orderBy(asc(jobs.ticker));
    return rows.map((r) => this.mapJob(r));
  }

  async updateJob(
    jobId: string,
    updates: {
      status?: JobStatus;
      lastError?: string | null;
      retryCount?: number;
      lastRunAt?: Date;
      nextRunAt?: Date;
      enabled?: boolean;
    },
  ): Promise<void> {
    await this.database.update(jobs).set({ ...updates, updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }

  async resetStuckJobs(timeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMs);
    return this.database.transaction(async (tx) => {
      const stuck = await tx
        .update(jobs)
        .set({
          status: 'failed',
          lastError: 'Job timeout — stuck in running state',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(jobs.status, 'running'),
            lte(jobs.updatedAt, cutoff),
          ),
        )
        .returning({ id: jobs.id });

      if (stuck.length > 0) {
        await tx
          .update(jobRuns)
          .set({
            status: 'failed',
            completedAt: new Date(),
            durationMs: sql`EXTRACT(EPOCH FROM (NOW() - ${jobRuns.startedAt})) * 1000`,
            errorMessage: 'Lease expirado antes da conclusão do job',
          })
          .where(
            and(
              inArray(jobRuns.jobId, stuck.map((row) => row.id)),
              eq(jobRuns.status, 'running'),
            ),
          );
      }

      return stuck.length;
    });
  }

  // ─── Job Runs ──────────────────────────────────────────────────────────

  async createJobRun(
    jobId: string,
    ticker: string,
  ): Promise<JobRun> {
    const [row] = await this.database
      .insert(jobRuns)
      .values({ jobId, ticker, status: 'running' })
      .returning();
    return this.mapRun(row!);
  }

  async completeJobRun(
    runId: string,
    status: TerminalRunStatus,
    errorMessage?: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(jobRuns)
      .set({
        status,
        completedAt: new Date(),
        durationMs: sql`EXTRACT(EPOCH FROM (NOW() - ${jobRuns.startedAt})) * 1000`,
        errorMessage: errorMessage || null,
      })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'running')))
      .returning({ id: jobRuns.id });
    return rows.length === 1;
  }

  async getRecentRuns(limit = 50): Promise<JobRun[]> {
    const rows = await this.database
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(limit);
    return rows.map((r) => this.mapRun(r));
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  async getStats() {
    const [jobStats] = await this.database.execute(sql`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE enabled = true)::int as enabled,
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'running')::int as running,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed
      FROM jobs
    `);

    const [runStats] = await this.database.execute(sql`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE completed_at > NOW() - INTERVAL '24 hours')::int as last_24h,
        COUNT(*) FILTER (WHERE status = 'partial')::int as partial,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed
      FROM job_runs
    `);

    return {
      jobs: (jobStats as unknown as Record<string, number>) ?? { total: 0 },
      runs: (runStats as unknown as Record<string, number>) ?? { total: 0 },
    };
  }

  // ─── Mappers ───────────────────────────────────────────────────────────

  private mapJob(r: typeof jobs.$inferSelect): Job {
    return {
      id: r.id,
      ticker: r.ticker,
      assetType: r.assetType as Job['assetType'],
      status: r.status as JobStatus,
      priority: r.priority,
      runInterval: r.runInterval,
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      lastError: r.lastError,
      retryCount: r.retryCount,
      maxRetries: r.maxRetries,
      enabled: r.enabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private mapRun(r: typeof jobRuns.$inferSelect): JobRun {
    return {
      id: r.id,
      jobId: r.jobId,
      ticker: r.ticker,
      status: r.status as RunStatus,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
    };
  }
}
