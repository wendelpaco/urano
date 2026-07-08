import { sql } from 'drizzle-orm';
import {
  pgTable,
  char,
  varchar,
  smallint,
  date,
  uuid,
  decimal,
  timestamp,
  uniqueIndex,
  index,
  check,
  boolean,
} from 'drizzle-orm/pg-core';

// ═══════════════════════════════════════════════════════════════════════════
// companies — Cadastro de empresas listadas na B3
// ═══════════════════════════════════════════════════════════════════════════
export const companies = pgTable(
  'companies',
  {
    cnpj: char('cnpj', { length: 14 }).primaryKey(),
    ticker: varchar('ticker', { length: 10 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    sector: varchar('sector', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_companies_ticker_lower')
      .on(sql`lower(${table.ticker})`),
    index('idx_companies_sector')
      .on(table.sector)
      .where(sql`${table.sector} IS NOT NULL`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// company_fundamentals — Dados fundamentalistas extraídos da CVM (ITR/DFP)
// ═══════════════════════════════════════════════════════════════════════════
export const companyFundamentals = pgTable(
  'company_fundamentals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyCnpj: char('company_cnpj', { length: 14 })
      .notNull()
      .references(() => companies.cnpj, { onDelete: 'cascade', onUpdate: 'cascade' }),
    fiscalYear: smallint('fiscal_year').notNull(),
    period: varchar('period', { length: 5 }).notNull(),
    referenceDate: date('reference_date').notNull(),
    source: varchar('source', { length: 3 }).notNull(),
    netIncome: decimal('net_income', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    netIncomeParent: decimal('net_income_parent', { precision: 18, scale: 2 })
      .notNull()
      .default('0'),
    revenue: decimal('revenue', { precision: 18, scale: 2 }),
    cogs: decimal('cogs', { precision: 18, scale: 2 }),
    ebit: decimal('ebit', { precision: 18, scale: 2 }),
    totalAssets: decimal('total_assets', { precision: 18, scale: 2 }),
    totalLiabilities: decimal('total_liabilities', { precision: 18, scale: 2 }),
    cash: decimal('cash', { precision: 18, scale: 2 }),
    operatingCashFlow: decimal('operating_cash_flow', { precision: 18, scale: 2 }),
    equity: decimal('equity', { precision: 18, scale: 2 }),
    sharesOutstanding: decimal('shares_outstanding', { precision: 18, scale: 0 }),
    dividendsPaid: decimal('dividends_paid', { precision: 18, scale: 2 }),
    jcpPaid: decimal('jcp_paid', { precision: 18, scale: 2 }),
    extractedAt: timestamp('extracted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unique constraint: um registro por CNPJ + Ano + Período + Fonte
    uniqueIndex('uq_fundamentals_cnpj_year_period')
      .on(table.companyCnpj, table.fiscalYear, table.period, table.source),
    // Performance indexes
    index('idx_fundamentals_cnpj').on(table.companyCnpj),
    index('idx_fundamentals_cnpj_year').on(table.companyCnpj, table.fiscalYear.desc()),
    index('idx_fundamentals_reference_date').on(table.referenceDate.desc()),
    index('idx_fundamentals_period').on(table.companyCnpj, table.period, table.fiscalYear.desc()),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// wallets — Carteiras de investimento dos usuários
// ═══════════════════════════════════════════════════════════════════════════
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_wallets_user_id').on(table.userId),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// wallet_assets — Alocação-alvo de ativos dentro de cada carteira
// ═══════════════════════════════════════════════════════════════════════════
export const walletAssets = pgTable(
  'wallet_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    ticker: varchar('ticker', { length: 10 }).notNull(),
    targetAllocationPercent: decimal('target_allocation_percent', {
      precision: 5,
      scale: 2,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_wallet_assets_wallet_ticker').on(table.walletId, table.ticker),
    index('idx_wallet_assets_wallet_id').on(table.walletId),
    index('idx_wallet_assets_ticker').on(table.ticker),
    index('idx_wallet_assets_allocation').on(
      table.walletId,
      table.targetAllocationPercent.desc(),
    ),
    check(
      'chk_allocation_range',
      sql`${table.targetAllocationPercent} >= 0 AND ${table.targetAllocationPercent} <= 100`,
    ),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// jobs — Agendamento de sincronização de dados por ticker
// ═══════════════════════════════════════════════════════════════════════════
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 10 }).notNull(),
    assetType: varchar('asset_type', { length: 10 }).notNull().default('stock'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    priority: smallint('priority').notNull().default(0),
    runInterval: smallint('run_interval').notNull().default(3600), // segundos
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
    lastError: varchar('last_error', { length: 500 }),
    retryCount: smallint('retry_count').notNull().default(0),
    maxRetries: smallint('max_retries').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_jobs_ticker_type').on(table.ticker, table.assetType),
    index('idx_jobs_next_run').on(table.nextRunAt),
    index('idx_jobs_status').on(table.status),
    index('idx_jobs_enabled').on(table.enabled).where(sql`${table.enabled} = true`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// job_runs — Histórico de execução dos jobs
// ═══════════════════════════════════════════════════════════════════════════
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ticker: varchar('ticker', { length: 10 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    durationMs: smallint('duration_ms'),
    errorMessage: varchar('error_message', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_job_runs_job_id').on(table.jobId),
    index('idx_job_runs_started').on(table.startedAt.desc()),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// api_keys — API Keys para autenticação de clientes
// ═══════════════════════════════════════════════════════════════════════════
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    key: varchar('key', { length: 128 }).notNull().unique(),
    active: boolean('active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_api_keys_key').on(table.key),
  ],
);
