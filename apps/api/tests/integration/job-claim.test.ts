import { afterAll, describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { JobStore } from '../../src/infra/jobs/job-store.ts';
import * as schema from '../../src/infra/database/schema.ts';

const shouldRun =
  Boolean(process.env.DATABASE_URL) &&
  (process.env.CI === 'true' || process.env.RUN_INTEGRATION === '1');

describe.skipIf(!shouldRun)('integration: atomic job claim', () => {
  const client = postgres(process.env.DATABASE_URL!, {
    max: 4,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  const database = drizzle(client, { schema });
  const store = new JobStore(database);
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length > 0) {
      await client`DELETE FROM jobs WHERE id IN ${client(createdIds)}`.catch(() => {});
    }
    await client.end({ timeout: 5 }).catch(() => {});
  });

  test('duas réplicas não recebem o mesmo job e lease antigo perde o CAS', async () => {
    const ticker = `J${Date.now().toString(36).slice(-8)}`.toUpperCase();
    const created = await store.createJob({
      ticker,
      assetType: 'stock',
      priority: 99,
      runInterval: 3_600,
    });
    createdIds.push(created.id);

    const [replicaA, replicaB] = await Promise.all([
      store.claimJobsDue(1),
      store.claimJobsDue(1),
    ]);
    const claimed = [...replicaA, ...replicaB].filter((row) => row.id === created.id);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('running');

    const owner = claimed[0]!;
    const renewed = await store.renewJobLease(owner.id, owner.updatedAt);
    expect(renewed).toBeInstanceOf(Date);

    const staleOwner = await store.renewJobLease(owner.id, owner.updatedAt);
    expect(staleOwner).toBeNull();
  });

  test('job_run nasce running e aceita resultado partial', async () => {
    const ticker = `R${Date.now().toString(36).slice(-8)}`.toUpperCase();
    const created = await store.createJob({
      ticker,
      assetType: 'stock',
      priority: 98,
      runInterval: 3_600,
    });
    createdIds.push(created.id);

    const claimed = (await store.claimJobsDue(1))[0];
    expect(claimed?.id).toBe(created.id);

    const run = await store.createJobRun(created.id, ticker);
    expect(run.status).toBe('running');

    const finalizedAt = await store.completeClaimedJobRun(
      created.id,
      claimed!.updatedAt,
      run.id,
      {
        status: 'completed',
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + 3_600_000),
        retryCount: 0,
        lastError: 'quote unavailable',
      },
      'partial',
      'quote unavailable',
    );
    expect(finalizedAt).toBeInstanceOf(Date);

    const recent = await store.getRecentRuns(20);
    const completed = recent.find((candidate) => candidate.id === run.id);
    const completedJob = await store.getJobById(created.id);

    expect(completed?.status).toBe('partial');
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed?.errorMessage).toBe('quote unavailable');
    expect(completedJob?.status).toBe('completed');
  });

  test('CAS inválido não finaliza nem o job nem o job_run', async () => {
    const ticker = `C${Date.now().toString(36).slice(-8)}`.toUpperCase();
    const created = await store.createJob({
      ticker,
      assetType: 'stock',
      priority: 97,
      runInterval: 3_600,
    });
    createdIds.push(created.id);

    const claimed = (await store.claimJobsDue(1))[0];
    expect(claimed?.id).toBe(created.id);
    const run = await store.createJobRun(created.id, ticker);

    const staleLease = new Date(claimed!.updatedAt.getTime() - 1);
    const rejected = await store.completeClaimedJobRun(
      created.id,
      staleLease,
      run.id,
      { status: 'completed' },
      'success',
    );
    expect(rejected).toBeNull();

    const stillRunningJob = await store.getJobById(created.id);
    const stillRunningRun = (await store.getRecentRuns(20))
      .find((candidate) => candidate.id === run.id);
    expect(stillRunningJob?.status).toBe('running');
    expect(stillRunningRun?.status).toBe('running');

    const cleanedUp = await store.completeClaimedJobRun(
      created.id,
      claimed!.updatedAt,
      run.id,
      { status: 'failed', lastError: 'test cleanup' },
      'failed',
      'test cleanup',
    );
    expect(cleanedUp).toBeInstanceOf(Date);
  });
});

test('integration job-claim suite loads', () => {
  expect(true).toBe(true);
});
