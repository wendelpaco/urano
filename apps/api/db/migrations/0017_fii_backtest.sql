CREATE TABLE IF NOT EXISTS "fii_backtest_years" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "ticker" varchar(10) NOT NULL,
  "year" smallint NOT NULL,
  "start_price" numeric(12, 4),
  "end_price" numeric(12, 4),
  "price_return_pct" numeric(8, 2),
  "dividend_return_pct" numeric(8, 2),
  "total_return_pct" numeric(8, 2),
  "dividends_sum" numeric(12, 6),
  "dividend_events" smallint DEFAULT 0,
  "score" smallint,
  "pvp" numeric(8, 4),
  "price_source" varchar(32),
  "div_source" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fii_backtest_run_ticker_year"
  ON "fii_backtest_years" ("run_id", "ticker", "year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fii_backtest_run" ON "fii_backtest_years" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fii_backtest_ticker_year" ON "fii_backtest_years" ("ticker", "year");

CREATE TABLE IF NOT EXISTS "fii_backtest_dy_pairs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "ticker" varchar(10) NOT NULL,
  "year" smallint NOT NULL,
  "next_year" smallint NOT NULL,
  "trailing_dy_pct" numeric(8, 2) NOT NULL,
  "next_total_return_pct" numeric(8, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fii_dy_pairs_run" ON "fii_backtest_dy_pairs" ("run_id");
