ALTER TABLE "jobs" ALTER COLUMN "run_interval" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "run_interval" SET DEFAULT 3600;