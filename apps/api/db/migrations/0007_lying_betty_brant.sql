CREATE TABLE "daily_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"asset_type" varchar(10) DEFAULT 'stock' NOT NULL,
	"snapshot_date" date DEFAULT now() NOT NULL,
	"price" numeric(12, 2),
	"dy_12m" numeric(6, 2),
	"pl" numeric(8, 2),
	"pvp" numeric(8, 2),
	"ev_ebitda" numeric(8, 2),
	"ev_ebit" numeric(8, 2),
	"vpa" numeric(10, 2),
	"lpa" numeric(10, 2),
	"market_cap" numeric(18, 2),
	"avg_liquidity" numeric(18, 2),
	"min_52w" numeric(10, 2),
	"max_52w" numeric(10, 2),
	"valorization_12m" numeric(6, 2),
	"volatility" numeric(6, 2),
	"roe" numeric(6, 2),
	"roa" numeric(6, 2),
	"roic" numeric(6, 2),
	"gross_margin" numeric(6, 2),
	"ebitda_margin" numeric(6, 2),
	"ebit_margin" numeric(6, 2),
	"net_margin" numeric(6, 2),
	"cagr_revenue_5y" numeric(6, 2),
	"cagr_earnings_5y" numeric(6, 2),
	"dy_cagr_3y" numeric(6, 2),
	"value_cagr_3y" numeric(6, 2),
	"net_debt_to_equity" numeric(6, 2),
	"net_debt_to_ebitda" numeric(6, 2),
	"current_ratio" numeric(6, 2),
	"asset_turnover" numeric(6, 2),
	"book_value" numeric(10, 2),
	"avg_monthly_income" numeric(10, 4),
	"num_shareholders" integer,
	"cash_value" numeric(14, 2),
	"ifix_participation" numeric(6, 2),
	"our_score" numeric(5, 2),
	"source" varchar(20) DEFAULT 'statusinvest',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" smallint,
	"error_message" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"asset_type" varchar(10) DEFAULT 'stock' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"run_interval" smallint DEFAULT 3600 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" varchar(500),
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"max_retries" smallint DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_snapshot_ticker_date" ON "daily_snapshots" USING btree ("ticker","snapshot_date");--> statement-breakpoint
CREATE INDEX "idx_snapshot_date" ON "daily_snapshots" USING btree ("snapshot_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_snapshot_ticker" ON "daily_snapshots" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_snapshot_type_date" ON "daily_snapshots" USING btree ("asset_type","snapshot_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_job_runs_job_id" ON "job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_runs_started" ON "job_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_ticker_type" ON "jobs" USING btree ("ticker","asset_type");--> statement-breakpoint
CREATE INDEX "idx_jobs_next_run" ON "jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_enabled" ON "jobs" USING btree ("enabled") WHERE "jobs"."enabled" = true;