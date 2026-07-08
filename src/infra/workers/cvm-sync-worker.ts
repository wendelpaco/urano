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
 */

import 'dotenv/config';
import { SyncCompanyFundamentalsUseCase } from '../../core/use-cases/sync-company-fundamentals.ts';
import { PgCompanyRepository } from '../database/pg-company-repository.ts';
import { checkDatabaseConnection, closeDatabaseConnection } from '../database/connection.ts';
import type { ICompanyRepository } from '../../core/repositories/company-repository.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';

// ---------------------------------------------------------------------------
// Implementação de fallback do repositório (apenas loga, sem persistir).
// Usada no modo --dry-run ou quando o banco está indisponível.
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
// ---------------------------------------------------------------------------
const ALL_TICKERS = [
  // Bancos
  'ITUB4', 'BBDC4', 'BBAS3', 'SANB11', 'BPAC11',
  // Energia
  'ELET3', 'CPLE6', 'EGIE3', 'CMIG4', 'TAEE11', 'ENGI11', 'ENEV3', 'ALUP11', 'EQTL3', 'CPFE3',
  // Mineração / Siderurgia
  'VALE3', 'GGBR4', 'CSNA3', 'USIM5', 'GOAU4', 'CMIN3',
  // Petróleo
  'PETR4', 'PRIO3', 'BRAV3', 'RECV3',
  // Alimentos / Bebidas
  'ABEV3', 'JBSS3', 'BRFS3', 'MDIA3', 'MRFG3', 'BEEF3',
  // Saúde
  'HAPV3', 'RDOR3', 'FLRY3', 'QUAL3', 'DASA3',
  // Varejo
  'MGLU3', 'LREN3', 'NTCO3', 'ASAI3', 'GMAT3', 'BHIA3', 'PETZ3', 'ARZZ3',
  // Indústria
  'WEGE3', 'EMBR3', 'TUPY3', 'MYPK3', 'ROMI3',
  // Transporte
  'RAIL3', 'CCRO3', 'STBP3', 'ECOR3',
  // Papel / Celulose
  'SUZB3', 'KLBN11',
  // Telecom
  'VIVT3', 'TIMS3',
  // Construção / Imob
  'CYRE3', 'MULT3', 'MRVE3', 'EZTC3', 'DIRR3',
  // Tecnologia
  'TOTS3', 'LWSA3',
  // Outros
  'RADL3', 'RENT3', 'SMTO3', 'SLCE3', 'VAMO3',
];

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

interface CliArgs {
  tickers: string[];
  year: number;
  dryRun: boolean;
  allMode: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allMode = args.includes('--all');

  // Filtra flags para extrair tickers e ano
  const positional = args.filter((a) => !a.startsWith('--'));

  if (allMode) {
    const year = positional[0] ? parseInt(positional[0], 10) : new Date().getFullYear();
    return { tickers: ALL_TICKERS, year, dryRun, allMode: true };
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

  return { tickers, year, dryRun, allMode: false };
}

async function main(): Promise<void> {
  const { tickers, year, dryRun, allMode } = parseArgs();

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
        '⚠️  Banco de dados indisponível. Usando fallback dry-run.\n' +
          '   Execute "docker compose up -d" para iniciar PostgreSQL e Redis.\n',
      );
      repository = new ConsoleCompanyRepository();
      modeLabel = 'Dry-run (banco indisponível)';
    }
  }

  console.log(`\n🚀 Urano CVM Sync Worker`);
  console.log(`   Tickers: ${allMode ? 'TODOS (' + tickers.length + ')' : tickers.join(', ')}`);
  console.log(`   Ano:     ${year}`);
  console.log(`   Modo:    ${modeLabel}\n`);

  const useCase = new SyncCompanyFundamentalsUseCase(repository);
  const startTime = performance.now();

  // Processamento em batch: ZIP baixado 1×, CSVs parseados 1×, todos os tickers de uma vez
  const results = await useCase.executeBatch(tickers, year);

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

  // Encerra conexão com o banco se estiver usando PostgreSQL
  if (!dryRun && repository instanceof PgCompanyRepository) {
    await closeDatabaseConnection();
  }

  process.exit(errors.length > 0 ? 1 : 0);
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
