import JSZip from 'jszip';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';
import { withRetry } from '../../shared/retry.ts';

/**
 * Layout do CSV da DRE (Demonstração de Resultado do Exercício) da CVM.
 *
 * Colunas esperadas no arquivo `dfp_cia_aberta_DRE_con_[ANO].csv`:
 *   CNPJ_CIA       - CNPJ da companhia (formato: 00000000000000)
 *   DT_REFER       - Data de referência do demonstrativo (YYYY-MM-DD)
 *   VERSAO         - Versão do documento
 *   DENOM_CIA      - Nome da companhia
 *   CD_CVM         - Código CVM da empresa
 *   GRUPO_DFP      - Grupo do demonstrativo
 *   MOEDA          - Moeda (ex: "REAL")
 *   ESCALA_MOEDA   - Unidade de escala (UNIDADE, MILHAR ou MILHAO)
 *   ORDEM_EXERC    - Ordem do exercício (ÚLTIMO, PENÚLTIMO, etc.)
 *   DT_INI_EXERC   - Data de início do exercício social
 *   DT_FIM_EXERC   - Data de fim do exercício social
 *   CD_CONTA       - Código hierárquico da conta contábil (ex: "3.99")
 *   DS_CONTA       - Descrição da conta contábil
 *   VL_CONTA       - Valor da conta (na escala definida por ESCALA_MOEDA)
 */

// ---- Constantes de parsing CVM ----

/** Separador oficial dos CSVs de dados abertos da CVM */
const CVM_CSV_DELIMITER = ';';

/**
 * Mapeamento da escala monetária para fator de multiplicação (converte para Reais).
 * A CVM utiliza abreviações no CSV (MIL, MILHAO), não as formas por extenso.
 */
const SCALE_FACTORS: Record<string, number> = {
  UNIDADE: 1,
  UN: 1,
  MIL: 1_000,
  MILHAR: 1_000,
  MILHAO: 1_000_000,
};

/**
 * Códigos de conta contábil na taxonomia CVM para o Lucro Líquido Consolidado.
 *
 * Estrutura hierárquica real observada nos CSVs da CVM (2024):
 *   3.11          -> Lucro (Prejuízo) Líquido Consolidado do Período
 *   3.11.01       -> Atribuído aos Sócios da Empresa Controladora
 *   3.11.02       -> Atribuído aos Sócios Não Controladores
 *
 * Nota: Versões mais antigas da CVM usavam nomenclaturas ligeiramente
 *       diferentes (ex: "Lucro/Prejuízo Consolidado do Período").
 *       O código 3.11 é o padrão desde a taxonomia de 2011.
 */
const ACCOUNT_NET_INCOME_CONSOLIDATED = '3.11';
const ACCOUNT_NET_INCOME_PARENT = '3.11.01';
const ACCOUNT_NET_INCOME_NON_CONTROLLING = '3.11.02';
const ACCOUNT_REVENUE = '3.01';
const ACCOUNT_COGS = '3.02';
const ACCOUNT_EBIT = '3.05';
const ACCOUNT_EQUITY_CONSOLIDATED = '2.03';
const ACCOUNT_TOTAL_ASSETS = '1';
const ACCOUNT_CASH = '1.01';
const ACCOUNT_CURRENT_LIABILITIES = '2.01';
const ACCOUNT_NON_CURRENT_LIABILITIES = '2.02';
const ACCOUNT_OPERATING_CASH_FLOW = '6.01';

/**
 * Nomes alternativos encontrados na descrição da conta `3.99` em diferentes
 * layouts da CVM ao longo dos anos.
 */
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
  referenceDate: string; // DT_REFER - data de entrega do demonstrativo
  companyName: string;
  currencyScale: string;
  exerciseOrder: string; // ORDEM_EXERC - ÚLTIMO ou PENÚLTIMO
  exerciseStartDate: string; // DT_INI_EXERC - início do período contábil
  exerciseEndDate: string; // DT_FIM_EXERC - fim do período contábil
  accountCode: string;
  accountDescription: string;
  rawValue: string;
}

interface CvmExtractedData {
  fundamentals: CompanyFundamentals[];
}

// ---- Serviço ----

export class CvmStorageService {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor() {
    this.baseUrl = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC';
    this.userAgent = 'Urano-FinBot/0.1 (ETL-CVM; contato@urano.app)';
  }

  /**
   * Executa o processo completo de ETL para um CNPJ e ano fiscal:
   *  1. Download do ZIP de DFP do ano informado
   *  2. Extração em memória do arquivo DRE consolidada
   *  3. Parsing do CSV e filtro pelo CNPJ alvo
   *  4. Conversão de escala monetária e mapeamento para entidade de domínio
   *
   * @param year      Ano fiscal (ex: 2024)
   * @param targetCnpj CNPJ numérico da empresa (ex: "33000167000101" para Petrobras)
   * @returns Dados fundamentalistas estruturados
   */
  async fetchAndParseCvmData(
    year: number,
    targetCnpj: string,
  ): Promise<CvmExtractedData> {
    const zipUrl = this.buildDfpZipUrl(year);
    console.log(`[CvmStorageService] Baixando ZIP: ${zipUrl}`);

    const zipBuffer = await this.downloadZip(zipUrl);
    console.log(
      `[CvmStorageService] ZIP baixado (${(zipBuffer.byteLength / 1024 / 1024).toFixed(2)} MB). Extraindo DRE + BPP...`,
    );

    // Extrai DRE (Lucro Líquido)
    const dreCsv = await this.extractCsvFromZip(zipBuffer, `DRE_con_${year}.csv`);
    console.log(
      `[CvmStorageService] CSV DRE extraído (${(dreCsv.length / 1024 / 1024).toFixed(2)} MB).`,
    );

    const dreRows = this.parseCsv(dreCsv);
    console.log(`[CvmStorageService] ${dreRows.length} linhas DRE. Filtrando CNPJ ${targetCnpj}...`);

    const fundamentals = this.filterAndMapToEntity(dreRows, targetCnpj, year);
    console.log(
      `[CvmStorageService] ${fundamentals.length} registros DRE encontrados.`,
    );

    // Extrai BPP (Equity + Liabilities), BPA (Assets), DFC (Cash Flow)
    await this.enrichFromBpp(zipBuffer, year, targetCnpj, fundamentals);
    await this.enrichFromBpa(zipBuffer, year, targetCnpj, fundamentals);
    await this.enrichFromDfc(zipBuffer, year, targetCnpj, fundamentals);
    await this.enrichFromCapital(zipBuffer, year, targetCnpj, fundamentals);
    await this.enrichFromDmpl(zipBuffer, year, targetCnpj, fundamentals);

    return { fundamentals };
  }

  // ---------------------------------------------------------------------------
  // Métodos privados
  // ---------------------------------------------------------------------------

  /** Monta a URL de download do ZIP de DFP para o ano informado */
  private buildDfpZipUrl(year: number): string {
    return `${this.baseUrl}/DFP/DADOS/dfp_cia_aberta_${year}.zip`;
  }

  /** Monta a URL de download do ZIP de ITR para o ano informado */
  private buildItrZipUrl(year: number): string {
    return `${this.baseUrl}/ITR/DADOS/itr_cia_aberta_${year}.zip`;
  }

  /** Faz o download do ZIP com retry e timeout */
  private async downloadZip(url: string): Promise<ArrayBuffer> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Falha ao baixar ZIP (HTTP ${response.status}): ${url}`,
          );
        }

        return await response.arrayBuffer();
      } finally {
        clearTimeout(timeout);
      }
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000 });
  }

  /**
   * Extrai um arquivo CSV específico de dentro do ZIP em memória.
   * @param zipBuffer Buffer do ZIP já baixado
   * @param csvPattern Padrão do nome do arquivo (ex: "DRE_con_2024.csv")
   */
  private async extractCsvFromZip(
    zipBuffer: ArrayBuffer,
    csvPattern: string,
  ): Promise<string> {
    const zip = await JSZip.loadAsync(zipBuffer);

    const targetFile = Object.keys(zip.files).find((name) =>
      name.includes(csvPattern),
    );

    if (!targetFile) {
      const availableFiles = Object.keys(zip.files).join(', ');
      throw new Error(
        `Arquivo "${csvPattern}" não encontrado no ZIP. ` +
          `Disponíveis: ${availableFiles}`,
      );
    }

    return zip.file(targetFile)!.async('string');
  }

  /** Extrai um valor de conta específica de um CSV e retorna Map<data, valor> */
  private extractAccountFromCsv(
    rows: CvmDreRow[],
    targetCnpj: string,
    accountCode: string,
  ): Map<string, number> {
    const normalizeCnpj = (cnpj: string): string =>
      cnpj.replace(/[.\/-]/g, '').trim();

    const normalizedTarget = normalizeCnpj(targetCnpj);
    const result = new Map<string, number>();

    for (const row of rows) {
      if (normalizeCnpj(row.cnpj) !== normalizedTarget) continue;
      if (row.accountCode !== accountCode) continue;

      const periodKey = row.exerciseEndDate || row.referenceDate;
      const scaleFactor = SCALE_FACTORS[row.currencyScale] ?? 1;
      const value = parseFloat(row.rawValue) * scaleFactor;
      result.set(periodKey, value);
    }

    return result;
  }

  /** Enriquece com BPP: Equity (2.03) + Current Liabilities (2.01) + Non-Current (2.02) */
  private async enrichFromBpp(
    zipBuffer: ArrayBuffer, year: number, targetCnpj: string,
    fundamentals: CompanyFundamentals[],
  ): Promise<void> {
    try {
      const csv = await this.extractCsvFromZip(zipBuffer, `BPP_con_${year}.csv`);
      const rows = this.parseCsv(csv);
      const equityMap = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_EQUITY_CONSOLIDATED);
      const currentLiab = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_CURRENT_LIABILITIES);
      const nonCurrentLiab = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_NON_CURRENT_LIABILITIES);
      for (const f of fundamentals) {
        const e = equityMap.get(f.referenceDate);
        if (e !== undefined) f.equity = e;
        const cl = currentLiab.get(f.referenceDate);
        const ncl = nonCurrentLiab.get(f.referenceDate);
        if (cl !== undefined || ncl !== undefined) {
          f.totalLiabilities = (cl ?? 0) + (ncl ?? 0);
        }
      }
      console.log(`[CvmStorageService] BPP: ${equityMap.size} equity, ${currentLiab.size} curr.liab, ${nonCurrentLiab.size} non-curr.liab`);
    } catch (err) {
      console.warn(`[CvmStorageService] ⚠️ BPP indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Enriquece com BPA: Total Assets (1) + Cash (1.01) */
  private async enrichFromBpa(
    zipBuffer: ArrayBuffer, year: number, targetCnpj: string,
    fundamentals: CompanyFundamentals[],
  ): Promise<void> {
    try {
      const csv = await this.extractCsvFromZip(zipBuffer, `BPA_con_${year}.csv`);
      const rows = this.parseCsv(csv);
      const assetsMap = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_TOTAL_ASSETS);
      const cashMap = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_CASH);
      for (const f of fundamentals) {
        const a = assetsMap.get(f.referenceDate);
        if (a !== undefined) f.totalAssets = a;
        const c = cashMap.get(f.referenceDate);
        if (c !== undefined) f.cash = c;
      }
      console.log(`[CvmStorageService] BPA: ${assetsMap.size} assets, ${cashMap.size} cash`);
    } catch (err) {
      console.warn(`[CvmStorageService] ⚠️ BPA indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Enriquece com DFC: Operating Cash Flow (6.01) */
  private async enrichFromDfc(
    zipBuffer: ArrayBuffer, year: number, targetCnpj: string,
    fundamentals: CompanyFundamentals[],
  ): Promise<void> {
    try {
      const csv = await this.extractCsvFromZip(zipBuffer, `DFC_MI_con_${year}.csv`);
      const rows = this.parseCsv(csv);
      const ocfMap = this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_OPERATING_CASH_FLOW);
      for (const f of fundamentals) {
        const ocf = ocfMap.get(f.referenceDate);
        if (ocf !== undefined) f.operatingCashFlow = ocf;
      }
      console.log(`[CvmStorageService] DFC: ${ocfMap.size} operating cash flow`);
    } catch (err) {
      console.warn(`[CvmStorageService] ⚠️ DFC indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Enriquece com Composição de Capital: número total de ações */
  private async enrichFromCapital(
    zipBuffer: ArrayBuffer, year: number, targetCnpj: string,
    fundamentals: CompanyFundamentals[],
  ): Promise<void> {
    try {
      const csvContent = await this.extractCsvFromZip(zipBuffer, `composicao_capital_${year}.csv`);
      const lines = this.splitCsvLines(csvContent);
      if (lines.length < 2) return;

      const header = this.parseCsvLine(lines[0]!);
      const idxCnpj = header.indexOf('CNPJ_CIA');
      const idxShares = header.indexOf('QT_ACAO_TOTAL_CAP_INTEGR');
      if (idxCnpj < 0 || idxShares < 0) return;

      const normalizeCnpj = (cnpj: string): string => cnpj.replace(/[.\/-]/g, '').trim();
      const normalizedTarget = normalizeCnpj(targetCnpj);

      for (let i = 1; i < lines.length; i++) {
        const fields = this.parseCsvLine(lines[i]!);
        if (normalizeCnpj(fields[idxCnpj] ?? '') === normalizedTarget) {
          let totalShares = parseFloat((fields[idxShares] ?? '0').replace(/[^0-9.-]/g, ''));
          if (totalShares > 0) {
            // Algumas empresas reportam em milhares (ex: VALE3 4.539.008 → 4.5Bi)
            // Heurística: se < 100 milhões, assume que está em milhares
            if (totalShares < 100_000_000) totalShares *= 1000;
            for (const f of fundamentals) {
              f.sharesOutstanding = totalShares;
            }
            console.log(`[CvmStorageService] Capital: ${(totalShares / 1e9).toFixed(2)}Bi shares`);
          }
          break;
        }
      }
    } catch (err) {
      console.warn(`[CvmStorageService] ⚠️ Capital indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Enriquece com DMPL: Dividendos (5.04.06) e JCP (5.04.07) — coluna total */
  private async enrichFromDmpl(
    zipBuffer: ArrayBuffer, year: number, targetCnpj: string,
    fundamentals: CompanyFundamentals[],
  ): Promise<void> {
    try {
      const csvContent = await this.extractCsvFromZip(zipBuffer, `DMPL_con_${year}.csv`);
      const lines = this.splitCsvLines(csvContent);
      if (lines.length < 2) return;

      const header = this.parseCsvLine(lines[0]!);
      const idxCnpj = header.indexOf('CNPJ_CIA');
      const idxCol = header.indexOf('COLUNA_DF');
      const idxCd = header.indexOf('CD_CONTA');
      const idxVl = header.indexOf('VL_CONTA');
      const idxEscala = header.indexOf('ESCALA_MOEDA');
      const idxOrdem = header.indexOf('ORDEM_EXERC');
      const idxDtFim = header.indexOf('DT_FIM_EXERC');

      if (idxCnpj < 0 || idxCol < 0 || idxCd < 0 || idxVl < 0) return;

      const normalizeCnpj = (cnpj: string): string => cnpj.replace(/[.\/-]/g, '').trim();
      const normalizedTarget = normalizeCnpj(targetCnpj);

      // Mapa: periodKey → { dividends, jcp }
      const divMap = new Map<string, { dividends: number; jcp: number }>();

      for (let i = 1; i < lines.length; i++) {
        const fields = this.parseCsvLine(lines[i]!);
        if (normalizeCnpj(fields[idxCnpj] ?? '') !== normalizedTarget) continue;

        // Só interessa a coluna TOTAL (Patrimônio Líquido Consolidado)
        const coluna = (fields[idxCol] ?? '').toLowerCase();
        if (!coluna.includes('consolidado')) continue;

        const code = fields[idxCd] ?? '';
        const rawValue = parseFloat((fields[idxVl] ?? '0').replace(',', '.'));
        if (rawValue === 0) continue;

        const periodKey = fields[idxDtFim] || '';
        const scaleFactor = SCALE_FACTORS[fields[idxEscala] ?? ''] ?? 1;
        const value = Math.abs(rawValue) * scaleFactor;

        if (!divMap.has(periodKey)) {
          divMap.set(periodKey, { dividends: 0, jcp: 0 });
        }
        const entry = divMap.get(periodKey)!;

        if (code === '5.04.06') entry.dividends += value;
        else if (code === '5.04.07') entry.jcp += value;
      }

      for (const f of fundamentals) {
        const d = divMap.get(f.referenceDate);
        if (d) {
          if (d.dividends > 0) f.dividendsPaid = d.dividends;
          if (d.jcp > 0) f.jcpPaid = d.jcp;
        }
      }
      console.log(`[CvmStorageService] DMPL: ${divMap.size} periods with dividends`);
    } catch (err) {
      console.warn(`[CvmStorageService] ⚠️ DMPL indisponível: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** @deprecated Use extractAccountFromCsv */
  private extractEquityFromBpp(
    rows: CvmDreRow[],
    targetCnpj: string,
  ): Map<string, number> {
    return this.extractAccountFromCsv(rows, targetCnpj, ACCOUNT_EQUITY_CONSOLIDATED);
  }

  /**
   * Faz o parsing de uma string CSV no formato da CVM (delimitador `;`).
   *
   * Lida com:
   *  - Campos entre aspas (contendo delimitadores e quebras de linha)
   *  - Aspas escapadas dentro de campos ("" → ")
   *  - Linhas com número variável de colunas (robusto)
   */
  private parseCsv(csvContent: string): CvmDreRow[] {
    const rows: CvmDreRow[] = [];
    const lines = this.splitCsvLines(csvContent);

    if (lines.length < 2) return rows; // Precisa de header + pelo menos 1 linha de dados

    const header = this.parseCsvLine(lines[0]!);
    const colIndex = this.buildColumnIndex(header);

    // Resolve índices das colunas obrigatórias
    const idxCnpj = this.getColumnIndex(colIndex, 'CNPJ_CIA');
    const idxDtRefer = this.getColumnIndex(colIndex, 'DT_REFER');
    const idxDenomCia = this.getColumnIndex(colIndex, 'DENOM_CIA');
    const idxEscalaMoeda = this.getOptionalColumnIndex(colIndex, 'ESCALA_MOEDA');
    const idxOrdemExerc = this.getColumnIndex(colIndex, 'ORDEM_EXERC');
    const idxDtIniExerc = this.getOptionalColumnIndex(colIndex, 'DT_INI_EXERC');
    const idxDtFimExerc = this.getColumnIndex(colIndex, 'DT_FIM_EXERC');
    const idxCdConta = this.getColumnIndex(colIndex, 'CD_CONTA');
    const idxDsConta = this.getColumnIndex(colIndex, 'DS_CONTA');
    const idxVlConta = this.getColumnIndex(colIndex, 'VL_CONTA');

    // Processa cada linha de dados
    for (let i = 1; i < lines.length; i++) {
      const fields = this.parseCsvLine(lines[i]!);

      if (fields.length < header.length) continue; // Linha malformada, ignora

      rows.push({
        cnpj: fields[idxCnpj] ?? '',
        referenceDate: fields[idxDtRefer] ?? '',
        companyName: fields[idxDenomCia] ?? '',
        currencyScale: idxEscalaMoeda >= 0 ? (fields[idxEscalaMoeda] ?? 'UNIDADE') : 'UNIDADE',
        exerciseOrder: fields[idxOrdemExerc] ?? '',
        exerciseStartDate: idxDtIniExerc >= 0 ? (fields[idxDtIniExerc] ?? '') : '',
        exerciseEndDate: fields[idxDtFimExerc] ?? '',
        accountCode: fields[idxCdConta] ?? '',
        accountDescription: fields[idxDsConta] ?? '',
        rawValue: fields[idxVlConta] ?? '0',
      });
    }

    return rows;
  }

  /**
   * Divide o conteúdo CSV bruto em linhas lógicas, respeitando campos
   * multilinha (quando o campo está entre aspas e contém \n).
   */
  private splitCsvLines(content: string): string[] {
    const lines: string[] = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i]!;

      if (char === '"') {
        insideQuotes = !insideQuotes;
      }

      if (char === '\n' && !insideQuotes) {
        lines.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    // Última linha (sem \n final)
    if (current.length > 0) {
      lines.push(current);
    }

    return lines;
  }

  /**
   * Faz o parsing de uma única linha CSV, respeitando aspas e escapes.
   * Retorna um array com os valores de cada coluna (sem as aspas externas).
   */
  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;

      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          // Escape: duas aspas seguidas dentro de campo aspeado → uma aspa literal
          current += '"';
          i++; // Pula a próxima aspa
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === CVM_CSV_DELIMITER && !insideQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    // Último campo (sem delimitador no final)
    fields.push(current.trim());

    return fields;
  }

  /**
   * Constrói um mapa nome-coluna → índice a partir do header do CSV.
   * Isso torna o código resiliente a mudanças na ordem das colunas.
   */
  private buildColumnIndex(header: string[]): Map<string, number> {
    const index = new Map<string, number>();
    for (let i = 0; i < header.length; i++) {
      index.set(header[i]!, i);
    }
    return index;
  }

  /** Busca o índice de uma coluna pelo nome, lançando erro se ausente */
  private getColumnIndex(colIndex: Map<string, number>, name: string): number {
    const idx = colIndex.get(name);
    if (idx === undefined) {
      throw new Error(
        `Coluna obrigatória "${name}" não encontrada no CSV da CVM. ` +
          `Colunas disponíveis: ${[...colIndex.keys()].join(', ')}`,
      );
    }
    return idx;
  }

  /** Busca o índice de uma coluna opcional, retornando -1 se ausente */
  private getOptionalColumnIndex(colIndex: Map<string, number>, name: string): number {
    return colIndex.get(name) ?? -1;
  }

  /**
   * Filtra as linhas pelo CNPJ alvo, converte a escala monetária e
   * mapeia para a entidade de domínio CompanyFundamentals.
   *
   * Agrupa as linhas por data de referência + ordem de exercício,
   * capturando tanto o lucro consolidado (3.99) quanto o atribuído
   * aos controladores (3.99.01.01).
   */
  private filterAndMapToEntity(
    rows: CvmDreRow[],
    targetCnpj: string,
    fiscalYear: number,
  ): CompanyFundamentals[] {
    // Normaliza CNPJs: remove pontuação (pontos, barras, traços) para comparação
    const normalizeCnpj = (cnpj: string): string =>
      cnpj.replace(/[.\/-]/g, '').trim();

    const normalizedTarget = normalizeCnpj(targetCnpj);

    // Filtra apenas linhas do CNPJ alvo e das contas de interesse
    const relevantRows = rows.filter((row) => {
      if (normalizeCnpj(row.cnpj) !== normalizedTarget) return false;

      // Aceita contas da DRE: Lucro (3.11.x), Receita (3.01), EBIT (3.05)
      const codeMatch =
        row.accountCode === ACCOUNT_NET_INCOME_CONSOLIDATED ||
        row.accountCode === ACCOUNT_NET_INCOME_PARENT ||
        row.accountCode === ACCOUNT_NET_INCOME_NON_CONTROLLING ||
        row.accountCode === ACCOUNT_REVENUE ||
        row.accountCode === ACCOUNT_COGS ||
        row.accountCode === ACCOUNT_EBIT;

      if (codeMatch) return true;

      const descLower = row.accountDescription.toLowerCase().trim();
      return NET_INCOME_LABELS.some((label) => descLower.includes(label));
    });

    // Agrupa por data de fim do exercício
    interface GroupEntry {
      exerciseEndDate: string;
      companyName: string;
      netIncome: number;
      netIncomeParent: number;
      revenue: number;
      cogs: number;
      ebit: number;
      fiscalYear: number;
    }
    const grouped = new Map<string, GroupEntry>();

    for (const row of relevantRows) {
      const periodKey = row.exerciseEndDate || row.referenceDate;
      const periodYear = periodKey ? parseInt(periodKey.slice(0, 4), 10) : fiscalYear;
      const scaleFactor = SCALE_FACTORS[row.currencyScale] ?? 1;
      const value = parseFloat(row.rawValue) * scaleFactor;

      if (!grouped.has(periodKey)) {
        grouped.set(periodKey, {
          exerciseEndDate: periodKey,
          companyName: row.companyName,
          netIncome: 0,
          netIncomeParent: 0,
          revenue: 0,
          cogs: 0,
          ebit: 0,
          fiscalYear: periodYear,
        });
      }

      const entry = grouped.get(periodKey)!;

      if (row.accountCode === ACCOUNT_NET_INCOME_CONSOLIDATED) entry.netIncome = value;
      else if (row.accountCode === ACCOUNT_NET_INCOME_PARENT) entry.netIncomeParent = value;
      else if (row.accountCode === ACCOUNT_REVENUE) entry.revenue = value;
      else if (row.accountCode === ACCOUNT_COGS) entry.cogs = value;
      else if (row.accountCode === ACCOUNT_EBIT) entry.ebit = value;
    }

    const fundamentals: CompanyFundamentals[] = [];
    for (const [, entry] of grouped) {
      fundamentals.push({
        cnpj: targetCnpj,
        ticker: '',
        companyName: entry.companyName,
        referenceDate: entry.exerciseEndDate,
        netIncome: entry.netIncome,
        netIncomeAttributableToParent: entry.netIncomeParent || entry.netIncome,
        revenue: entry.revenue || undefined,
        cogs: entry.cogs || undefined,
        ebit: entry.ebit || undefined,
        fiscalYear: entry.fiscalYear,
        source: 'DFP',
        extractedAt: new Date(),
      });
    }

    return fundamentals;
  }
}
