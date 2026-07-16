-- Existing installations can already contain plaintext API keys when 0011
-- adds key_hash. Backfill inside the migration chain so upgrades do not rely
-- on an out-of-band script between 0011 and this NOT NULL constraint.
UPDATE "api_keys"
SET "key_hash" = encode(sha256(convert_to("key", 'UTF8')), 'hex')
WHERE "key_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "key_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash");
