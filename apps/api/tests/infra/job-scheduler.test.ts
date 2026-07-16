import { describe, expect, test } from 'bun:test';
import { JobScheduler } from '../../src/infra/jobs/scheduler.ts';
import type {
  Job,
  JobBatchResult,
  SchedulerConfig,
} from '../../src/infra/jobs/types.ts';
import type { JobStore } from '../../src/infra/jobs/job-store.ts';
import type { JobWorker } from '../../src/infra/jobs/worker.ts';

const config = (partial: Partial<SchedulerConfig> = {}): SchedulerConfig => ({
  enabled: true,
  checkInterval: 60_000,
  maxConcurrentJobs: 1,
  staleTimeout: 300_000,
  ...partial,
});

const job = (id = '00000000-0000-0000-0000-000000000001'): Job => ({
  id,
  ticker: 'TEST3',
  assetType: 'stock',
  status: 'running',
  priority: 1,
  runInterval: 3_600,
  nextRunAt: new Date(0),
  lastRunAt: null,
  lastError: null,
  retryCount: 0,
  maxRetries: 2,
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe('JobScheduler', () => {
  test('enabled=false não toca no banco nem inicia o loop', async () => {
    let storeCalls = 0;
    let workerCalls = 0;
    const store = {
      resetStuckJobs: async () => { storeCalls++; return 0; },
      claimJobsDue: async () => { storeCalls++; return []; },
      releaseClaims: async () => { storeCalls++; },
    } as unknown as JobStore;
    const worker = {
      executeJobs: async () => {
        workerCalls++;
        return { success: 0, partial: 0, failed: 0 };
      },
    } as unknown as JobWorker;

    const scheduler = new JobScheduler(store, worker, config({ enabled: false }));
    await scheduler.start();

    expect(scheduler.getStatus().running).toBe(false);
    expect(storeCalls).toBe(0);
    expect(workerCalls).toBe(0);
  });

  test('claim respeita capacidade e shutdown aguarda lote ativo', async () => {
    let claimedLimit: number | undefined;
    let resolveBatch!: (result: JobBatchResult) => void;
    const batchFinished = new Promise<JobBatchResult>((resolve) => {
      resolveBatch = resolve;
    });

    const store = {
      resetStuckJobs: async () => 0,
      claimJobsDue: async (limit: number) => {
        claimedLimit = limit;
        return [job()];
      },
      releaseClaims: async () => {},
    } as unknown as JobStore;
    const worker = {
      executeJobs: async () => batchFinished,
    } as unknown as JobWorker;

    const scheduler = new JobScheduler(store, worker, config({ maxConcurrentJobs: 1 }));
    await scheduler.start();

    expect(claimedLimit).toBe(1);
    expect(scheduler.getStatus().currentJobs).toBe(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveBatch({ success: 1, partial: 0, failed: 0 });
    await stopping;

    expect(stopped).toBe(true);
    expect(scheduler.getStatus().running).toBe(false);
    expect(scheduler.getStatus().currentJobs).toBe(0);
  });

  test('libera claim se shutdown começa antes do dispatch', async () => {
    let finishClaim!: (jobs: Job[]) => void;
    const delayedClaim = new Promise<Job[]>((resolve) => { finishClaim = resolve; });
    const released: string[][] = [];
    let workerCalls = 0;

    const store = {
      resetStuckJobs: async () => 0,
      claimJobsDue: async () => delayedClaim,
      releaseClaims: async (ids: string[]) => { released.push(ids); },
    } as unknown as JobStore;
    const worker = {
      executeJobs: async () => {
        workerCalls++;
        return { success: 1, partial: 0, failed: 0 };
      },
    } as unknown as JobWorker;

    const scheduler = new JobScheduler(store, worker, config());
    const starting = scheduler.start();
    await Promise.resolve();
    const stopping = scheduler.stop();
    finishClaim([job()]);

    await Promise.all([starting, stopping]);
    expect(released).toEqual([[job().id]]);
    expect(workerCalls).toBe(0);
  });
});
