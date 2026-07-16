import type {
  CompanyFundamentals,
  TTMNetIncome,
} from '../entities/company-fundamentals.ts';
import type { ICompanyRepository } from '../repositories/company-repository.ts';
import { CvmStorageService } from '../../infra/services/cvm-storage-service.ts';

/**
 * Mapeamento de ticker → CNPJ para empresas a serem sincronizadas.
 *
 * No futuro, isso será carregado de uma tabela de configuração no banco.
 * CNPJ deve ter 14 dígitos numéricos (sem pontuação).
 */
export const TICKER_TO_CNPJ: Readonly<Record<string, string>> = {
  // Petrobras
  PETR4: '33000167000101', PETR3: '33000167000101',
  // Vale
  VALE3: '33592510000154',
  // Bancos
  ITUB4: '60872504000123', ITUB3: '60872504000123',
  BBDC4: '60746948000112', BBDC3: '60746948000112',
  BBAS3: '00000000000191',
  SANB11: '90400888000142',
  // Mineração e Siderurgia
  GGBR4: '33611500000119', GGBR3: '33611500000119',
  CSNA3: '08902291000115',
  USIM5: '60894730000105', USIM3: '60894730000105',
  // Energia Elétrica
  ELET3: '00001180000126', ELET6: '00001180000126',
  CPLE6: '76483817000120', CPLE3: '76483817000120',
  CPFE3: '04215317000106',
  EGIE3: '02474103000119',
  // Petróleo e Gás
  PRIO3: '10629105000168',
  // Papel e Celulose
  SUZB3: '16404287000155',
  KLBN11: '89637490000145', KLBN4: '89637490000145',
  // Alimentos e Bebidas
  ABEV3: '07526557000100',
  JBSS3: '02916265000160',
  // Varejo
  MGLU3: '47960950000121',
  // Saúde
  HAPV3: '05197443000138',
  // Máquinas e Equipamentos
  WEGE3: '84429695000111',
  EMBR3: '07689002000189',
  // Telecom
  VIVT3: '02558157000162', VIVT4: '02558157000162',
  TIMS3: '02421421000111',
  // Transporte e Logística
  RAIL3: '02387241000160',
  CCRO3: '02846056000197',
  // Construção
  CYRE3: '73178600000118',
  // Shoppings
  MULT3: '07816890000153',
  // Holding / Conglomerados
  ITSA4: '61532644000115', ITSA3: '61532644000115',
  // Saneamento
  SAPR4: '76484013000145', SAPR3: '76484013000145', SAPR11: '76484013000145',
  // Alimentos
  MDIA3: '07206816000115',
  // ── +45 tickers expandidos ──
  CMIG4: '17155754000120', TAEE11: '08526376000149', ENGI11: '04775428000190',
  ENEV3: '04423954000157', ALUP11: '07608270000188', EQTL3: '03376050000178',
  GOAU4: '33320032000159', CMIN3: '08347896000140',
  BRAV3: '07985207000158', RECV3: '12344550000197',
  BRFS3: '01123497000149', MRFG3: '03505682000153', BEEF3: '07385118000137',
  RDOR3: '06528286000121', FLRY3: '60865550000148',
  ONCO3: '12436135000121', QUAL3: '11150363000180', DASA3: '61486579000179',
  LREN3: '93885146000135', NTCO3: '52434108000107', ASAI3: '06502780000149',
  GMAT3: '05690950000119', BHIA3: '06014855000105', PETZ3: '18328118000190',
  ARZZ3: '16502708000198', TUPY3: '84587126000141', MYPK3: '61122816000160',
  ROMI3: '56711154000110', STBP3: '07956808000157', ECOR3: '04149511000106',
  MRVE3: '08929050000129', EZTC3: '08312728000184', DIRR3: '16614138000119',
  TOTS3: '53113791000122', LWSA3: '11662685000173', CASH3: '09107000000148',
  RADL3: '61585144000177', RENT3: '71681390000107',
  SMTO3: '51901295000151', SLCE3: '49353498000179', VAMO3: '23290290000165',
  BPAC11: '30280595000183', BPAN4: '61153721000109',
  // Adicionais de alta liquidez (cadastro oficial de companhias abertas CVM)
  BBSE3: '17344597000194', B3SA3: '09346601000125',
  HYPE3: '02932074000191', IGTI11: '60543816000193',
  RAIZ4: '33453598000123', PSSA3: '02149205000169',
  CSAN3: '50746577000115',
};

export interface SyncCompanyFundamentalsInput {
  ticker: string;
  year?: number;
}

export interface SyncCompanyFundamentalsOutput {
  ticker: string;
  cnpj: string;
  year: number;
  recordsImported: number;
  fundamentals: CompanyFundamentals[];
  ttm?: TTMNetIncome;
}

export interface SyncBatchOutput {
  ticker: string;
  cnpj: string;
  year: number;
  recordsImported: number;
  companyName: string;
  ttmNetIncome?: number;
  error?: string;
}

export const DEFAULT_CVM_MIN_COVERAGE_PERCENT = 80;
export const MIN_ALLOWED_CVM_COVERAGE_PERCENT = 70;

export interface SyncBatchOptions {
  minCoveragePercent?: number;
}

export interface CvmCoverageReport {
  year: number;
  candidateTickers: string[];
  candidateCompanies: number;
  resolvedCnpjs: string[];
  foundCnpjs: string[];
  missingCnpjs: string[];
  unmappedTickers: string[];
  coveragePercent: number;
  minCoveragePercent: number;
  passed: boolean;
}

export interface SyncBatchExecution {
  results: SyncBatchOutput[];
  coverage: CvmCoverageReport;
}

export class CvmCoverageError extends Error {
  constructor(public readonly report: CvmCoverageReport) {
    super(
      `Cobertura CVM ${report.year} insuficiente: ` +
      `${report.coveragePercent.toFixed(2)}% < ${report.minCoveragePercent.toFixed(2)}%.`,
    );
    this.name = 'CvmCoverageError';
  }
}

const normalizeCnpj = (cnpj: string): string => cnpj.replace(/[./-]/g, '').trim();

export class SyncCompanyFundamentalsUseCase {
  constructor(
    private readonly companyRepository: ICompanyRepository,
    private readonly cvmService: CvmStorageService = new CvmStorageService(),
  ) {}

  /**
   * Batch: baixa ZIP 1×, parseia 1×, persiste todos os tickers.
   * Pico de memória ~50 MB (vs ~300 MB do modo ticker-a-ticker).
   */
  async executeBatch(
    tickers: string[],
    year: number,
    options: SyncBatchOptions = {},
  ): Promise<SyncBatchExecution> {
    const minCoveragePercent = options.minCoveragePercent
      ?? DEFAULT_CVM_MIN_COVERAGE_PERCENT;
    if (
      !Number.isFinite(minCoveragePercent)
      || minCoveragePercent < MIN_ALLOWED_CVM_COVERAGE_PERCENT
      || minCoveragePercent > 100
    ) {
      throw new RangeError(
        `minCoveragePercent deve estar entre ${MIN_ALLOWED_CVM_COVERAGE_PERCENT} e 100.`,
      );
    }

    const candidateTickers = [...new Set(
      tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean),
    )];

    // 1. Resolve CNPJs (filtra os que não têm mapeamento)
    const tickerCnpjMap = new Map<string, string>();
    const skipped: SyncBatchOutput[] = [];

    for (const t of candidateTickers) {
      try {
        const cnpj = this.resolveCnpj(t);
        tickerCnpjMap.set(t, cnpj);
      } catch (err) {
        skipped.push({
          ticker: t, cnpj: '', year, recordsImported: 0, companyName: '',
          error: (err as Error).message,
        });
      }
    }

    // 2. Chama CVM UMA vez para todos os CNPJs
    const cnpjs = [...new Set([...tickerCnpjMap.values()].map(normalizeCnpj))];
    console.log(
      `[SyncCompanyFundamentals] Batch: ${candidateTickers.length} tickers → ${cnpjs.length} CNPJs únicos, ano ${year}`,
    );

    const dataByCnpj = cnpjs.length > 0
      ? await this.cvmService.fetchAndParseCvmDataBatch(year, cnpjs)
      : new Map<string, CompanyFundamentals[]>();

    // Gate antes de QUALQUER upsert: uma execução incompleta não pode trocar
    // silenciosamente o universo nem publicar um backtest enviesado.
    const foundCnpjs = cnpjs.filter((cnpj) => {
      const fundamentals = dataByCnpj.get(cnpj) ?? [];
      return fundamentals.some(
        (item) => item.source === 'DFP' && item.fiscalYear === year,
      );
    });
    const foundSet = new Set(foundCnpjs);
    const missingCnpjs = cnpjs.filter((cnpj) => !foundSet.has(cnpj));
    const unmappedTickers = skipped.map((item) => item.ticker);
    const candidateCompanies = cnpjs.length + unmappedTickers.length;
    const coveragePercent = candidateCompanies > 0
      ? (foundCnpjs.length / candidateCompanies) * 100
      : 0;
    const coverage: CvmCoverageReport = {
      year,
      candidateTickers,
      candidateCompanies,
      resolvedCnpjs: cnpjs,
      foundCnpjs,
      missingCnpjs,
      unmappedTickers,
      coveragePercent: Math.round(coveragePercent * 100) / 100,
      minCoveragePercent,
      passed: coveragePercent >= minCoveragePercent,
    };

    if (!coverage.passed) {
      throw new CvmCoverageError(coverage);
    }

    // 3. Para cada ticker, persiste os fundamentos do seu CNPJ
    const results: SyncBatchOutput[] = [];

    for (const [ticker, cnpj] of tickerCnpjMap) {
      try {
        const fundamentals = dataByCnpj.get(normalizeCnpj(cnpj)) ?? [];

        if (fundamentals.length === 0) {
          results.push({ ticker, cnpj, year, recordsImported: 0, companyName: '' });
          continue;
        }

        // Enriquece com ticker
        for (const f of fundamentals) f.ticker = ticker;

        // Persiste
        for (const f of fundamentals) {
          await this.companyRepository.upsertFundamentals(f);
        }

        // TTM
        let ttmNetIncome: number | undefined;
        try {
          const ttm = await this.calculateTTM(cnpj);
          if (ttm) ttmNetIncome = ttm.ttmNetIncome;
        } catch { /* ok */ }

        results.push({
          ticker, cnpj, year,
          recordsImported: fundamentals.length,
          companyName: fundamentals[0]!.companyName,
          ttmNetIncome,
        });
      } catch (err) {
        results.push({
          ticker, cnpj, year, recordsImported: 0, companyName: '',
          error: (err as Error).message,
        });
      }
    }

    return { results: [...results, ...skipped], coverage };
  }

  /**
   * Orquestra a sincronização de dados fundamentalistas:
   *  1. Resolve o CNPJ a partir do ticker
   *  2. Baixa e faz parsing dos dados da CVM via CvmStorageService
   *  3. Enriquece cada registro com o ticker
   *  4. Persiste via repositório
   *  5. Calcula o TTM (Trailing Twelve Months) de lucro líquido
   */
  async execute(
    input: SyncCompanyFundamentalsInput,
  ): Promise<SyncCompanyFundamentalsOutput> {
    const { ticker } = input;
    const year = input.year ?? new Date().getFullYear();

    // 1. Resolve CNPJ
    const cnpj = this.resolveCnpj(ticker);

    // 2. ETL da CVM
    console.log(
      `[SyncCompanyFundamentals] Iniciando sincronização para ${ticker} (CNPJ: ${cnpj}) ano ${year}`,
    );

    const { fundamentals } = await this.cvmService.fetchAndParseCvmData(
      year,
      cnpj,
    );

    if (fundamentals.length === 0) {
      console.warn(
        `[SyncCompanyFundamentals] Nenhum dado encontrado para ${ticker} no ano ${year}.`,
      );
      return { ticker, cnpj, year, recordsImported: 0, fundamentals: [] };
    }

    // 3. Enriquece com o ticker
    for (const f of fundamentals) {
      f.ticker = ticker;
    }

    // 4. Persiste cada registro
    let recordsImported = 0;
    for (const f of fundamentals) {
      await this.companyRepository.upsertFundamentals(f);
      recordsImported++;
    }

    console.log(
      `[SyncCompanyFundamentals] ${recordsImported} registros persistidos para ${ticker}.`,
    );

    // 5. Calcula TTM
    const ttm = await this.calculateTTM(cnpj);
    if (ttm) {
      console.log(
        `[SyncCompanyFundamentals] TTM Lucro Líquido (${ticker}): R$ ${(ttm.ttmNetIncome / 1_000_000_000).toFixed(2)}Bi ` +
          `(${ttm.periods} trimestres, último: ${ttm.latestQuarter})`,
      );
    }

    return { ticker, cnpj, year, recordsImported, fundamentals, ttm };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Resolve CNPJ a partir do ticker, com mensagem clara se não encontrado */
  private resolveCnpj(ticker: string): string {
    const upperTicker = ticker.toUpperCase();
    const cnpj = TICKER_TO_CNPJ[upperTicker];

    if (!cnpj) {
      const available = Object.keys(TICKER_TO_CNPJ).join(', ');
      throw new Error(
        `CNPJ não encontrado para o ticker "${upperTicker}". ` +
          `Tickers disponíveis: ${available}. ` +
          `Adicione o mapeamento em TICKER_TO_CNPJ.`,
      );
    }

    return cnpj;
  }

  /**
   * Calcula o Lucro Líquido TTM (Trailing Twelve Months) somando os últimos
   * 4 trimestres disponíveis no banco.
   */
  private async calculateTTM(cnpj: string): Promise<TTMNetIncome | undefined> {
    const history = await this.companyRepository.findQuarterlyNetIncomeHistory(
      cnpj,
      4,
    );

    if (history.length === 0) {
      return undefined;
    }

    const ttmNetIncome = history.reduce((sum, q) => sum + q.netIncome, 0);

    return {
      ttmNetIncome,
      periods: history.length,
      latestQuarter: history[0]!.referenceDate,
      quarters: history,
    };
  }
}
