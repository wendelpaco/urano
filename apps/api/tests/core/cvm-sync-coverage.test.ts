import { describe, expect, test } from 'bun:test';
import type { CompanyFundamentals } from '../../src/core/entities/company-fundamentals.ts';
import type { ICompanyRepository } from '../../src/core/repositories/company-repository.ts';
import {
  CvmCoverageError,
  SyncCompanyFundamentalsUseCase,
} from '../../src/core/use-cases/sync-company-fundamentals.ts';
import type { CvmStorageService } from '../../src/infra/services/cvm-storage-service.ts';

const PETR_CNPJ = '33000167000101';
const VALE_CNPJ = '33592510000154';

const fundamental = (
  cnpj: string,
  fiscalYear = 2024,
): CompanyFundamentals => ({
  cnpj,
  ticker: '',
  companyName: cnpj === PETR_CNPJ ? 'PETROBRAS' : 'VALE',
  referenceDate: `${fiscalYear}-12-31`,
  netIncome: 100,
  netIncomeAttributableToParent: 100,
  fiscalYear,
  source: 'DFP',
  extractedAt: new Date('2025-03-01T00:00:00Z'),
});

class MemoryRepository implements ICompanyRepository {
  readonly writes: CompanyFundamentals[] = [];
  readonly previousState = ['snapshot-anterior'];

  async upsertFundamentals(data: CompanyFundamentals): Promise<CompanyFundamentals> {
    this.writes.push({ ...data });
    return data;
  }

  async findLatestByCnpj(): Promise<CompanyFundamentals | null> {
    return null;
  }

  async findQuarterlyNetIncomeHistory(): Promise<[]> {
    return [];
  }
}

const cvmFixture = (
  entries: Array<[string, CompanyFundamentals[]]>,
): CvmStorageService => ({
  fetchAndParseCvmDataBatch: async () => new Map(entries),
} as unknown as CvmStorageService);

describe('SyncCompanyFundamentalsUseCase — coverage gate', () => {
  test('falha antes de qualquer upsert e relata CNPJs/tickers ausentes', async () => {
    // MemoryRepository é o mesmo tipo de fronteira usado no --dry-run: o gate
    // ocorre antes dela, portanto vale igualmente com ou sem Postgres.
    const repository = new MemoryRepository();
    const useCase = new SyncCompanyFundamentalsUseCase(
      repository,
      cvmFixture([[PETR_CNPJ, [fundamental(PETR_CNPJ)]]]),
    );

    let coverageError: CvmCoverageError | undefined;
    try {
      await useCase.executeBatch(
        ['PETR4', 'VALE3', 'SEMCM3'],
        2024,
        { minCoveragePercent: 80 },
      );
    } catch (error) {
      if (error instanceof CvmCoverageError) coverageError = error;
      else throw error;
    }

    expect(coverageError).toBeInstanceOf(CvmCoverageError);
    expect(coverageError?.report).toMatchObject({
      year: 2024,
      candidateCompanies: 3,
      foundCnpjs: [PETR_CNPJ],
      missingCnpjs: [VALE_CNPJ],
      unmappedTickers: ['SEMCM3'],
      coveragePercent: 33.33,
      minCoveragePercent: 80,
      passed: false,
    });
    expect(repository.writes).toHaveLength(0);
    expect(repository.previousState).toEqual(['snapshot-anterior']);
  });

  test('dado de outro fiscalYear não conta como cobertura do ano solicitado', async () => {
    const repository = new MemoryRepository();
    const useCase = new SyncCompanyFundamentalsUseCase(
      repository,
      cvmFixture([
        [PETR_CNPJ, [fundamental(PETR_CNPJ)]],
        [VALE_CNPJ, [fundamental(VALE_CNPJ, 2023)]],
      ]),
    );

    await expect(useCase.executeBatch(
      ['PETR4', 'VALE3'],
      2024,
      { minCoveragePercent: 80 },
    )).rejects.toBeInstanceOf(CvmCoverageError);
    expect(repository.writes).toHaveLength(0);
  });

  test('persiste somente depois que o lote inteiro passa no gate', async () => {
    const repository = new MemoryRepository();
    const useCase = new SyncCompanyFundamentalsUseCase(
      repository,
      cvmFixture([
        [PETR_CNPJ, [fundamental(PETR_CNPJ)]],
        [VALE_CNPJ, [fundamental(VALE_CNPJ)]],
      ]),
    );

    const execution = await useCase.executeBatch(
      ['PETR4', 'VALE3'],
      2024,
      { minCoveragePercent: 100 },
    );

    expect(execution.coverage).toMatchObject({
      candidateCompanies: 2,
      coveragePercent: 100,
      missingCnpjs: [],
      passed: true,
    });
    expect(execution.results).toHaveLength(2);
    expect(repository.writes).toHaveLength(2);
  });
});
