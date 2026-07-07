/**
 * Worker de sincronização de dados fundamentalistas da CVM.
 *
 * ATENÇÃO: Este worker depende de uma implementação concreta de ICompanyRepository
 * (ex: PostgreSQL, SQLite) para persistência. Sem ela, os dados são apenas
 * extraídos e exibidos (modo dry-run).
 *
 * Uso:
 *   bun run src/infra/workers/cvm-sync-worker.ts PETR4
 *   bun run src/infra/workers/cvm-sync-worker.ts PETR4 2024
 *
 * Argumentos:
 *   1. ticker  (obrigatório) - Ex: PETR4, VALE3
 *   2. ano     (opcional)    - Ano fiscal. Padrão: ano atual.
 */

import { SyncCompanyFundamentalsUseCase } from '../../core/use-cases/sync-company-fundamentals.ts';
import { CvmStorageService } from '../services/cvm-storage-service.ts';
import type { ICompanyRepository } from '../../core/repositories/company-repository.ts';
import type { CompanyFundamentals } from '../../core/entities/company-fundamentals.ts';

// ---------------------------------------------------------------------------
// Implementação de fallback do repositório (apenas loga, sem persistir).
// Substituir pelo repositório real quando o banco estiver configurado.
// ---------------------------------------------------------------------------

class ConsoleCompanyRepository implements ICompanyRepository {
  private storage = new Map<string, CompanyFundamentals>();

  async upsertFundamentals(
    data: CompanyFundamentals,
  ): Promise<CompanyFundamentals> {
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
        results.push({ referenceDate: f.referenceDate, netIncome: f.netIncome });
      }
    }
    // Ordena por data decrescente e limita
    results.sort(
      (a, b) =>
        new Date(b.referenceDate).getTime() -
        new Date(a.referenceDate).getTime(),
    );
    return results.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('❌ Uso: bun run src/infra/workers/cvm-sync-worker.ts <TICKER> [ANO]');
    console.error('   Exemplo: bun run src/infra/workers/cvm-sync-worker.ts PETR4 2024');
    process.exit(1);
  }

  const ticker = args[0]!.toUpperCase();
  const year = args[1] ? parseInt(args[1], 10) : new Date().getFullYear();

  console.log(`\n🚀 Urano CVM Sync Worker`);
  console.log(`   Ticker: ${ticker}`);
  console.log(`   Ano:    ${year}`);
  console.log(`   Modo:   Dry-run (ConsoleCompanyRepository - dados NÃO são persistidos em banco)\n`);

  const repository = new ConsoleCompanyRepository();
  const useCase = new SyncCompanyFundamentalsUseCase(repository);

  try {
    const startTime = performance.now();

    const result = await useCase.execute({ ticker, year });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    console.log(`\n✅ Sincronização concluída em ${elapsed}s`);
    console.log(`   Registros importados: ${result.recordsImported}`);
    console.log(`   CNPJ: ${result.cnpj}`);
    console.log(`   Empresa: ${result.fundamentals[0]?.companyName ?? 'N/D'}`);

    if (result.ttm) {
      console.log(`   TTM Lucro Líquido: ${formatCurrency(result.ttm.ttmNetIncome)}`);
    }

    // Exibe os registros em formato tabular resumido
    if (result.fundamentals.length > 0) {
      console.log(`\n📊 Demonstrativos extraídos:`);
      console.log(
        `   ${'Data'.padEnd(12)} ${'Lucro Líquido'.padStart(20)} ${'Atrib. Controlador'.padStart(22)} ${'Fonte'.padStart(6)}`,
      );
      console.log(`   ${'-'.repeat(65)}`);

      for (const f of result.fundamentals) {
        const netIncomeFormatted = formatCurrency(f.netIncome);
        const netIncomeParentFormatted = formatCurrency(f.netIncomeAttributableToParent);
        console.log(
          `   ${f.referenceDate.padEnd(12)} ${netIncomeFormatted.padStart(20)} ${netIncomeParentFormatted.padStart(22)} ${f.source.padStart(6)}`,
        );
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Erro na sincronização:');
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
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
