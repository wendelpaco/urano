import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  char,
  varchar,
  smallint,
  integer,
  date,
  uuid,
  decimal,
  timestamp,
  uniqueIndex,
  index,
  check,
  boolean,
} from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan', ['free', 'pro', 'business']);
export const planStatusEnum = pgEnum('plan_status', ['active', 'past_due', 'canceled']);

// ═══════════════════════════════════════════════════════════════════════════
// users — Contas de clientes da API
// ═══════════════════════════════════════════════════════════════════════════
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: varchar('name', { length: 100 }),
    stripeCustomerId: varchar('stripe_customer_id', { length: 64 }).unique(),
    plan: planEnum('plan').notNull().default('free'),
    planStatus: planStatusEnum('plan_status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
);

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
// daily_snapshots — Snapshot diário de indicadores para treinamento de ML
// ═══════════════════════════════════════════════════════════════════════════
export const dailySnapshots = pgTable(
  'daily_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 10 }).notNull(),
    assetType: varchar('asset_type', { length: 10 }).notNull().default('stock'),
    snapshotDate: date('snapshot_date').notNull().defaultNow(),

    // ── Mercado ──
    price: decimal('price', { precision: 12, scale: 2 }),
    dy12m: decimal('dy_12m', { precision: 6, scale: 2 }),
    pl: decimal('pl', { precision: 8, scale: 2 }),
    pvp: decimal('pvp', { precision: 8, scale: 2 }),
    evEbitda: decimal('ev_ebitda', { precision: 8, scale: 2 }),
    evEbit: decimal('ev_ebit', { precision: 8, scale: 2 }),
    vpa: decimal('vpa', { precision: 10, scale: 2 }),
    lpa: decimal('lpa', { precision: 10, scale: 2 }),
    marketCap: decimal('market_cap', { precision: 18, scale: 2 }),
    avgLiquidity: decimal('avg_liquidity', { precision: 18, scale: 2 }),
    min52w: decimal('min_52w', { precision: 10, scale: 2 }),
    max52w: decimal('max_52w', { precision: 10, scale: 2 }),
    valorization12m: decimal('valorization_12m', { precision: 6, scale: 2 }),
    volatility: decimal('volatility', { precision: 6, scale: 2 }),

    // ── Rentabilidade ──
    roe: decimal('roe', { precision: 6, scale: 2 }),
    roa: decimal('roa', { precision: 6, scale: 2 }),
    roic: decimal('roic', { precision: 6, scale: 2 }),
    grossMargin: decimal('gross_margin', { precision: 6, scale: 2 }),
    ebitdaMargin: decimal('ebitda_margin', { precision: 6, scale: 2 }),
    ebitMargin: decimal('ebit_margin', { precision: 6, scale: 2 }),
    netMargin: decimal('net_margin', { precision: 6, scale: 2 }),

    // ── Crescimento ──
    cagrRevenue5y: decimal('cagr_revenue_5y', { precision: 6, scale: 2 }),
    cagrEarnings5y: decimal('cagr_earnings_5y', { precision: 6, scale: 2 }),
    dyCagr3y: decimal('dy_cagr_3y', { precision: 6, scale: 2 }),
    valueCagr3y: decimal('value_cagr_3y', { precision: 6, scale: 2 }),

    // ── Endividamento / Saúde Financeira ──
    netDebtToEquity: decimal('net_debt_to_equity', { precision: 6, scale: 2 }),
    netDebtToEbitda: decimal('net_debt_to_ebitda', { precision: 6, scale: 2 }),
    currentRatio: decimal('current_ratio', { precision: 6, scale: 2 }),
    assetTurnover: decimal('asset_turnover', { precision: 6, scale: 2 }),

    // ── FII específicos ──
    bookValue: decimal('book_value', { precision: 10, scale: 2 }),
    avgMonthlyIncome: decimal('avg_monthly_income', { precision: 10, scale: 4 }),
    numShareholders: integer('num_shareholders'),
    cashValue: decimal('cash_value', { precision: 14, scale: 2 }),
    ifixParticipation: decimal('ifix_participation', { precision: 6, scale: 2 }),

    // ── Score calculado ──
    ourScore: decimal('our_score', { precision: 5, scale: 2 }),

    // ── Metadados ──
    source: varchar('source', { length: 20 }).default('statusinvest'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_snapshot_ticker_date').on(table.ticker, table.snapshotDate),
    index('idx_snapshot_date').on(table.snapshotDate.desc()),
    index('idx_snapshot_ticker').on(table.ticker),
    index('idx_snapshot_type_date').on(table.assetType, table.snapshotDate.desc()),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// api_keys — API Keys para autenticação de clientes
// ═══════════════════════════════════════════════════════════════════════════
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    active: boolean('active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_api_keys_user_id').on(table.userId),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// usage_monthly — Uso agregado por key/mês/endpoint (flush do Redis a cada 5min)
// endpoint '_total' representa o agregado do mês da key
// ═══════════════════════════════════════════════════════════════════════════
export const usageMonthly = pgTable(
  'usage_monthly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: uuid('key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    month: char('month', { length: 7 }).notNull(),
    endpoint: varchar('endpoint', { length: 160 }).notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_usage_key_month_endpoint').on(table.keyId, table.month, table.endpoint),
    index('idx_usage_user_month').on(table.userId, table.month),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// stripe_events — Idempotência de webhooks Stripe
// ═══════════════════════════════════════════════════════════════════════════
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
);
