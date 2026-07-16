/**
 * Layout do CSV da DRE (Demonstração de Resultado do Exercício) da CVM.
 */

import JSZip from 'jszip';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';
import { withRetry } from '../../shared/retry.ts';
import { cvmLimiter } from './rate-limiter.ts';
import { cvmCircuitBreaker } from './circuit-breaker.ts';

// ---- Constantes de parsing CVM ----

const CVM_CSV_DELIMITER = ';';

/** CVM publica `ÚLTIMO`/`PENÚLTIMO`; normalização evita variações Unicode. */
export function normalizeCvmExerciseOrder(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function isLatestCvmExercise(value: string): boolean {
  return normalizeCvmExerciseOrder(value) === 'ULTIMO';
}

/**
 * Os CSVs oficiais da CVM são historicamente Windows-1252/Latin-1. JSZip
 * `async('string')` assume UTF-8 e transforma `ÚLTIMO` em `�LTIMO`, o que
 * faria o filtro fail-closed eliminar 100% das linhas. Aceitamos UTF-8 quando
 * ele é realmente válido e fazemos fallback determinístico para Windows-1252.
 */
export function decodeCvmCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const SCALE_FACTORS: Record<string, number> = {
  UNIDADE: 1, UN: 1, MIL: 1_000, MILHAR: 1_000, MILHAO: 1_000_000,
};

const ACCOUNT_NET_INCOME_CONSOLIDATED = '3.11';
const ACCOUNT_NET_INCOME_PARENT = '3.11.01';
const ACCOUNT_REVENUE = '3.01';
const ACCOUNT_COGS = '3.02';
const ACCOUNT_EBIT = '3.05';
const ACCOUNT_EQUITY_CONSOLIDATED = '2.03';
const ACCOUNT_TOTAL_ASSETS = '1';
// 1.01 é Ativo Circulante; Caixa e Equivalentes é 1.01.01 no plano CVM.
const ACCOUNT_CASH = '1.01.01';
const ACCOUNT_CURRENT_LIABILITIES = '2.01';
const ACCOUNT_NON_CURRENT_LIABILITIES = '2.02';
const ACCOUNT_OPERATING_CASH_FLOW = '6.01';

const NET_INCOME_LABELS = [
  'lucro/prejuízo líquido consolidado do período',
  'lucro (prejuízo) líquido consolidado do período',
  'lucro ou prejuízo líquido consolidado do período',
  'lucro/prejuízo consolidado do período',
  'lucro (prejuízo) consolidado do período',
  'lucro ou prejuízo consolidado do período',
  'lucro líquido consolidado do período',
  'resultado líquido consolidado do período',
];

// ---- Tipos internos ----

interface CvmDreRow {
  cnpj: string;
  referenceDate: string;
  companyName: string;
  currencyScale: string;
  exerciseOrder: string;
  exerciseStartDate: string;
  exerciseEndDate: string;
  accountCode: string;
  accountDescription: string;
  statementColumn: string;
  rawValue: string;
}

/** Registro agrupado por CNPJ + período (a partir do DRE) */
interface DreGroupEntry {
  exerciseEndDate: string;
  companyName: string;
  netIncome: number;
  netIncomeParent: number;
  revenue: number;
  cogs: number;
  ebit: number;
}

// ---- Serviço ----

export class CvmStorageService {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor() {
    this.baseUrl = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC';
    this.userAgent = 'Urano-FinBot/0.1 (ETL-CVM; contato@urano.app)';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BATCH — Baixa ZIP 1×, extrai CSVs 1×, parseia 1×, filtra por CNPJ
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * ETL em batch: baixa o ZIP uma vez, extrai e parseia todos os CSVs uma vez,
   * depois filtra cada CNPJ do resultado já parseado.
   *
   * Pico de memória: ~50 MB (vs ~100 MB/ticker × 3 concorrentes do modo antigo).
   */
  async fetchAndParseCvmDataBatch(
    year: number,
    targetCnpjs: string[],
  ): Promise<Map<string, CompanyFundamentals[]>> {
    const normalize = (c: string) => c.replace(/[./-]/g, '').trim();
    const cnpjSet = new Set(targetCnpjs.map(normalize));
    const zipUrl = this.buildDfpZipUrl(year);

    // 1. Download ZIP (12 MB)
    console.log(`[CvmStorageService] Baixando ZIP ${year}...`);
    const zipBuffer = await this.downloadZip(zipUrl);

    // 2. Extrai todos os CSVs do ZIP de uma vez
    const zip = await JSZip.loadAsync(zipBuffer);
    const csvPatterns = [
      `DRE_con_${year}.csv`,
      `BPP_con_${year}.csv`,
      `BPA_con_${year}.csv`,
      `DFC_MI_con_${year}.csv`,
      `DMPL_con_${year}.csv`,
      `composicao_capital_${year}.csv`,
    ];

    console.log(`[CvmStorageService] Extraindo CSVs...`);
    const csvs: Record<string, string | null> = {};
    for (const pattern of csvPatterns) {
      try {
        const file = Object.keys(zip.files).find((n) => n.includes(pattern));
        if (file) {
          const bytes = await zip.file(file)!.async('uint8array');
          csvs[pattern] = decodeCvmCsv(bytes);
        }
        else csvs[pattern] = null;
      } catch { csvs[pattern] = null; }
    }

    // Libera o ZIP da memória
    void zip; // GC hint

    // 3. Parse DRE — uma única vez
    const dreKey = `DRE_con_${year}.csv`;
    const dreCsv = csvs[dreKey];
    if (!dreCsv) return new Map();

    console.log(`[CvmStorageService] Parseando DRE...`);
    const dreRows = this.parseCsv(dreCsv);

    // 4. Agrupa por CNPJ → períodos
    const byCnpj = new Map<string, Map<string, DreGroupEntry>>();

    let processedCount = 0;
    for (const row of dreRows) {
      const cnpj = normalize(row.cnpj);
      if (!cnpjSet.has(cnpj)) continue;

      if (!byCnpj.has(cnpj)) byCnpj.set(cnpj, new Map());
      const pmap = byCnpj.get(cnpj)!;
      const key = row.exerciseEndDate || row.referenceDate;
      const scale = SCALE_FACTORS[row.currencyScale] ?? 1;
      const val = parseFloat(row.rawValue) * scale;

      if (!pmap.has(key)) {
        pmap.set(key, {
          exerciseEndDate: key,
          companyName: row.companyName,
          netIncome: 0, netIncomeParent: 0, revenue: 0, cogs: 0, ebit: 0,
        });
      }
      const e = pmap.get(key)!;

      // Classifica a conta
      const code = row.accountCode;
      const desc = row.accountDescription.toLowerCase().trim();

      if (code === ACCOUNT_NET_INCOME_CONSOLIDATED ||
          NET_INCOME_LABELS.some((l) => desc.includes(l))) e.netIncome = val;
      else if (code === ACCOUNT_NET_INCOME_PARENT) e.netIncomeParent = val;
      else if (code === ACCOUNT_REVENUE) e.revenue = val;
      else if (code === ACCOUNT_COGS) e.cogs = val;
      else if (code === ACCOUNT_EBIT) e.ebit = val;

      processedCount++;
    }

    console.log(`[CvmStorageService] ${processedCount} linhas processadas, ${byCnpj.size} CNPJs encontrados.`);

    // 5. Enriquece com BPP, BPA, DFC, DMPL, Capital
    // CRÍTICO: parseia cada CSV UMA vez, depois filtra por CNPJ.
    // Antes parseava N vezes (N=CNPJs), gerando milhões de objetos e estourando memória.
    const bppRows = csvs[`BPP_con_${year}.csv`] ? this.parseCsv(csvs[`BPP_con_${year}.csv`]!) : [];
    const bpaRows = csvs[`BPA_con_${year}.csv`] ? this.parseCsv(csvs[`BPA_con_${year}.csv`]!) : [];
    const dfcRows = csvs[`DFC_MI_con_${year}.csv`] ? this.parseCsv(csvs[`DFC_MI_con_${year}.csv`]!) : [];
    const dmplRows = csvs[`DMPL_con_${year}.csv`] ? this.parseCsv(csvs[`DMPL_con_${year}.csv`]!) : [];
    const capitalCsv = csvs[`composicao_capital_${year}.csv`];

    // Libera strings CSV (já parseadas, ~30 MB)
    for (const k of Object.keys(csvs)) csvs[k] = null;

    const result = new Map<string, CompanyFundamentals[]>();

    for (const [cnpj, pmap] of byCnpj) {
      const fundamentals: CompanyFundamentals[] = [];
      for (const [, entry] of pmap) {
        const fiscalYear = Number(entry.exerciseEndDate.slice(0, 4));
        // O ZIP é indexado pelo ano de referência solicitado. Uma data de
        // outro exercício não pode ser gravada sob esse fiscalYear.
        if (!Number.isInteger(fiscalYear) || fiscalYear !== year) continue;
        fundamentals.push({
          cnpj, ticker: '', companyName: entry.companyName,
          referenceDate: entry.exerciseEndDate,
          netIncome: entry.netIncome,
          netIncomeAttributableToParent: entry.netIncomeParent || entry.netIncome,
          revenue: entry.revenue || undefined,
          cogs: entry.cogs || undefined,
          ebit: entry.ebit || undefined,
          fiscalYear, source: 'DFP', extractedAt: new Date(),
        });
      }

      // Filtra dos arrays já parseados (zero alocações grandes)
      if (bppRows.length > 0) this.enrichBpp(bppRows, cnpj, fundamentals);
      if (bpaRows.length > 0) this.enrichBpa(bpaRows, cnpj, fundamentals);
      if (dfcRows.length > 0) this.enrichDfc(dfcRows, cnpj, fundamentals);
      if (dmplRows.length > 0) this.enrichDmpl(dmplRows, cnpj, fundamentals);
      if (capitalCsv) this.enrichCapital(capitalCsv, cnpj, fundamentals);

      result.set(cnpj, fundamentals);
    }

    console.log(`[CvmStorageService] ${result.size} CNPJs enriquecidos.`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SINGLE (legado — backward compat)
  // ═══════════════════════════════════════════════════════════════════════

  async fetchAndParseCvmData(year: number, cnpj: string): Promise<{ fundamentals: CompanyFundamentals[] }> {
    const batch = await this.fetchAndParseCvmDataBatch(year, [cnpj]);
    return { fundamentals: batch.get(cnpj.replace(/[./-]/g, '').trim()) ?? [] };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENRICHMENT — parse do CSV filtrado por CNPJ (métodos reutilizáveis)
  // ═══════════════════════════════════════════════════════════════════════

  private enrichBpp(rows: CvmDreRow[], cnpj: string, fundamentals: CompanyFundamentals[]): void {
    const eq = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_EQUITY_CONSOLIDATED);
    const cl = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_CURRENT_LIABILITIES);
    const nc = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_NON_CURRENT_LIABILITIES);
    for (const f of fundamentals) {
      const e = eq.get(f.referenceDate);
      if (e !== undefined) f.equity = e;
      const a = cl.get(f.referenceDate);
      const b = nc.get(f.referenceDate);
      if (a !== undefined || b !== undefined) f.totalLiabilities = (a ?? 0) + (b ?? 0);
    }
  }

  private enrichBpa(rows: CvmDreRow[], cnpj: string, fundamentals: CompanyFundamentals[]): void {
    const ta = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_TOTAL_ASSETS);
    const ca = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_CASH);
    for (const f of fundamentals) {
      const a = ta.get(f.referenceDate);
      if (a !== undefined) f.totalAssets = a;
      const c = ca.get(f.referenceDate);
      if (c !== undefined) f.cash = c;
    }
  }

  private enrichDfc(rows: CvmDreRow[], cnpj: string, fundamentals: CompanyFundamentals[]): void {
    const ocf = this.extractAccountFromCsv(rows, cnpj, ACCOUNT_OPERATING_CASH_FLOW);
    for (const f of fundamentals) {
      const v = ocf.get(f.referenceDate);
      if (v !== undefined) f.operatingCashFlow = v;
    }
  }

  private enrichDmpl(rows: CvmDreRow[], cnpj: string, fundamentals: CompanyFundamentals[]): void {
    const normalize = (c: string) => c.replace(/[./-]/g, '').trim();
    const target = normalize(cnpj);
    const divMap = new Map<string, { dividends: number; jcp: number }>();

    for (const row of rows) {
      if (normalize(row.cnpj) !== target) continue;
      const col = (row.statementColumn || '').toLowerCase();
      if (!col.includes('consolidado')) continue;

      const raw = parseFloat((row.rawValue || '0').replace(',', '.'));
      if (raw === 0) continue;

      const key = row.exerciseEndDate || row.referenceDate;
      const scale = SCALE_FACTORS[row.currencyScale] ?? 1;
      const val = Math.abs(raw) * scale;

      if (!divMap.has(key)) divMap.set(key, { dividends: 0, jcp: 0 });
      const e = divMap.get(key)!;
      if (row.accountCode === '5.04.06') e.dividends += val;
      else if (row.accountCode === '5.04.07') e.jcp += val;
    }

    for (const f of fundamentals) {
      const d = divMap.get(f.referenceDate);
      if (d) {
        if (d.dividends > 0) f.dividendsPaid = d.dividends;
        if (d.jcp > 0) f.jcpPaid = d.jcp;
      }
    }
  }

  private enrichCapital(
    csv: string | null | undefined,
    cnpj: string,
    fundamentals: CompanyFundamentals[],
  ): void {
    if (!csv || fundamentals.length === 0) return;
    const lines = this.splitCsvLines(csv);
    if (lines.length < 2) return;
    const header = this.parseCsvLine(lines[0]!);
    const iCnpj = header.indexOf('CNPJ_CIA');
    const iShares = header.indexOf('QT_ACAO_TOTAL_CAP_INTEGR');
    if (iCnpj < 0 || iShares < 0) return;

    const normalize = (c: string) => c.replace(/[./-]/g, '').trim();
    const target = normalize(cnpj);

    for (let i = 1; i < lines.length; i++) {
      const fld = this.parseCsvLine(lines[i]!);
      if (normalize(fld[iCnpj] ?? '') === target) {
        const shares = parseFloat((fld[iShares] ?? '0').replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(shares) && shares > 0) {
          // QT_ACAO_TOTAL_CAP_INTEGR já representa quantidade de ações. O
          // antigo limiar de 100 milhões multiplicava small caps por 1.000.
          for (const f of fundamentals) f.sharesOutstanding = shares;
        }
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  private buildDfpZipUrl(year: number): string {
    return `${this.baseUrl}/DFP/DADOS/dfp_cia_aberta_${year}.zip`;
  }

  protected async downloadZip(url: string): Promise<ArrayBuffer> {
    // Circuit breaker: verifica se a CVM está acessível
    await cvmCircuitBreaker.beforeRequest();

    // Rate limit centralizado da CVM
    await cvmLimiter.acquire();

    try {
      const result = await withRetry(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': this.userAgent },
            signal: controller.signal,
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
          return await r.arrayBuffer();
        } finally { clearTimeout(timeout); }
      }, {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 30_000,
      });

      await cvmCircuitBreaker.onSuccess();
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('HTTP 5')) {
        await cvmCircuitBreaker.onFailure('server-error', msg);
      } else {
        await cvmCircuitBreaker.onFailure('network-error', msg);
      }
      throw error;
    }
  }

  private extractAccountFromCsv(
    rows: CvmDreRow[], targetCnpj: string, accountCode: string,
  ): Map<string, number> {
    const normalize = (c: string) => c.replace(/[./-]/g, '').trim();
    const target = normalize(targetCnpj);
    const result = new Map<string, number>();
    for (const row of rows) {
      if (normalize(row.cnpj) !== target) continue;
      if (!isLatestCvmExercise(row.exerciseOrder)) continue;
      if (row.accountCode !== accountCode) continue;
      const key = row.exerciseEndDate || row.referenceDate;
      const scale = SCALE_FACTORS[row.currencyScale] ?? 1;
      result.set(key, parseFloat(row.rawValue) * scale);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CSV PARSING (inalterado)
  // ═══════════════════════════════════════════════════════════════════════

  private parseCsv(csvContent: string): CvmDreRow[] {
    const rows: CvmDreRow[] = [];
    const lines = this.splitCsvLines(csvContent);
    if (lines.length < 2) return rows;

    const header = this.parseCsvLine(lines[0]!);
    const colIndex = this.buildColumnIndex(header);

    const idxCnpj = this.getColumnIndex(colIndex, 'CNPJ_CIA');
    const idxDtRefer = this.getColumnIndex(colIndex, 'DT_REFER');
    const idxDenomCia = this.getColumnIndex(colIndex, 'DENOM_CIA');
    const idxEscalaMoeda = this.getOptionalColumnIndex(colIndex, 'ESCALA_MOEDA');
    const idxOrdemExerc = this.getColumnIndex(colIndex, 'ORDEM_EXERC');
    const idxDtIniExerc = this.getOptionalColumnIndex(colIndex, 'DT_INI_EXERC');
    const idxDtFimExerc = this.getColumnIndex(colIndex, 'DT_FIM_EXERC');
    const idxCdConta = this.getColumnIndex(colIndex, 'CD_CONTA');
    const idxDsConta = this.getColumnIndex(colIndex, 'DS_CONTA');
    const idxColunaDf = this.getOptionalColumnIndex(colIndex, 'COLUNA_DF');
    const idxVlConta = this.getColumnIndex(colIndex, 'VL_CONTA');

    for (let i = 1; i < lines.length; i++) {
      const fields = this.parseCsvLine(lines[i]!);
      if (fields.length < header.length) continue;
      const exerciseOrder = fields[idxOrdemExerc] ?? '';
      // Fail-closed: comparativos (`PENÚLTIMO`) nunca alimentam o mesmo ano
      // fiscal do exercício corrente. Valor ausente/desconhecido também sai.
      if (!isLatestCvmExercise(exerciseOrder)) continue;
      rows.push({
        cnpj: fields[idxCnpj] ?? '',
        referenceDate: fields[idxDtRefer] ?? '',
        companyName: fields[idxDenomCia] ?? '',
        currencyScale: idxEscalaMoeda >= 0 ? (fields[idxEscalaMoeda] ?? 'UNIDADE') : 'UNIDADE',
        exerciseOrder,
        exerciseStartDate: idxDtIniExerc >= 0 ? (fields[idxDtIniExerc] ?? '') : '',
        exerciseEndDate: fields[idxDtFimExerc] ?? '',
        accountCode: fields[idxCdConta] ?? '',
        accountDescription: fields[idxDsConta] ?? '',
        statementColumn: idxColunaDf >= 0 ? (fields[idxColunaDf] ?? '') : '',
        rawValue: fields[idxVlConta] ?? '0',
      });
    }
    return rows;
  }

  private splitCsvLines(content: string): string[] {
    const lines: string[] = [];
    let current = '';
    let insideQuotes = false;
    for (let i = 0; i < content.length; i++) {
      const char = content[i]!;
      if (char === '"') insideQuotes = !insideQuotes;
      if (char === '\n' && !insideQuotes) { lines.push(current); current = ''; }
      else current += char;
    }
    if (current.length > 0) lines.push(current);
    return lines;
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let insideQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else insideQuotes = !insideQuotes;
      } else if (char === CVM_CSV_DELIMITER && !insideQuotes) {
        fields.push(current.trim()); current = '';
      } else current += char;
    }
    fields.push(current.trim());
    return fields;
  }

  private buildColumnIndex(header: string[]): Map<string, number> {
    const index = new Map<string, number>();
    for (let i = 0; i < header.length; i++) index.set(header[i]!, i);
    return index;
  }

  private getColumnIndex(colIndex: Map<string, number>, name: string): number {
    const idx = colIndex.get(name);
    if (idx === undefined) throw new Error(`Coluna "${name}" não encontrada. Disponíveis: ${[...colIndex.keys()].join(', ')}`);
    return idx;
  }

  private getOptionalColumnIndex(colIndex: Map<string, number>, name: string): number {
    return colIndex.get(name) ?? -1;
  }
}
