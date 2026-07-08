CREATE TABLE "backtest_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"score_version" varchar(20) NOT NULL,
	"year" smallint NOT NULL,
	"ticker" varchar(10) NOT NULL,
	"score" smallint NOT NULL,
	"valuation" smallint NOT NULL,
	"profitability" smallint NOT NULL,
	"growth" smallint NOT NULL,
	"dividends" smallint NOT NULL,
	"quality" smallint NOT NULL,
	"momentum" smallint NOT NULL,
	"start_price" numeric(12, 2) NOT NULL,
	"end_price" numeric(12, 2),
	"return_12m" numeric(8, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_backtest_run_year_ticker" ON "backtest_results" USING btree ("run_id","year","ticker");--> statement-breakpoint
CREATE INDEX "idx_backtest_run" ON "backtest_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_backtest_ticker" ON "backtest_results" USING btree ("ticker");