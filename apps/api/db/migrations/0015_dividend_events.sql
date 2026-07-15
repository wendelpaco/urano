CREATE TABLE IF NOT EXISTS "dividend_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ticker" varchar(10) NOT NULL,
  "event_date" date NOT NULL,
  "payment_date" date,
  "value" numeric(18, 8) NOT NULL,
  "type" varchar(32) NOT NULL,
  "source" varchar(32) DEFAULT 'statusinvest' NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_dividend_events_ticker_date_type_value"
  ON "dividend_events" ("ticker", "event_date", "type", "value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dividend_events_ticker_date"
  ON "dividend_events" ("ticker", "event_date" DESC);
