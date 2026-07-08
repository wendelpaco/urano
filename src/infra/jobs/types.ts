/**
 * Job System Types
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type AssetType = 'stock' | 'fii';
export type RunStatus = 'success' | 'failed';

export interface Job {
  id: string;
  ticker: string;
  assetType: AssetType;
  status: JobStatus;
  priority: number;
  runInterval: number; // seconds
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastError: string | null;
  retryCount: number;
  maxRetries: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobRun {
  id: string;
  jobId: string;
  ticker: string;
  status: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface CreateJobInput {
  ticker: string;
  assetType: AssetType;
  priority?: number;
  runInterval?: number;
  enabled?: boolean;
}

export interface SchedulerConfig {
  enabled: boolean;
  checkInterval: number; // ms — how often to check for due jobs
  maxConcurrentJobs: number;
  staleTimeout: number; // ms — mark job as failed if running too long
}
