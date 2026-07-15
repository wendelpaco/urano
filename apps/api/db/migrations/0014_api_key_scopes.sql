-- API key ownership + scopes (critical security package)
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "owner_id" uuid;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT ARRAY['read:market','write:wallet','admin:keys','admin:ops']::text[] NOT NULL;

-- Existing keys: self-owned bootstrap with full scopes
UPDATE "api_keys" SET "owner_id" = "id" WHERE "owner_id" IS NULL;
UPDATE "api_keys" SET "scopes" = ARRAY['read:market','write:wallet','admin:keys','admin:ops']::text[] WHERE "scopes" IS NULL OR cardinality("scopes") = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_owner_id_api_keys_id_fk'
  ) THEN
    ALTER TABLE "api_keys"
      ADD CONSTRAINT "api_keys_owner_id_api_keys_id_fk"
      FOREIGN KEY ("owner_id") REFERENCES "api_keys"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_api_keys_owner_id" ON "api_keys" ("owner_id");
