/**
 * AllocationEngine — Motor de alocação de investimentos.
 *
 * Dado um mix legado e valor a investir, filtra ativos por qualidade
 * e distribui o capital com base em scores, preços observados,
 * fundamentos oficiais (CVM) e diversificação setorial.
 *
 * Diferente do easy-invest PortfolioBuilder (que usava estimativas falsas
 * de preço e dividendos), este motor usa dados concretos do Urano.
 */

import { db } from '../../infra/database/connection.ts';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { stockQuoteService } from '../../infra/services/stock-quote-service.ts';
import { dividendsProvider } from '../../infra/services/dividends-provider.ts';
import { fiiOperationalService } from '../../infra/services/fii-operational.service.ts';
import { redis } from '../../infra/services/redis.ts';
import { calcAllIndicators } from './indicators.ts';
import { StockScoreCalculator } from './stock-score.ts';
import { STOCK_UNITS_SQL_LIST } from '../../shared/ticker-utils.ts';
import {
  FIIScoreCalculatorV4,
  type FIIScoreInput,
} from './fii-score.ts';
import {
  incomeDistributionsSince,
  sumIncomeDistributions,
} from './dividend-income.ts';
import { RISK_CONFIGS, type RiskProfile } from '../data/risk-profiles.ts';
import { getFIIClassification } from '../data/fii-classification.data.ts';
import { SCORE_VALIDATION } from '../data/score-validation.data.ts';

// REL-2: executa até `limit` promises em paralelo para limitar pressão no upstream.
async function withConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number = 5,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export type AnalyzedAsset = {
  ticker: string;
  name: string;
  score: number;
  price: number;
  reasons: string[];
  alerts: string[];
  sector: string | null;
  /** Dividend yield 12m em % (null = indisponível). IMP-6. */
  dividendYield?: number | null;
  fiiType?: 'papel' | 'tijolo' | 'hibrido';
  dataCoverage?: {
    percent: number;
    criticalComplete: boolean;
    missingFields: string[];
  };
};

type AnalyzedUniverse = {
  assets: AnalyzedAsset[];
  expected: number;
  expectedGroups?: { papel: number; fisico: number };
};

type CanonicalUniverseEnvelope = {
  version: 'v4';
  generation: string;
  generatedAt: string;
  expected: number;
  successful: number;
  eligible: number;
  coveragePercent: number;
  status: 'available' | 'unavailable';
  reason: string | null;
  data: AnalyzedAsset[];
};

export interface DecisionUniverseAvailability {
  stocks: 'available' | 'unavailable';
  fiis: 'available' | 'unavailable';
  warnings: string[];
}

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type { RiskProfile };

export interface AllocationConfig {
  totalAmount: number;
  riskProfile: RiskProfile;
  stockPercent: number;  // 0-100
  fiiPercent: number;     // 0-100 (deve somar 100 com stockPercent)
  minScore: number;       // score mínimo para inclusão
  maxAssets: number;      // máximo de ativos na carteira
}

export interface AllocatedAsset {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  score: number;
  price: number;
  allocationPercent: number;
  allocationAmount: number;
  quantity: number;
  /** Dividend yield 12m em % (null = indisponível). Usado em IMP-6. */
  dividendYield: number | null;
  /** Motivos para incluir este ativo */
  reasons: string[];
  /** Riscos a considerar */
  alerts: string[];
}

export interface AllocationResult {
  config: AllocationConfig;
  assets: AllocatedAsset[];
  dataAvailability: DecisionUniverseAvailability;
  warnings: string[];
  summary: {
    totalAssets: number;
    stocks: number;
    fiis: number;
    totalInvested: number;
    remainingCash: number;
    averageScore: number;
    /** Indisponivel ate que todos os ativos tenham DY rastreavel e comparavel. */
    estimatedAnnualDividend: number | null;
    estimatedMonthlyDividend: number | null;
    estimatedDividendYield: number | null;
    /** IMP-6: full = todos com DY, partial = alguns com DY, unavailable = nenhum. */
    dividendEstimateStatus: 'full' | 'partial' | 'unavailable';
  };
}

export class AllocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationValidationError';
  }
}

export class AllocationDataUnavailableError extends Error {
  constructor(message = 'Rankings canônicos indisponíveis; execute o aquecimento de dados antes da alocação.') {
    super(message);
    this.name = 'AllocationDataUnavailableError';
  }
}

const DECISION_UNIVERSE_TTL_SECONDS = 3_600;
const MIN_SUCCESS_COVERAGE = 0.8;
const MIN_FII_COMPLETE_COVERAGE = 0.6;
const canonicalDecisionUniverseKey = (type: 'stock' | 'fii'): string =>
  `decision:universe:v4:${type}`;

function parseCanonicalRanking(
  raw: string,
  type: 'stock' | 'fii',
): {
  assets: AnalyzedAsset[];
  generation: string;
  status: 'available' | 'unavailable';
  reason: string | null;
} {
  let envelope: CanonicalUniverseEnvelope;
  try {
    envelope = JSON.parse(raw) as CanonicalUniverseEnvelope;
  } catch {
    throw new AllocationDataUnavailableError(`Ranking canônico de ${type} está corrompido.`);
  }
  if (
    envelope.version !== 'v4'
    || !envelope.generation
    || !Number.isFinite(envelope.expected)
    || envelope.expected <= 0
    || !Number.isFinite(envelope.successful)
    || !Number.isFinite(envelope.eligible)
    || !['available', 'unavailable'].includes(envelope.status)
  ) {
    throw new AllocationDataUnavailableError(
      `Ranking canônico de ${type} não possui metadados de cobertura válidos.`,
    );
  }
  const rows: unknown = envelope.data;
  if (!Array.isArray(rows)) {
    throw new AllocationDataUnavailableError(`Ranking canônico de ${type} possui formato inválido.`);
  }

  const assets = rows.flatMap((row): AnalyzedAsset[] => {
    if (!row || typeof row !== 'object') return [];
    const value = row as Record<string, unknown>;
    const ticker = typeof value.ticker === 'string' ? value.ticker.trim().toUpperCase() : '';
    const score = Number(value.score);
    const price = Number(value.price);
    if (!ticker || !Number.isFinite(score) || score <= 0 || !Number.isFinite(price) || price <= 0) {
      return [];
    }
    return [{
      ticker,
      name: typeof value.name === 'string' && value.name.trim() ? value.name : ticker,
      score,
      price,
      reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : [],
      alerts: Array.isArray(value.alerts) ? value.alerts.map(String) : [],
      sector: typeof value.sector === 'string' && value.sector.trim() ? value.sector : null,
    }];
  });

  if (assets.length === 0 && envelope.status === 'available') {
    throw new AllocationDataUnavailableError(`Ranking canônico de ${type} está vazio.`);
  }
  if (assets.length !== envelope.eligible) {
    throw new AllocationDataUnavailableError(
      `Ranking canônico de ${type} perdeu ativos durante a validação.`,
    );
  }
  return {
    assets,
    generation: envelope.generation,
    status: envelope.status,
    reason: envelope.reason ?? null,
  };
}

/**
 * Carrega um snapshot canônico já materializado. Nunca inicia centenas de
 * chamadas externas dentro de uma requisição HTTP.
 */
export async function loadCanonicalDecisionUniverse(): Promise<{
  stocks: AnalyzedAsset[];
  fiis: AnalyzedAsset[];
  availability: DecisionUniverseAvailability;
}> {
  let stockRaw: string | null;
  let fiiRaw: string | null;
  try {
    const snapshots = await redis.mget(
      canonicalDecisionUniverseKey('stock'),
      canonicalDecisionUniverseKey('fii'),
    );
    stockRaw = snapshots[0] ?? null;
    fiiRaw = snapshots[1] ?? null;
  } catch {
    throw new AllocationDataUnavailableError('Cache dos rankings canônicos está indisponível.');
  }
  if (!stockRaw || !fiiRaw) {
    throw new AllocationDataUnavailableError();
  }
  const stockSnapshot = parseCanonicalRanking(stockRaw, 'stock');
  const fiiSnapshot = parseCanonicalRanking(fiiRaw, 'fii');
  if (stockSnapshot.generation !== fiiSnapshot.generation) {
    throw new AllocationDataUnavailableError(
      'As classes do universo canônico pertencem a gerações diferentes.',
    );
  }
  return {
    stocks: stockSnapshot.assets,
    fiis: fiiSnapshot.assets,
    availability: {
      stocks: stockSnapshot.status,
      fiis: fiiSnapshot.status,
      warnings: [
        ...(stockSnapshot.status === 'unavailable'
          ? [
              stockSnapshot.reason
                ?? 'Ações indisponíveis para decisão; orçamento mantido em caixa.',
            ]
          : []),
        ...(fiiSnapshot.status === 'unavailable'
          ? [
              fiiSnapshot.reason
                ?? 'FIIs indisponíveis por cobertura insuficiente; orçamento mantido em caixa.',
            ]
          : []),
      ],
    },
  };
}

/** Materializa em background o mesmo universo completo usado pela alocacao. */
export async function materializeCanonicalDecisionUniverse(): Promise<{
  stocks: number;
  fiis: number;
  expectedStocks: number;
  expectedFiis: number;
  stockStatus: 'available' | 'unavailable';
  fiiStatus: 'available' | 'unavailable';
}> {
  const engine = new AllocationEngine();
  const [stockAnalysis, fiiAnalysis] = await Promise.all([
    engine.analyzeAllStocks(),
    engine.analyzeAllFiis(),
  ]);
  if (stockAnalysis.expected === 0) {
    throw new AllocationDataUnavailableError(
      'O banco nao produziu candidatos de ações; snapshot anterior foi preservado.',
    );
  }

  const stockCoverage = stockAnalysis.assets.length / stockAnalysis.expected;
  const fiiSuccessCoverage = fiiAnalysis.expected > 0
    ? fiiAnalysis.assets.length / fiiAnalysis.expected
    : 0;
  const eligibleFiis = fiiAnalysis.assets.filter(
    (asset) => asset.dataCoverage?.criticalComplete === true,
  );
  const fiiCompleteCoverage = fiiAnalysis.expected > 0
    ? eligibleFiis.length / fiiAnalysis.expected
    : 0;

  if (
    stockCoverage < MIN_SUCCESS_COVERAGE
    || (fiiAnalysis.expected > 0 && fiiSuccessCoverage < MIN_SUCCESS_COVERAGE)
  ) {
    throw new AllocationDataUnavailableError(
      'Cobertura insuficiente para publicar o universo de decisao: '
      + `acoes ${stockAnalysis.assets.length}/${stockAnalysis.expected}; `
      + `FIIs cotados ${fiiAnalysis.assets.length}/${fiiAnalysis.expected}; `
      + `FIIs comparaveis ${eligibleFiis.length}/${fiiAnalysis.expected}. `
      + 'O snapshot anterior foi preservado.',
    );
  }

  const fiiUnavailableReasons: string[] = [];
  if (fiiAnalysis.expected === 0) {
    fiiUnavailableReasons.push('nenhum candidato FII disponível no banco');
  } else if (fiiCompleteCoverage < MIN_FII_COMPLETE_COVERAGE) {
    fiiUnavailableReasons.push(
      `cobertura comparável total ${eligibleFiis.length}/${fiiAnalysis.expected}`,
    );
  }

  for (const group of ['papel', 'fisico'] as const) {
    const expected = fiiAnalysis.expectedGroups?.[group] ?? 0;
    const complete = eligibleFiis.filter((asset) =>
      group === 'papel' ? asset.fiiType === 'papel' : asset.fiiType !== 'papel'
    ).length;
    if (expected > 0 && complete / expected < MIN_FII_COMPLETE_COVERAGE) {
      fiiUnavailableReasons.push(
        `cobertura comparável de ${group} ${complete}/${expected}`,
      );
    }
  }
  const fiiStatus = fiiUnavailableReasons.length === 0
    ? 'available' as const
    : 'unavailable' as const;
  const publishedFiis = fiiStatus === 'available' ? eligibleFiis : [];
  const fiiReason = fiiStatus === 'unavailable'
    ? `Classe FII indisponível (${fiiUnavailableReasons.join('; ')}); `
      + 'o orçamento correspondente será mantido em caixa.'
    : null;
  const stockStatus = SCORE_VALIDATION.decisionUseAllowed
    ? 'available' as const
    : 'unavailable' as const;
  const publishedStocks = stockStatus === 'available'
    ? stockAnalysis.assets
    : [];
  const stockReason = stockStatus === 'unavailable'
    ? 'Classe ação indisponível para alocação: o score está com uso decisório bloqueado '
      + `(${SCORE_VALIDATION.decisionBlockers.join('; ')}). O orçamento será mantido em caixa.`
    : null;

  const generatedAt = new Date().toISOString();
  const generation = randomUUID();
  const stockEnvelope: CanonicalUniverseEnvelope = {
    version: 'v4',
    generation,
    generatedAt,
    expected: stockAnalysis.expected,
    successful: stockAnalysis.assets.length,
    eligible: publishedStocks.length,
    coveragePercent: Math.round(stockCoverage * 100),
    status: stockStatus,
    reason: stockReason,
    data: publishedStocks,
  };
  const fiiEnvelope: CanonicalUniverseEnvelope = {
    version: 'v4',
    generation,
    generatedAt,
    expected: fiiAnalysis.expected,
    successful: fiiAnalysis.assets.length,
    eligible: publishedFiis.length,
    coveragePercent: Math.round(fiiCompleteCoverage * 100),
    status: fiiStatus,
    reason: fiiReason,
    data: publishedFiis,
  };

  const transaction = redis.multi();
  transaction.set(
    canonicalDecisionUniverseKey('stock'),
    JSON.stringify(stockEnvelope),
    'EX',
    DECISION_UNIVERSE_TTL_SECONDS,
  );
  transaction.set(
    canonicalDecisionUniverseKey('fii'),
    JSON.stringify(fiiEnvelope),
    'EX',
    DECISION_UNIVERSE_TTL_SECONDS,
  );
  const published = await transaction.exec();
  if (!published || published.some(([error]) => error !== null)) {
    throw new AllocationDataUnavailableError(
      'Falha ao publicar atomicamente o universo canônico.',
    );
  }
  return {
    stocks: publishedStocks.length,
    fiis: publishedFiis.length,
    expectedStocks: stockAnalysis.expected,
    expectedFiis: fiiAnalysis.expected,
    stockStatus,
    fiiStatus,
  };
}

export async function refreshCanonicalDecisionUniverseIfNeeded(
  minRemainingTtlSeconds = 900,
): Promise<'fresh' | 'refreshed'> {
  const [stockTtl, fiiTtl] = await Promise.all([
    redis.ttl(canonicalDecisionUniverseKey('stock')),
    redis.ttl(canonicalDecisionUniverseKey('fii')),
  ]);
  if (stockTtl >= minRemainingTtlSeconds && fiiTtl >= minRemainingTtlSeconds) {
    return 'fresh';
  }
  await materializeCanonicalDecisionUniverse();
  return 'refreshed';
}

/** Resolve o percentual omitido como complemento do percentual informado. */
export function resolveAllocationPercentages(
  stockPercent: number | undefined,
  fiiPercent: number | undefined,
  defaults: { stockPercent: number; fiiPercent: number },
): { stockPercent: number; fiiPercent: number } {
  if (stockPercent !== undefined && fiiPercent === undefined) {
    return { stockPercent, fiiPercent: 100 - stockPercent };
  }
  if (stockPercent === undefined && fiiPercent !== undefined) {
    return { stockPercent: 100 - fiiPercent, fiiPercent };
  }
  return {
    stockPercent: stockPercent ?? defaults.stockPercent,
    fiiPercent: fiiPercent ?? defaults.fiiPercent,
  };
}

export function validateAllocationConfig(config: AllocationConfig): void {
  if (!Number.isFinite(config.totalAmount) || config.totalAmount <= 0) {
    throw new AllocationValidationError('Valor total deve ser positivo e finito.');
  }
  if (
    !Number.isFinite(config.stockPercent) ||
    !Number.isFinite(config.fiiPercent) ||
    config.stockPercent < 0 ||
    config.stockPercent > 100 ||
    config.fiiPercent < 0 ||
    config.fiiPercent > 100
  ) {
    throw new AllocationValidationError('Percentuais devem estar entre 0% e 100%.');
  }
  const totalPercent = config.stockPercent + config.fiiPercent;
  if (Math.abs(totalPercent - 100) > 0.01) {
    throw new AllocationValidationError(
      `Percentuais globais devem somar 100% (recebido: ${totalPercent.toFixed(2)}%).`,
    );
  }
  if (!Number.isInteger(config.maxAssets) || config.maxAssets < 1 || config.maxAssets > 20) {
    throw new AllocationValidationError('Quantidade maxima de ativos deve estar entre 1 e 20.');
  }
  if (!Number.isFinite(config.minScore) || config.minScore < 0 || config.minScore > 100) {
    throw new AllocationValidationError('Score minimo deve estar entre 0 e 100.');
  }
}

/**
 * Converte orcamento teorico em ordens inteiras executaveis.
 * `allocationAmount` sempre representa custo real (quantidade x preco), e
 * ativos que nao cabem no orcamento nao sao contabilizados como investidos.
 */
export function allocateWholeUnits<
  T extends {
    ticker: string;
    name: string;
    score: number;
    price: number;
    reasons: string[];
    alerts: string[];
    dividendYield?: number | null;
  },
>(
  assets: T[],
  budget: number,
  totalAmount: number,
  assetType: 'stock' | 'fii',
): AllocatedAsset[] {
  if (assets.length === 0 || budget <= 0 || totalAmount <= 0) return [];

  const validAssets = assets.filter(
    (asset) =>
      Number.isFinite(asset.score) &&
      asset.score > 0 &&
      Number.isFinite(asset.price) &&
      asset.price > 0,
  );
  if (validAssets.length === 0) return [];
  const equalTargetAmount = budget / validAssets.length;

  return validAssets.flatMap((asset): AllocatedAsset[] => {
    const quantity = Math.max(0, Math.floor(equalTargetAmount / asset.price));
    if (quantity === 0) return [];

    const actualCost = roundMoney(quantity * asset.price);
    return [{
      ticker: asset.ticker,
      name: asset.name,
      assetType,
      score: asset.score,
      price: asset.price,
      allocationPercent: Math.round((actualCost / totalAmount) * 1_000) / 10,
      allocationAmount: actualCost,
      quantity,
      dividendYield: asset.dividendYield ?? null,
      reasons: asset.reasons,
      alerts: asset.alerts,
    }];
  });
}

export function summarizeAllocation(
  totalAmount: number,
  allocatedStocks: AllocatedAsset[],
  allocatedFiis: AllocatedAsset[],
): AllocationResult['summary'] {
  const allAssets = [...allocatedStocks, ...allocatedFiis];
  const totalInvested = roundMoney(
    allAssets.reduce((sum, asset) => sum + asset.allocationAmount, 0),
  );
  if (totalInvested > totalAmount + 0.01) {
    throw new AllocationValidationError('Custo executavel excedeu o valor total.');
  }
  const averageScore = allAssets.length > 0
    ? Math.round(allAssets.reduce((sum, asset) => sum + asset.score, 0) / allAssets.length)
    : 0;

  // IMP-6: estimativa de renda real usando DY 12m por ativo.
  let totalAnnualDividend = 0;
  let assetsWithDy = 0;
  for (const asset of allAssets) {
    if (asset.dividendYield !== null && asset.dividendYield > 0) {
      totalAnnualDividend += asset.allocationAmount * (asset.dividendYield / 100);
      assetsWithDy++;
    }
  }
  const estimatedAnnualDividend = assetsWithDy > 0 ? roundMoney(totalAnnualDividend) : null;
  const estimatedMonthlyDividend = estimatedAnnualDividend !== null
    ? roundMoney(estimatedAnnualDividend / 12)
    : null;
  const estimatedDividendYield = totalInvested > 0 && estimatedAnnualDividend !== null
    ? +((estimatedAnnualDividend / totalInvested) * 100).toFixed(2)
    : null;
  const dividendEstimateStatus: 'full' | 'partial' | 'unavailable' =
    allAssets.length === 0 ? 'unavailable'
    : assetsWithDy === allAssets.length ? 'full'
    : assetsWithDy > 0 ? 'partial'
    : 'unavailable';

  return {
    totalAssets: allAssets.length,
    stocks: allocatedStocks.length,
    fiis: allocatedFiis.length,
    totalInvested,
    remainingCash: Math.max(0, roundMoney(totalAmount - totalInvested)),
    averageScore,
    estimatedAnnualDividend,
    estimatedMonthlyDividend,
    estimatedDividendYield,
    dividendEstimateStatus,
  };
}

// ─── Motor ───────────────────────────────────────────────────────────────────

export class AllocationEngine {
  /**
   * Constroi um cenario experimental de alocacao por score e mix de ativos.
   * A validação ponto-no-tempo do score está pendente — ver SCORE_VALIDATION.
   */
  async buildAllocation(
    config?: Partial<AllocationConfig>,
  ): Promise<AllocationResult> {
    const profile = config?.riskProfile ?? 'moderado';
    const profileConfig = RISK_CONFIGS[profile];
    const percentages = resolveAllocationPercentages(
      config?.stockPercent,
      config?.fiiPercent,
      profileConfig,
    );

    const finalConfig: AllocationConfig = {
      totalAmount: config?.totalAmount ?? 10_000,
      riskProfile: profile,
      stockPercent: percentages.stockPercent,
      fiiPercent: percentages.fiiPercent,
      minScore: config?.minScore ?? profileConfig.minScore,
      maxAssets: config?.maxAssets ?? profileConfig.maxAssets,
    };
    validateAllocationConfig(finalConfig);

    // Cache de resposta (mesmo perfil/valor) — evita re-scrape a cada clique
    const cacheKey =
      `allocation:v4:${finalConfig.riskProfile}:${finalConfig.totalAmount}:` +
      `${finalConfig.minScore}:${finalConfig.maxAssets}:` +
      `${finalConfig.stockPercent}:${finalConfig.fiiPercent}`;
    try {
      const hit = await redis.get(cacheKey);
      if (hit) return JSON.parse(hit) as AllocationResult;
    } catch { /* redis offline */ }

    // O caminho HTTP nunca recalcula ~200 ativos em linha. Usa somente o
    // universo canônico v4 materializado; sem ele, falha rápido e com diagnóstico.
    const { stocks, fiis, availability } = await loadCanonicalDecisionUniverse();

    // Filtra por score mínimo e ordena
    const eligibleStocks = stocks
      .filter((s) => s.score > 0 && s.score >= finalConfig.minScore && s.price > 0)
      .sort((a, b) => b.score - a.score);

    const eligibleFiis = fiis
      .filter((f) => f.score > 0 && f.score >= finalConfig.minScore && f.price > 0)
      .sort((a, b) => b.score - a.score);

    // Seleciona com diversificação setorial
    const stockBudget = (finalConfig.totalAmount * finalConfig.stockPercent) / 100;
    const fiiBudget = (finalConfig.totalAmount * finalConfig.fiiPercent) / 100;

    const maxStocks = Math.round(finalConfig.maxAssets * (finalConfig.stockPercent / 100));
    const maxFiis = finalConfig.maxAssets - maxStocks;

    // Candidatos extras: refresh de preço só nos finalistas (não nos 100+ do universo)
    const stockCandidates = this.selectDiversified(eligibleStocks, Math.max(maxStocks * 2, maxStocks));
    const fiiCandidates = this.selectDiversified(eligibleFiis, Math.max(maxFiis * 2, maxFiis));
    await this.refreshPrices(stockCandidates);
    await this.refreshPrices(fiiCandidates);

    const selectedStocks = this.selectDiversified(
      stockCandidates.filter((s) => s.price > 0),
      maxStocks,
    );
    const selectedFiis = this.selectDiversified(
      fiiCandidates.filter((f) => f.price > 0),
      maxFiis,
    );

    const allocatedStocks = allocateWholeUnits(
      selectedStocks,
      stockBudget,
      finalConfig.totalAmount,
      'stock',
    );
    const allocatedFiis = allocateWholeUnits(
      selectedFiis,
      fiiBudget,
      finalConfig.totalAmount,
      'fii',
    );

    const allAssets = [...allocatedStocks, ...allocatedFiis];

    const result: AllocationResult = {
      config: finalConfig,
      assets: allAssets,
      dataAvailability: availability,
      warnings: availability.warnings,
      summary: summarizeAllocation(
        finalConfig.totalAmount,
        allocatedStocks,
        allocatedFiis,
      ),
    };

    try {
      await redis.setex(cacheKey, 300, JSON.stringify(result));
    } catch { /* ok */ }

    return result;
  }

  /** Atualiza preço só dos candidatos finais (poucos getQuote). */
  private async refreshPrices(assets: AnalyzedAsset[]): Promise<void> {
    for (const a of assets) {
      try {
        const q = await stockQuoteService.getQuote(a.ticker);
        if (q.price > 0) a.price = q.price;
      } catch {
        // mantém preço do cache
      }
    }
  }

  // ─── Análise ──────────────────────────────────────────────────────────

  async analyzeAllStocks(): Promise<AnalyzedUniverse> {
    // ENG-3r: removido LIMIT 100 para analisar universo completo.
    // REL-2: execução concorrente (5 simultâneos) para reduzir latência.
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (c.ticker)
        c.ticker, c.name, c.sector,
        cf.net_income_parent, cf.revenue, cf.cogs, cf.ebit,
        cf.total_assets, cf.total_liabilities, cf.cash,
        cf.operating_cash_flow, cf.equity, cf.shares_outstanding,
        cf.reference_date
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE (c.ticker NOT LIKE '%11' OR c.ticker IN (${sql.join(
        STOCK_UNITS_SQL_LIST.map(u => sql`${u}`),
        sql`, `
      )}))
        AND LENGTH(c.ticker) >= 5
      ORDER BY c.ticker, cf.source = 'DFP' DESC, cf.reference_date DESC
    `);

    const candidates = rows as unknown as Record<string, unknown>[];

    const results = await withConcurrency(candidates, async (r) => {
      const ticker = String(r.ticker);
      let price = 0;
      try { const q = await stockQuoteService.getQuote(ticker); price = q.price; } catch { return null; }

      const indicators = calcAllIndicators(r, price);

      // Tenta buscar DY real
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos && price > 0) {
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
          const sum12m = sumIncomeDistributions(
            incomeDistributionsSince(
              proventos,
              cutoff.toISOString().slice(0, 10),
            ),
          );
          if (sum12m > 0) indicators.dividendYield = +(sum12m / price * 100).toFixed(2);
        }
      } catch { /* sem proventos */ }

      const scoreResult = StockScoreCalculator.calculate(
        indicators,
        (r.sector as string) || null,
        String(r.name),
      );

      return {
        ticker, name: String(r.name), score: scoreResult.score, price,
        reasons: scoreResult.reasons, alerts: scoreResult.alerts,
        sector: (r.sector as string) || null,
        dividendYield: indicators.dividendYield,
        dataCoverage: scoreResult.dataCoverage,
      } satisfies AnalyzedAsset;
    }, 5);

    const filtered = results.filter((a): a is NonNullable<typeof a> => a !== null);
    return { assets: filtered, expected: candidates.length };
  }

  async analyzeAllFiis(): Promise<AnalyzedUniverse> {
    // ENG-3r: removido LIMIT 100 para analisar universo completo de FIIs.
    const rows = await db.execute(sql`
      SELECT ticker, name, sector FROM companies
      WHERE ticker LIKE '%11' AND LENGTH(ticker) = 6 AND ticker NOT IN ('KLBN11','SANB11','TAEE11','ENGI11','ALUP11','BPAC11')
      ORDER BY ticker
    `);

    const { cvmFiiService } = await import('../../infra/services/cvm-fii-service.ts');
    const navByTicker = await cvmFiiService.getLatestNavByTickerMap().catch(
      () => new Map<string, { navPerShare: number; referenceDate: string }>(),
    );

    const candidates = rows as unknown as Record<string, unknown>[];
    const expectedGroups = candidates.reduce<{ papel: number; fisico: number }>(
      (counts, row) => {
        const classification = getFIIClassification(String(row.ticker));
        if (classification?.type === 'papel') counts.papel++;
        else counts.fisico++;
        return counts;
      },
      { papel: 0, fisico: 0 },
    );

    // REL-2: execução concorrente (5 simultâneos) para reduzir latência.
    const results = await withConcurrency(candidates, async (r) => {
      const ticker = String(r.ticker);
      let price = 0;
      let liquidity: number | null = null;
      try {
        const q = await stockQuoteService.getQuote(ticker);
        price = q.price;
        liquidity = q.volume > 0 && q.price > 0 ? q.volume * q.price : null;
        if (price <= 0) return null;
      } catch { return null; }

      // Proventos + DY
      let dy = 0;
      let dividendEvents: Array<{ date: string; value: number; type: string }> = [];
      try {
        const proventos = await dividendsProvider.fetchDividends(ticker);
        if (proventos) {
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
          dividendEvents = incomeDistributionsSince(
            proventos,
            cutoff.toISOString().slice(0, 10),
          );
          const sum12m = sumIncomeDistributions(dividendEvents);
          if (sum12m > 0) dy = +(sum12m / price * 100).toFixed(2);
        }
      } catch { /* ok */ }

      const nav = navByTicker.get(ticker)?.navPerShare;
      const pvp = nav && nav > 0 ? +(price / nav).toFixed(3) : null;
      let vacancy: number | undefined;
      let delinquency: number | undefined;
      try {
        const operational = await fiiOperationalService.fetchOperationalData(ticker);
        if (operational.vacancyPct !== null) vacancy = operational.vacancyPct;
        if (operational.delinquencyPct !== null) {
          delinquency = operational.delinquencyPct;
        }
      } catch { /* cobertura fica explicitamente incompleta */ }

      const input: FIIScoreInput = {
        ticker,
        price,
        dy,
        pvp,
        liquidity,
        dividendsHistory: dividendEvents,
        vacancy,
        delinquency,
      };
      const scoreResult = FIIScoreCalculatorV4.calculate(input);

      return {
        ticker, name: String(r.name), score: scoreResult.overall_score, price,
        reasons: [scoreResult.explanation_short],
        alerts: scoreResult.risk.primary_risk ? [scoreResult.risk.primary_risk] : [],
        sector: scoreResult.subclasse_tijolo || scoreResult.subclasse_papel || null,
        fiiType: scoreResult.type,
        dividendYield: dy > 0 ? dy : null,
        dataCoverage: {
          percent: scoreResult.metadata.data_coverage.percent,
          criticalComplete: scoreResult.metadata.data_coverage.critical_complete,
          missingFields: scoreResult.metadata.data_coverage.missing_fields,
        },
      } satisfies AnalyzedAsset;
    }, 5);

    const filtered = results.filter((a): a is NonNullable<typeof a> => a !== null);
    return {
      assets: filtered,
      expected: candidates.length,
      expectedGroups,
    };
  }

  // ─── Seleção e alocação ───────────────────────────────────────────────

  /**
   * Seleciona ativos com diversificação setorial.
   * Prioriza setores diferentes nos primeiros slots; se o setor for
   * desconhecido/null (ex.: cache warmup), preenche por score sem travar.
   */
  private selectDiversified<T extends { ticker: string; sector: string | null; score: number }>(
    assets: T[],
    maxAssets: number,
  ): T[] {
    if (maxAssets <= 0 || assets.length === 0) return [];

    const selected: T[] = [];
    const usedSectors = new Set<string>();
    const diversifySlots = Math.ceil(maxAssets * 0.6);

    // 1ª passagem: preferir setores novos
    for (const a of assets) {
      if (selected.length >= maxAssets) break;
      const sector = a.sector?.trim() || null;
      if (selected.length < diversifySlots && sector && usedSectors.has(sector)) {
        continue;
      }
      selected.push(a);
      if (sector) usedSectors.add(sector);
    }

    // 2ª passagem: completar vagas só por score (evita carteira com 1 ativo quando sector=null)
    if (selected.length < maxAssets) {
      const taken = new Set(selected.map((s) => s.ticker));
      for (const a of assets) {
        if (selected.length >= maxAssets) break;
        if (taken.has(a.ticker)) continue;
        selected.push(a);
      }
    }

    return selected;
  }

}
