CREATE TYPE "public"."plan" AS ENUM('free', 'pro', 'business');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"type" varchar(64) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"month" char(7) NOT NULL,
	"endpoint" varchar(160) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(100),
	"stripe_customer_id" varchar(64),
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"plan_status" "plan_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD CONSTRAINT "usage_monthly_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_key_month_endpoint" ON "usage_monthly" USING btree ("key_id","month","endpoint");--> statement-breakpoint
CREATE INDEX "idx_usage_user_month" ON "usage_monthly" USING btree ("user_id","month");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- api_keys: migração de "key" em texto plano para "key_hash"/"key_prefix" +
-- vínculo obrigatório com "users". Padrão: colunas novas nullable → backfill
-- via pgcrypto → not null → drop da coluna antiga.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_key_unique";--> statement-breakpoint
DROP INDEX "idx_api_keys_key";--> statement-breakpoint

ALTER TABLE "api_keys" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "key_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "key_prefix" varchar(16);--> statement-breakpoint

-- User admin herda keys pré-existentes (sem dono)
INSERT INTO "users" ("email", "name")
VALUES ('admin@urano.local', 'Admin')
ON CONFLICT ("email") DO NOTHING;--> statement-breakpoint

UPDATE "api_keys" SET
  "user_id" = (SELECT "id" FROM "users" WHERE "email" = 'admin@urano.local'),
  "key_hash" = encode(digest("key", 'sha256'), 'hex'),
  "key_prefix" = left("key", 12)
WHERE "key_hash" IS NULL;--> statement-breakpoint

ALTER TABLE "api_keys" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "key_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "key_prefix" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_unique" UNIQUE ("key_hash");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_user_id" ON "api_keys" USING btree ("user_id");--> statement-breakpoint

ALTER TABLE "api_keys" DROP COLUMN "key";
