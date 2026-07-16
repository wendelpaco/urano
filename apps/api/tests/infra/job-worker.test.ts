import { describe, expect, test } from 'bun:test';
import { JobWorker } from '../../src/infra/jobs/worker.ts';
import type { JobStore } from '../../src/infra/jobs/job-store.ts';
import type { Job, JobExecutionResult } from '../../src/infra/jobs/types.ts';

const job = (ticker: string): Job => ({
  id: `00000000-0000-0000-0000-${ticker.padEnd(12, '0').slice(0, 12)}`,
  ticker,
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

describe('JobWorker.executeJobs', () => {
  test('conta o resultado explícito, não apenas Promise fulfilled', async () => {
    const worker = new JobWorker({} as JobStore);
    const outcomes: Record<string, JobExecutionResult> = {
      OK3: { status: 'success' },
      WARN3: { status: 'partial', error: 'quote unavailable' },
      FAIL3: { status: 'failed', error: 'provider unavailable' },
    };
    worker.executeJob = async (candidate) => outcomes[candidate.ticker]!;

    const result = await worker.executeJobs(
      [job('OK3'), job('WARN3'), job('FAIL3')],
      2,
    );

    expect(result).toEqual({ success: 1, partial: 1, failed: 1 });
  });

  test('rejeição por falha de persistência é contabilizada como failed', async () => {
    const worker = new JobWorker({} as JobStore);
    worker.executeJob = async () => {
      throw new Error('database write failed');
    };

    const result = await worker.executeJobs([job('DBFAIL3')], 1);
    expect(result).toEqual({ success: 0, partial: 0, failed: 1 });
  });
});
