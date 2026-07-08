/**
 * JobStore — CRUD de jobs e job_runs no PostgreSQL via Drizzle.
 */

import { eq, and, asc, desc, sql, lte } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { jobs, jobRuns } from '../database/schema.ts';
import type { Job, JobRun, CreateJobInput, JobStatus, RunStatus } from './types.ts';

export class JobStore {
  // ─── Jobs ──────────────────────────────────────────────────────────────

  async createJob(input: CreateJobInput): Promise<Job> {
    const [row] = await db
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
        set: { updatedAt: new Date() },
      })
      .returning();

    return this.mapJob(row!);
  }

  async getJobById(jobId: string): Promise<Job | null> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return row ? this.mapJob(row) : null;
  }

  async getJobByTicker(
    ticker: string,
    assetType: string,
  ): Promise<Job | null> {
    const [row] = await db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.ticker, ticker), eq(jobs.assetType, assetType)),
      );
    return row ? this.mapJob(row) : null;
  }

  async getJobsDue(): Promise<Job[]> {
    const rows = await db
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

  async getEnabledJobs(): Promise<Job[]> {
    const rows = await db
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
    await db.update(jobs).set({ ...updates, updatedAt: new Date() }).where(eq(jobs.id, jobId));
  }

  async resetStuckJobs(timeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMs);
    const result = await db
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

    return result.length;
  }

  // ─── Job Runs ──────────────────────────────────────────────────────────

  async createJobRun(
    jobId: string,
    ticker: string,
  ): Promise<JobRun> {
    const [row] = await db
      .insert(jobRuns)
      .values({ jobId, ticker, status: 'success' })
      .returning();
    return this.mapRun(row!);
  }

  async completeJobRun(
    runId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    const completedAt = new Date();
    const [run] = await db
      .select({ startedAt: jobRuns.startedAt })
      .from(jobRuns)
      .where(eq(jobRuns.id, runId));

    const durationMs = run
      ? completedAt.getTime() - run.startedAt.getTime()
      : 0;

    await db
      .update(jobRuns)
      .set({
        status: success ? 'success' : 'failed',
        completedAt,
        durationMs: Math.round(durationMs),
        errorMessage: errorMessage ?? null,
      })
      .where(eq(jobRuns.id, runId));
  }

  async getRecentRuns(limit = 50): Promise<JobRun[]> {
    const rows = await db
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt))
      .limit(limit);
    return rows.map((r) => this.mapRun(r));
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  async getStats() {
    const [jobStats] = await db.execute(sql`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE enabled = true)::int as enabled,
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'running')::int as running,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed
      FROM jobs
    `);

    const [runStats] = await db.execute(sql`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE completed_at > NOW() - INTERVAL '24 hours')::int as last_24h,
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
