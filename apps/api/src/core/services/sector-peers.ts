/**
 * Sector peers — mediana setorial e posição relativa do ativo.
 *
 * Pure helpers: quem busca peers no DB/cotação é a infra.
 * Usado na research para responder "como este papel se compara ao setor?".
 */

export interface PeerMetricRow {
  ticker: string;
  name?: string | null;
  peRatio?: number | null;
  pbRatio?: number | null;
  roe?: number | null;
  dividendYield?: number | null;
  netMargin?: number | null;
  debtToEquity?: number | null;
  score?: number | null;
}

export type RelativeStanding = 'better' | 'similar' | 'worse' | 'unknown';

export interface MetricVsPeer {
  field: string;
  label: string;
  self: number | null;
  sectorMedian: number | null;
  /** lower_better: P/L, P/VP, dívida; higher_better: ROE, DY, margem, score */
  direction: 'higher_better' | 'lower_better';
  standing: RelativeStanding;
  note: string;
}

export interface SectorPeerSummary {
  sector: string | null;
  peerCount: number;
  /** Até 8 peers ordenados por score desc (exclui o próprio ticker). */
  peers: Array<{
    ticker: string;
    name: string | null;
    score: number | null;
    peRatio: number | null;
    pbRatio: number | null;
    roe: number | null;
    dividendYield: number | null;
  }>;
  medians: {
    peRatio: number | null;
    pbRatio: number | null;
    roe: number | null;
    dividendYield: number | null;
    netMargin: number | null;
    debtToEquity: number | null;
    score: number | null;
  };
  vsSector: MetricVsPeer[];
  /** Uma frase para o investidor mediano. */
  summary: string;
}

const METRICS: Array<{
  field: keyof PeerMetricRow;
  label: string;
  direction: 'higher_better' | 'lower_better';
}> = [
  { field: 'score', label: 'Score', direction: 'higher_better' },
  { field: 'peRatio', label: 'P/L', direction: 'lower_better' },
  { field: 'pbRatio', label: 'P/VP', direction: 'lower_better' },
  { field: 'roe', label: 'ROE', direction: 'higher_better' },
  { field: 'dividendYield', label: 'DY', direction: 'higher_better' },
  { field: 'netMargin', label: 'Margem líquida', direction: 'higher_better' },
  { field: 'debtToEquity', label: 'Dív/PL', direction: 'lower_better' },
];

/**
 * Monta resumo setorial. `peers` pode incluir o próprio ticker (será filtrado nas listas).
 */
export function buildSectorPeerSummary(
  self: PeerMetricRow,
  sector: string | null,
  peers: PeerMetricRow[],
): SectorPeerSummary {
  const ticker = self.ticker.toUpperCase();
  const others = peers
    .filter((p) => p.ticker.toUpperCase() !== ticker)
    .map(normalizeRow);

  const poolForMedian = [...others];
  // Inclui o próprio na mediana se houver amostra pequena
  if (poolForMedian.length < 3) {
    poolForMedian.push(normalizeRow(self));
  }

  const medians = {
    peRatio: median(poolForMedian.map((p) => p.peRatio)),
    pbRatio: median(poolForMedian.map((p) => p.pbRatio)),
    roe: median(poolForMedian.map((p) => p.roe)),
    dividendYield: median(poolForMedian.map((p) => p.dividendYield)),
    netMargin: median(poolForMedian.map((p) => p.netMargin)),
    debtToEquity: median(poolForMedian.map((p) => p.debtToEquity)),
    score: median(poolForMedian.map((p) => p.score)),
  };

  const selfN = normalizeRow(self);
  const vsSector: MetricVsPeer[] = METRICS.map((m) => {
    const sv = (selfN[m.field] as number | null) ?? null;
    const med = medians[m.field as keyof typeof medians] ?? null;
    const standing = compareStanding(sv, med, m.direction);
    return {
      field: String(m.field),
      label: m.label,
      self: sv,
      sectorMedian: med,
      direction: m.direction,
      standing,
      note: standingNote(m.label, standing, sv, med, m.direction),
    };
  });

  const sortedPeers = [...others]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 8)
    .map((p) => ({
      ticker: p.ticker,
      name: p.name ?? null,
      score: p.score,
      peRatio: p.peRatio,
      pbRatio: p.pbRatio,
      roe: p.roe,
      dividendYield: p.dividendYield,
    }));

  const better = vsSector.filter((v) => v.standing === 'better').length;
  const worse = vsSector.filter((v) => v.standing === 'worse').length;
  const sectorLabel = sector?.trim() || 'setor desconhecido';
  let summary: string;
  if (others.length === 0) {
    summary = `Sem peers suficientes em ${sectorLabel} para comparar — use o Comparador com tickers manuais.`;
  } else if (better >= worse + 2) {
    summary = `${ticker} está, no conjunto, melhor que a mediana de ${sectorLabel} (${others.length} peers).`;
  } else if (worse >= better + 2) {
    summary = `${ticker} está, no conjunto, pior que a mediana de ${sectorLabel} — exija desconto ou prefira peers com score maior.`;
  } else {
    summary = `${ticker} está próximo da mediana de ${sectorLabel} (${others.length} peers). Diferencie por tese e diversificação.`;
  }

  return {
    sector: sector,
    peerCount: others.length,
    peers: sortedPeers,
    medians,
    vsSector,
    summary,
  };
}

function normalizeRow(r: PeerMetricRow): Required<Pick<PeerMetricRow, 'ticker'>> & {
  name: string | null;
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  dividendYield: number | null;
  netMargin: number | null;
  debtToEquity: number | null;
  score: number | null;
} {
  return {
    ticker: r.ticker.toUpperCase(),
    name: r.name ?? null,
    peRatio: finiteOrNull(r.peRatio),
    pbRatio: finiteOrNull(r.pbRatio),
    roe: finiteOrNull(r.roe),
    dividendYield: finiteOrNull(r.dividendYield),
    netMargin: finiteOrNull(r.netMargin),
    debtToEquity: finiteOrNull(r.debtToEquity),
    score: finiteOrNull(r.score),
  };
}

function finiteOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

function median(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return +nums[mid]!.toFixed(2);
  return +((nums[mid - 1]! + nums[mid]!) / 2).toFixed(2);
}

function compareStanding(
  self: number | null,
  median: number | null,
  direction: 'higher_better' | 'lower_better',
): RelativeStanding {
  if (self == null || median == null) return 'unknown';
  const band = Math.max(Math.abs(median) * 0.1, direction === 'lower_better' ? 0.15 : 1);
  const diff = self - median;
  if (Math.abs(diff) <= band) return 'similar';
  if (direction === 'higher_better') return diff > 0 ? 'better' : 'worse';
  return diff < 0 ? 'better' : 'worse';
}

function standingNote(
  label: string,
  standing: RelativeStanding,
  self: number | null,
  median: number | null,
  _direction: 'higher_better' | 'lower_better',
): string {
  if (standing === 'unknown' || self == null || median == null) {
    return `${label}: sem base para comparar.`;
  }
  const s = fmt(self);
  const m = fmt(median);
  if (standing === 'better') return `${label} ${s} melhor que mediana ${m}.`;
  if (standing === 'worse') return `${label} ${s} pior que mediana ${m}.`;
  return `${label} ${s} ≈ mediana ${m}.`;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
