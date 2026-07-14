ALTER TABLE "api_keys" ALTER COLUMN "key_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash");