-- Strategy year-by-year (top-N vs universe vs IBOV)
CREATE TABLE IF NOT EXISTS "backtest_strategy_years" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "score_version" varchar(20) NOT NULL,
  "n" smallint NOT NULL,
  "year" smallint NOT NULL,
  "portfolio_return" numeric(8, 2) NOT NULL,
  "universe_return" numeric(8, 2) NOT NULL,
  "ibov_return" numeric(8, 2),
  "ibov_source" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_backtest_strategy_run_n_year"
  ON "backtest_strategy_years" ("run_id", "n", "year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_backtest_strategy_run"
  ON "backtest_strategy_years" ("run_id");

-- CVM FII monthly fundamentals (real open data)
CREATE TABLE IF NOT EXISTS "fii_cvm_monthly" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cnpj" char(14) NOT NULL,
  "ticker" varchar(10),
  "fund_name" varchar(255),
  "reference_date" date NOT NULL,
  "net_assets" numeric(20, 2),
  "shares_outstanding" numeric(20, 4),
  "nav_per_share" numeric(18, 6),
  "source" varchar(32) DEFAULT 'cvm_inf_mensal' NOT NULL,
  "raw" jsonb,
  "extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fii_cvm_cnpj_ref"
  ON "fii_cvm_monthly" ("cnpj", "reference_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fii_cvm_ticker_ref"
  ON "fii_cvm_monthly" ("ticker", "reference_date" DESC);
