-- Custódia real por ativo na carteira (além do % alvo).
ALTER TABLE "wallet_assets" ADD COLUMN IF NOT EXISTS "quantity" numeric(18, 6);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_wallet_asset_quantity_nonneg'
  ) THEN
    ALTER TABLE "wallet_assets"
      ADD CONSTRAINT "chk_wallet_asset_quantity_nonneg"
      CHECK (quantity IS NULL OR quantity >= 0);
  END IF;
END $$;
