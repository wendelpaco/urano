/**
 * Worker de sincronização de dados fundamentalistas da CVM.
 *
 * Conecta-se ao PostgreSQL para persistir os dados extraídos da CVM.
 * Utiliza UPSERT (ON CONFLICT DO UPDATE) para garantir idempotência.
 *
 * Modos de execução:
 *   - Com banco:    bun run src/infra/workers/cvm-sync-worker.ts PETR4
 *   - Dry-run:      bun run src/infra/workers/cvm-sync-worker.ts PETR4 2024 --dry-run
 *   - Múltiplos:    bun run src/infra/workers/cvm-sync-worker.ts --all 2024
 *
 * Argumentos:
 *   1. ticker | --all  (obrigatório) - Ticker da empresa ou "--all" para todas
 *   2. ano              (opcional)    - Ano fiscal. Padrão: ano atual.
 *   --dry-run           (opcional)    - Apenas extrai e exibe, sem persistir.
 *   --min-coverage=N     (opcional)    - Gate por empresa, entre 70 e 100.
 */

import 'dotenv/config';
import {
  CvmCoverageError,
  DEFAULT_CVM_MIN_COVERAGE_PERCENT,
  MIN_ALLOWED_CVM_COVERAGE_PERCENT,
  SyncCompanyFundamentalsUseCase,
  type CvmCoverageReport,
} from '../../core/use-cases/sync-company-fundamentals.ts';
import { PgCompanyRepository } from '../database/pg-company-repository.ts';
import { checkDatabaseConnection, closeDatabaseConnection } from '../database/connection.ts';
import type { ICompanyRepository } from '../../core/repositories/company-repository.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';
import { ALL_STOCK_TICKERS } from '../../shared/tickers-master-list.ts';

// ---------------------------------------------------------------------------
// Implementação de dry-run (apenas loga, sem persistir).
// Só pode ser usada quando --dry-run foi solicitado explicitamente.
// ---------------------------------------------------------------------------

class ConsoleCompanyRepository implements ICompanyRepository {
  private storage = new Map<string, CompanyFundamentals>();

  async upsertFundamentals(data: CompanyFundamentals): Promise<CompanyFundamentals> {
    const key = `${data.cnpj}|${data.referenceDate}|${data.source}`;
    this.storage.set(key, data);
    return data;
  }

  async findLatestByCnpj(cnpj: string): Promise<CompanyFundamentals | null> {
    let latest: CompanyFundamentals | null = null;
    for (const [, f] of this.storage) {
      if (f.cnpj === cnpj) {
        if (!latest || f.referenceDate > latest.referenceDate) {
          latest = f;
        }
      }
    }
    return latest;
  }

  async findQuarterlyNetIncomeHistory(
    cnpj: string,
    limit: number,
  ): Promise<Array<{ referenceDate: string; netIncome: number }>> {
    const results: Array<{ referenceDate: string; netIncome: number }> = [];
    for (const [, f] of this.storage) {
      if (f.cnpj === cnpj) {
        results.push({ referenceDate: f.referenceDate, netIncome: f.netIncomeAttributableToParent });
      }
    }
    results.sort(
      (a, b) =>
        new Date(b.referenceDate).getTime() -
        new Date(a.referenceDate).getTime(),
    );
    return results.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Lista completa de tickers para o modo --all
// (importada de tickers-master-list.ts — fonte única)
// ---------------------------------------------------------------------------
const ALL_TICKERS = ALL_STOCK_TICKERS;

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

interface CliArgs {
  tickers: string[];
  year: number;
  dryRun: boolean;
  allMode: boolean;
  minCoveragePercent: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allMode = args.includes('--all');
  const coverageFlag = args.find((arg) => arg.startsWith('--min-coverage='));
  const minCoveragePercent = Number(
    coverageFlag?.slice('--min-coverage='.length)
      ?? process.env.CVM_MIN_COVERAGE_PERCENT
      ?? DEFAULT_CVM_MIN_COVERAGE_PERCENT,
  );
  if (
    !Number.isFinite(minCoveragePercent)
    || minCoveragePercent < MIN_ALLOWED_CVM_COVERAGE_PERCENT
    || minCoveragePercent > 100
  ) {
    console.error(
      `❌ --min-coverage deve estar entre ${MIN_ALLOWED_CVM_COVERAGE_PERCENT} e 100.`,
    );
    process.exit(1);
  }

  // Filtra flags para extrair tickers e ano
  const positional = args.filter((a) => !a.startsWith('--'));

  if (allMode) {
    const year = positional[0] ? parseInt(positional[0], 10) : new Date().getFullYear();
    return { tickers: ALL_TICKERS, year, dryRun, allMode: true, minCoveragePercent };
  }

  if (positional.length === 0) {
    console.error('❌ Uso: bun run src/infra/workers/cvm-sync-worker.ts <TICKER|--all> [ANO] [--dry-run]');
    console.error('   Exemplos:');
    console.error('     bun run src/infra/workers/cvm-sync-worker.ts PETR4');
    console.error('     bun run src/infra/workers/cvm-sync-worker.ts PETR4 2024 --dry-run');
    console.error('     bun run src/infra/workers/cvm-sync-worker.ts --all 2024');
    process.exit(1);
  }

  const tickers = [positional[0]!.toUpperCase()];
  const year = positional[1] ? parseInt(positional[1], 10) : new Date().getFullYear();

  return { tickers, year, dryRun, allMode: false, minCoveragePercent };
}

function printCoverageReport(report: CvmCoverageReport): void {
  const status = report.passed ? '✅' : '❌';
  console.log(
    `${status} Cobertura CVM ${report.year}: ${report.foundCnpjs.length}/` +
    `${report.candidateCompanies} empresas (${report.coveragePercent.toFixed(2)}%; ` +
    `mínimo ${report.minCoveragePercent.toFixed(2)}%)`,
  );
  if (report.missingCnpjs.length > 0) {
    console.log(`   CNPJs sem DFP válida no ano: ${report.missingCnpjs.join(', ')}`);
  }
  if (report.unmappedTickers.length > 0) {
    console.log(`   Tickers sem CNPJ mapeado: ${report.unmappedTickers.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const { tickers, year, dryRun, allMode, minCoveragePercent } = parseArgs();

  // Determina modo e repositório
  let repository: ICompanyRepository;
  let modeLabel: string;

  if (dryRun) {
    repository = new ConsoleCompanyRepository();
    modeLabel = 'Dry-run (sem persistência em banco)';
  } else {
    try {
      await checkDatabaseConnection();
      repository = new PgCompanyRepository();
      modeLabel = 'PostgreSQL (persistência real)';
    } catch (error) {
      console.error(
        '❌ Banco de dados indisponível; a sincronização foi abortada para evitar um falso sucesso sem persistência.\n' +
          '   Execute "docker compose up -d" ou use --dry-run explicitamente.\n',
      );
      throw error;
    }
  }

  console.log(`\n🚀 Urano CVM Sync Worker`);
  console.log(`   Tickers: ${allMode ? 'TODOS (' + tickers.length + ')' : tickers.join(', ')}`);
  console.log(`   Ano:     ${year}`);
  console.log(`   Modo:    ${modeLabel}`);
  console.log(`   Gate:    cobertura mínima ${minCoveragePercent}%\n`);

  const useCase = new SyncCompanyFundamentalsUseCase(repository);
  const startTime = performance.now();

  // Processamento em batch: ZIP baixado 1×, CSVs parseados 1×, todos os tickers de uma vez
  let results;
  try {
    const execution = await useCase.executeBatch(tickers, year, { minCoveragePercent });
    printCoverageReport(execution.coverage);
    results = execution.results;
  } catch (error) {
    if (error instanceof CvmCoverageError) {
      printCoverageReport(error.report);
      console.error(
        '\n❌ Gate de cobertura reprovado antes de qualquer persistência. ' +
        'O estado anterior foi preservado e o pipeline deve parar.',
      );
    } else {
      console.error(
        '\n❌ Sincronização CVM abortada:',
        error instanceof Error ? error.message : error,
      );
    }

    if (!dryRun && repository instanceof PgCompanyRepository) {
      await closeDatabaseConnection();
    }
    process.exit(1);
  }

  let totalSuccess = 0;
  let totalRecords = 0;
  const errors: string[] = [];

  for (const r of results) {
    if (r.error) {
      console.error(`❌ ${r.ticker.padEnd(8)} | Erro: ${r.error}`);
      errors.push(`${r.ticker}: ${r.error}`);
    } else if (r.recordsImported > 0) {
      console.log(`✅ ${r.ticker.padEnd(8)} | ${r.recordsImported} registros | ${r.companyName}`);
      if (r.ttmNetIncome) {
        console.log(`   ↳ TTM Lucro Líquido: ${formatCurrency(r.ttmNetIncome)}`);
      }
      totalSuccess++;
      totalRecords += r.recordsImported;
    } else {
      console.log(`⚠️  ${r.ticker.padEnd(8)} | Nenhum dado para o ano ${year}`);
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

  console.log(`\n${'─'.repeat(65)}`);
  console.log(`📊 Resumo: ${totalSuccess}/${tickers.length} empresas sincronizadas em ${elapsed}s`);
  console.log(`   Total de registros importados: ${totalRecords}`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Erros encontrados (${errors.length}):`);
    for (const err of errors) {
      console.log(`   - ${err}`);
    }
  }

  if (!dryRun && totalRecords === 0) {
    console.error(
      '\n❌ Nenhum fundamento foi persistido; a sincronização será encerrada como falha.',
    );
  }

  // Encerra conexão com o banco se estiver usando PostgreSQL
  if (!dryRun && repository instanceof PgCompanyRepository) {
    await closeDatabaseConnection();
  }

  process.exit(errors.length > 0 || (!dryRun && totalRecords === 0) ? 1 : 0);
}

function formatCurrency(value: number): string {
  if (value === 0) return 'R$ 0,00';

  const absValue = Math.abs(value);
  let formatted: string;

  if (absValue >= 1_000_000_000) {
    formatted = `R$ ${(value / 1_000_000_000).toFixed(2)}Bi`;
  } else if (absValue >= 1_000_000) {
    formatted = `R$ ${(value / 1_000_000).toFixed(2)}M`;
  } else if (absValue >= 1_000) {
    formatted = `R$ ${(value / 1_000).toFixed(2)}K`;
  } else {
    formatted = `R$ ${value.toFixed(2)}`;
  }

  return formatted;
}

main();
