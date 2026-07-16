-- SEC-1r: Remove legacy plaintext API key column and its index.
-- The `key` column stored plaintext keys; new code writes `ur_hashonly_<prefix>`
-- and authentication uses `key_hash` exclusively. This column has been dead
-- surface since commit 80245df. Dropping eliminates the risk of exposing
-- legacy rows that may still contain cleartext keys.
DROP INDEX IF EXISTS "idx_api_keys_key";
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "key";
