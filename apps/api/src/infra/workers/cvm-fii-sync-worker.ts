#!/usr/bin/env bun
/**
 * Sync CVM FII Informe Mensal → Postgres (fii_cvm_monthly).
 *
 * Uso:
 *   bun run worker:fii-cvm              → ano atual
 *   bun run worker:fii-cvm 2024         → ano específico
 *   bun run worker:fii-cvm 2023 2024    → vários anos
 *
 * Fonte oficial gratuita: dados.cvm.gov.br
 */

import 'dotenv/config';
import { cvmFiiService } from '../services/cvm-fii-service.ts';
import { closeDatabaseConnection } from '../database/connection.ts';

async function main() {
  const args = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
  const years =
    args.length > 0
      ? args.map(Number)
      : [new Date().getFullYear()];

  console.log(`📥 CVM FII sync — anos: ${years.join(', ')}`);

  for (const year of years) {
    try {
      const r = await cvmFiiService.syncYear(year);
      console.log(
        `  ✅ ${year}: upserted=${r.upserted} com ticker amarrado=${r.withTicker}`,
      );
    } catch (e) {
      console.error(
        `  ❌ ${year}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Auto-link CNPJ ↔ tickers conhecidos (nome)
  try {
    const { linkFiiCnpjToTickers } = await import('../services/fii-link-service.ts');
    const link = await linkFiiCnpjToTickers();
    console.log(
      `🔗 link: linked=${link.linked} companies=${link.updatedCompanies}`,
    );
  } catch (e) {
    console.warn('🔗 link skip:', e instanceof Error ? e.message : e);
  }

  await closeDatabaseConnection().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
