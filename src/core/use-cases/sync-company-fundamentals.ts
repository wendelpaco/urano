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
const TICKER_TO_CNPJ: Record<string, string> = {
  PETR4: '33000167000101',
  PETR3: '33000167000101',
  VALE3: '33592510000154',
  ITUB4: '60872504000123',
  WEGE3: '84642135000102',
  BBDC4: '60746948000112',
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

export class SyncCompanyFundamentalsUseCase {
  constructor(
    private readonly companyRepository: ICompanyRepository,
    private readonly cvmService = new CvmStorageService(),
  ) {}

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
