-- Job durations are stored in milliseconds. SMALLINT overflows after 32.767s,
-- which is shorter than several legitimate synchronization jobs.
ALTER TABLE "job_runs"
  ALTER COLUMN "duration_ms" TYPE integer
  USING "duration_ms"::integer;
