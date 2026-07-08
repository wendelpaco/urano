CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"key" varchar(128) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"cnpj" char(14) PRIMARY KEY NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"name" varchar(255) NOT NULL,
	"sector" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "company_fundamentals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_cnpj" char(14) NOT NULL,
	"fiscal_year" smallint NOT NULL,
	"period" varchar(5) NOT NULL,
	"reference_date" date NOT NULL,
	"source" varchar(3) NOT NULL,
	"net_income" numeric(18, 2) DEFAULT '0' NOT NULL,
	"net_income_parent" numeric(18, 2) DEFAULT '0' NOT NULL,
	"revenue" numeric(18, 2),
	"cogs" numeric(18, 2),
	"ebit" numeric(18, 2),
	"total_assets" numeric(18, 2),
	"total_liabilities" numeric(18, 2),
	"cash" numeric(18, 2),
	"operating_cash_flow" numeric(18, 2),
	"equity" numeric(18, 2),
	"shares_outstanding" numeric(18, 0),
	"dividends_paid" numeric(18, 2),
	"jcp_paid" numeric(18, 2),
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "wallet_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"target_allocation_percent" numeric(5, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_allocation_range" CHECK ("wallet_assets"."target_allocation_percent" >= 0 AND "wallet_assets"."target_allocation_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_fundamentals" ADD CONSTRAINT "company_fundamentals_company_cnpj_companies_cnpj_fk" FOREIGN KEY ("company_cnpj") REFERENCES "public"."companies"("cnpj") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_assets" ADD CONSTRAINT "wallet_assets_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_api_keys_key" ON "api_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_companies_ticker_lower" ON "companies" USING btree (lower("ticker"));--> statement-breakpoint
CREATE INDEX "idx_companies_sector" ON "companies" USING btree ("sector") WHERE "companies"."sector" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fundamentals_cnpj_year_period" ON "company_fundamentals" USING btree ("company_cnpj","fiscal_year","period","source");--> statement-breakpoint
CREATE INDEX "idx_fundamentals_cnpj" ON "company_fundamentals" USING btree ("company_cnpj");--> statement-breakpoint
CREATE INDEX "idx_fundamentals_cnpj_year" ON "company_fundamentals" USING btree ("company_cnpj","fiscal_year" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_fundamentals_reference_date" ON "company_fundamentals" USING btree ("reference_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_fundamentals_period" ON "company_fundamentals" USING btree ("company_cnpj","period","fiscal_year" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_job_runs_job_id" ON "job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_runs_started" ON "job_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_ticker_type" ON "jobs" USING btree ("ticker","asset_type");--> statement-breakpoint
CREATE INDEX "idx_jobs_next_run" ON "jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_enabled" ON "jobs" USING btree ("enabled") WHERE "jobs"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wallet_assets_wallet_ticker" ON "wallet_assets" USING btree ("wallet_id","ticker");--> statement-breakpoint
CREATE INDEX "idx_wallet_assets_wallet_id" ON "wallet_assets" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "idx_wallet_assets_ticker" ON "wallet_assets" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_wallet_assets_allocation" ON "wallet_assets" USING btree ("wallet_id","target_allocation_percent" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_wallets_user_id" ON "wallets" USING btree ("user_id");