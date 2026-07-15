/**
 * Dedicated job-runner process — JobScheduler + JobStore + JobWorker only.
 * Does NOT start Fastify. Use with HTTP API set to SCHEDULER_ENABLED=false
 * so only one process runs the scheduler.
 *
 *   bun run worker:jobs
 *   # or: bun run src/infra/workers/job-runner.ts
 */

import 'dotenv/config';
import { env } from '../../config/env.ts';
import { JobStore } from '../jobs/job-store.ts';
import { JobWorker } from '../jobs/worker.ts';
import { JobScheduler } from '../jobs/scheduler.ts';
import { closeDatabaseConnection } from '../database/connection.ts';
import { redis } from '../services/redis.ts';

const jobStore = new JobStore();
const jobWorker = new JobWorker(jobStore);
const scheduler = new JobScheduler(jobStore, jobWorker, {
  enabled: true,
  checkInterval: 30_000,
  maxConcurrentJobs: 3,
  staleTimeout: 300_000,
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[job-runner] ${signal} received — shutting down…`);
  try {
    await scheduler.stop();
    await closeDatabaseConnection().catch(() => {});
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

console.log(
  `[job-runner] started (NODE_ENV=${env.NODE_ENV}, DB configured, no HTTP server)`,
);
console.log(
  '[job-runner] Tip: run the HTTP API with SCHEDULER_ENABLED=false when using this process',
);

try {
  await scheduler.start();
} catch (err) {
  console.error(
    '[job-runner] Failed to start scheduler:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
