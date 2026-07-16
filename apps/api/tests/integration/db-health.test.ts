/**
 * Integração leve com Postgres real.
 *
 * Roda quando:
 *   - CI=true (GitHub Actions com service postgres), ou
 *   - RUN_INTEGRATION=1 (local consciente)
 *
 * Usa o driver `postgres` diretamente — NÃO importa connection.ts —
 * para não herdar mock.module de outros arquivos de teste (ex: healthcheck).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

const shouldRun =
  Boolean(process.env.DATABASE_URL) &&
  (process.env.CI === 'true' || process.env.RUN_INTEGRATION === '1');

describe.skipIf(!shouldRun)('integration: postgres', () => {
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  test('conecta e responde SELECT 1', async () => {
    const rows = await sql`SELECT 1 AS ok`;
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.ok)).toBe(1);
  });

  test('tabelas críticas existem (após migrate)', async () => {
    const expected = [
      'companies',
      'company_fundamentals',
      'api_keys',
      'backtest_results',
      'backtest_strategy_years',
      'dividend_events',
      'fii_cvm_monthly',
      'fii_backtest_years',
    ] as const;

    const rows = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ${sql(expected as unknown as string[])}
    `;
    const names = new Set(rows.map((r) => String(r.table_name)));
    for (const t of expected) {
      expect(names.has(t)).toBe(true);
    }
  });

  test('api_keys tem colunas de hash e scopes', async () => {
    const rows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'api_keys'
        AND column_name IN ('key_hash', 'scopes', 'owner_id')
    `;
    const cols = new Set(rows.map((r) => String(r.column_name)));
    expect(cols.has('key_hash')).toBe(true);
    expect(cols.has('scopes')).toBe(true);
    expect(cols.has('owner_id')).toBe(true);
  });

  test('api_keys owner e duração de jobs têm constraints de produção', async () => {
    const foreignKeys = await sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'api_keys'
        AND constraint_type = 'FOREIGN KEY'
    `;
    expect(
      foreignKeys.some((row) =>
        String(row.constraint_name).includes('api_keys_owner_id_api_keys_id_fk'),
      ),
    ).toBe(true);

    const duration = await sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'job_runs'
        AND column_name = 'duration_ms'
    `;
    expect(String(duration[0]?.data_type)).toBe('integer');
  });
});

// Sempre registra um teste no-op para o arquivo carregar sem CI
test('integration db-health suite loads', () => {
  expect(true).toBe(true);
});
