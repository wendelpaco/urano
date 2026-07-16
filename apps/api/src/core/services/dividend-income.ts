export interface DistributionEvent {
  date: string;
  value: number;
  type: string;
}

export interface MonthlyIncomeEvent extends DistributionEvent {
  month: string;
}

function normalizedType(type: string): string {
  return type
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

/** Amortizacao devolve principal e nao compoe renda/DY. */
export function isIncomeDistribution(event: DistributionEvent): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}/.test(event.date)
    && Number.isFinite(event.value)
    && event.value > 0
    && !normalizedType(event.type).includes('AMORTIZA')
  );
}

export function incomeDistributionsSince<T extends DistributionEvent>(
  events: T[],
  cutoff: string,
): T[] {
  return events.filter(
    (event) => event.date >= cutoff && isIncomeDistribution(event),
  );
}

export function sumIncomeDistributions(events: DistributionEvent[]): number {
  return events
    .filter(isIncomeDistribution)
    .reduce((sum, event) => sum + event.value, 0);
}

/** Soma todos os rendimentos da mesma competencia e ordena do mais recente. */
export function aggregateMonthlyIncome(
  events: DistributionEvent[],
): MonthlyIncomeEvent[] {
  const byMonth = new Map<string, { value: number; latestDate: string }>();
  for (const event of events) {
    if (!isIncomeDistribution(event)) continue;
    const month = event.date.slice(0, 7);
    const current = byMonth.get(month);
    byMonth.set(month, {
      value: (current?.value ?? 0) + event.value,
      latestDate: current && current.latestDate > event.date
        ? current.latestDate
        : event.date,
    });
  }

  return [...byMonth.entries()]
    .sort(([monthA], [monthB]) => monthB.localeCompare(monthA))
    .map(([month, aggregate]) => ({
      month,
      date: aggregate.latestDate,
      value: aggregate.value,
      type: 'RENDA_MENSAL_AGREGADA',
    }));
}

/** Serie mensal com lacunas explicitas em zero, encerrada no mes mais recente. */
export function monthlyIncomeSeries(
  events: DistributionEvent[],
  months = 12,
  asOf = new Date().toISOString().slice(0, 10),
): MonthlyIncomeEvent[] {
  const aggregated = aggregateMonthlyIncome(events);
  if (months <= 0) return [];
  const values = new Map(aggregated.map((event) => [event.month, event.value]));
  const anchorMonth = /^\d{4}-\d{2}/.test(asOf)
    ? asOf.slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const [year, month] = anchorMonth.split('-').map(Number);
  const end = new Date(Date.UTC(year!, month! - 1, 1));

  return Array.from({ length: months }, (_, index) => {
    const date = new Date(end);
    date.setUTCMonth(date.getUTCMonth() - index);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return {
      month: key,
      date: `${key}-01`,
      value: values.get(key) ?? 0,
      type: 'RENDA_MENSAL_AGREGADA',
    };
  });
}
