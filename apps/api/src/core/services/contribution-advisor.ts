/**
 * ContributionAdvisor — dado o universo analisado (score+preço), as posições
 * atuais e um valor de aporte, sugere o que comprar, com justificativa por
 * ativo e explicação do que foi deixado de fora.
 *
 * Função pura: sem banco, sem rede. Quem preenche o universo é a infra.
 */

import { RISK_CONFIGS, type RiskProfile } from '../data/risk-profiles.ts';

export interface AdvisorAsset {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  score: number;
  price: number;
  sector: string | null;
  reasons: string[];
  alerts: string[];
}

export interface CurrentPosition { ticker: string; quantity: number; }

export interface AdvisorConfig {
  amount: number;
  profile: RiskProfile;
  onlyTypes?: Array<'stock' | 'fii'>;
  excludeSectors?: string[];
  /** Teto de % do patrimônio final (posições + aporte) por ativo. Default 25. */
  maxAssetPercent?: number;
}

export interface ContributionPurchase {
  ticker: string;
  name: string;
  assetType: 'stock' | 'fii';
  quantity: number;
  unitPrice: number;
  cost: number;
  score: number;
  why: string[];
}

export interface ContributionSuggestion {
  purchases: ContributionPurchase[];
  skipped: Array<{ ticker: string; reason: string }>;
  warnings: string[];
  totals: { invested: number; remaining: number; portfolioValueBefore: number };
}

const DIVERSIFY_SLOT_RATIO = 0.6;
const MAX_SKIPPED_ENTRIES = 15;
/** Hard safety boundary for HTTP/MCP callers and arithmetic. */
export const MAX_CONTRIBUTION_AMOUNT = 100_000_000;

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function suggestContribution(
  universe: AdvisorAsset[],
  positions: CurrentPosition[],
  config: AdvisorConfig,
  warnings: string[] = [],
): ContributionSuggestion {
  if (
    !Number.isFinite(config.amount)
    || config.amount <= 0
    || config.amount > MAX_CONTRIBUTION_AMOUNT
  ) {
    throw new RangeError(
      `amount deve estar entre 0 e ${MAX_CONTRIBUTION_AMOUNT}`,
    );
  }
  if (
    config.maxAssetPercent !== undefined
    && (!Number.isFinite(config.maxAssetPercent)
      || config.maxAssetPercent <= 0
      || config.maxAssetPercent > 100)
  ) {
    throw new RangeError('maxAssetPercent deve estar entre 0 e 100');
  }

  const profileCfg = RISK_CONFIGS[config.profile];
  const maxAssetPct = config.maxAssetPercent ?? 25;
  const outWarnings = [...warnings];
  const skipped: Array<{ ticker: string; reason: string }> = [];

  // ── Valor atual das posições (preço vem do universo) ──
  const priceOf = new Map(universe.map((a) => [a.ticker, a.price]));
  const heldValue = new Map<string, number>();
  for (const p of positions) {
    const ticker = p.ticker.toUpperCase();
    const price = priceOf.get(ticker);
    if (price === undefined || price <= 0) {
      outWarnings.push(
        `Posição em ${ticker} ignorada no cálculo de concentração: ativo fora do universo analisado`,
      );
      continue;
    }
    heldValue.set(ticker, (heldValue.get(ticker) ?? 0) + p.quantity * price);
  }
  const portfolioValue = [...heldValue.values()].reduce((s, v) => s + v, 0);
  const finalValue = portfolioValue + config.amount;
  const capPerAsset = (maxAssetPct / 100) * finalValue;

  // ── Filtro de elegibilidade (ordenado por score p/ skipped relevante) ──
  const allowedTypes = config.onlyTypes ?? ['stock', 'fii'];
  const excludedSectors = (config.excludeSectors ?? []).map((s) => s.toLowerCase());
  const eligible: AdvisorAsset[] = [];

  for (const a of [...universe].sort((x, y) => y.score - x.score)) {
    if (!allowedTypes.includes(a.assetType)) continue; // excluído por config, não vale skipped
    if (a.price <= 0) continue;
    const sector = a.sector?.toLowerCase() ?? '';
    if (excludedSectors.some((s) => sector.includes(s))) {
      if (skipped.length < MAX_SKIPPED_ENTRIES) {
        skipped.push({ ticker: a.ticker, reason: `Setor "${a.sector}" excluído por preferência` });
      }
      continue;
    }
    if (a.score < profileCfg.minScore) {
      if (skipped.length < MAX_SKIPPED_ENTRIES) {
        skipped.push({
          ticker: a.ticker,
          reason: `Score ${a.score} abaixo do mínimo ${profileCfg.minScore} do perfil ${config.profile}`,
        });
      }
      continue;
    }
    eligible.push(a);
  }

  // ── Orçamento por classe ──
  const bothAllowed = allowedTypes.includes('stock') && allowedTypes.includes('fii');
  const budgetFor = (type: 'stock' | 'fii'): number => {
    if (!allowedTypes.includes(type)) return 0;
    if (!bothAllowed) return config.amount;
    const pct = type === 'stock' ? profileCfg.stockPercent : profileCfg.fiiPercent;
    return (config.amount * pct) / 100;
  };

  const purchases: ContributionPurchase[] = [];
  const plannedCost = new Map<string, number>();

  const addPurchase = (a: AdvisorAsset, quantity: number): void => {
    const cost = quantity * a.price;
    const existing = purchases.find((p) => p.ticker === a.ticker);
    if (existing) {
      existing.quantity += quantity;
      existing.cost = round2(existing.cost + cost);
    } else {
      purchases.push({
        ticker: a.ticker,
        name: a.name,
        assetType: a.assetType,
        quantity,
        unitPrice: a.price,
        cost: round2(cost),
        score: a.score,
        why: [`Score ${a.score}/100`, ...a.reasons.slice(0, 2)],
      });
    }
    plannedCost.set(a.ticker, (plannedCost.get(a.ticker) ?? 0) + cost);
  };

  /** Quanto ainda cabe neste ativo sem estourar o teto de concentração. */
  const roomFor = (a: AdvisorAsset): number =>
    capPerAsset - (heldValue.get(a.ticker) ?? 0) - (plannedCost.get(a.ticker) ?? 0);

  for (const type of ['stock', 'fii'] as const) {
    let budget = budgetFor(type);
    if (budget <= 0) continue;
    const pool = eligible.filter((a) => a.assetType === type);
    if (pool.length === 0) continue;

    const typeShare = bothAllowed
      ? (type === 'stock' ? profileCfg.stockPercent : profileCfg.fiiPercent) / 100
      : 1;
    const maxAssets = Math.max(1, Math.round(profileCfg.maxAssets * typeShare));

    // Seleção com diversificação setorial (primeiros 60% das vagas em setores únicos)
    const selected: AdvisorAsset[] = [];
    const usedSectors = new Set<string>();
    const diversifySlots = Math.ceil(maxAssets * DIVERSIFY_SLOT_RATIO);
    for (const a of pool) {
      if (selected.length >= maxAssets) break;
      const sector = a.sector ?? 'outros';
      if (selected.length < diversifySlots && usedSectors.has(sector)) continue;
      selected.push(a);
      usedSectors.add(sector);
    }

    // 1ª passada: peso igual entre os selecionados (score já filtrou elegibilidade —
    // backtest mostrou que score não ordena retorno, só filtra fracos), respeitando teto por ativo
    const zeroQtyTargets = new Map<string, number>();
    for (const a of selected) {
      const room = roomFor(a);
      if (room < a.price) {
        const held = heldValue.get(a.ticker) ?? 0;
        if (held > 0) {
          skipped.push({
            ticker: a.ticker,
            reason: `Já representa ${((held / finalValue) * 100).toFixed(0)}% da carteira — teto de ${maxAssetPct}% por ativo`,
          });
        } else {
          skipped.push({
            ticker: a.ticker,
            reason: `Preço R$ ${a.price.toFixed(2)} não cabe no teto de ${maxAssetPct}% do aporte para este ativo`,
          });
        }
        continue;
      }
      const equalShare = budgetFor(type) / selected.length;
      const target = Math.min(equalShare, room, budget);
      const quantity = Math.floor(target / a.price);
      if (quantity === 0) {
        zeroQtyTargets.set(a.ticker, target);
        continue;
      }
      addPurchase(a, quantity);
      budget -= quantity * a.price;
    }

    // 2ª passada: sobra do orçamento vai para os melhores que ainda têm espaço.
    // A quantidade é calculada em O(1); o antigo loop unitário crescia com
    // amount/preço e permitia bloquear a CPU com valores extremos.
    for (const a of selected) {
      if (budget < a.price) continue;
      const maxByBudget = Math.floor(budget / a.price);
      const maxByConcentration = Math.floor(Math.max(0, roomFor(a)) / a.price);
      const quantity = Math.min(maxByBudget, maxByConcentration);
      if (quantity <= 0) continue;
      addPurchase(a, quantity);
      budget -= quantity * a.price;
    }

    // Ativos selecionados que nunca receberam quantidade em nenhuma das passadas
    // (fatia igual arredondou para 0 e a 2ª passada não teve sobra suficiente)
    for (const [ticker, target] of zeroQtyTargets) {
      if (purchases.some((p) => p.ticker === ticker)) continue;
      const a = selected.find((s) => s.ticker === ticker);
      if (!a) continue;
      skipped.push({
        ticker,
        reason: `Orçamento disponível (R$ ${target.toFixed(2)}) insuficiente para 1 unidade a R$ ${a.price.toFixed(2)}`,
      });
    }
  }

  const invested = purchases.reduce((s, p) => s + p.cost, 0);

  if (purchases.length === 0) {
    const cheapest = eligible.length > 0 ? Math.min(...eligible.map((a) => a.price)) : null;
    if (cheapest !== null && config.amount < cheapest) {
      outWarnings.push(
        `Valor de R$ ${config.amount.toFixed(2)} insuficiente para 1 unidade de qualquer ativo elegível (mais barato: R$ ${cheapest.toFixed(2)}) — acumule para o próximo aporte`,
      );
    } else if (eligible.length === 0) {
      outWarnings.push('Nenhum ativo elegível com os filtros e perfil informados');
    }
  }

  return {
    purchases: purchases.sort((a, b) => b.cost - a.cost),
    skipped,
    warnings: outWarnings,
    totals: {
      invested: round2(invested),
      remaining: round2(config.amount - invested),
      portfolioValueBefore: round2(portfolioValue),
    },
  };
}
