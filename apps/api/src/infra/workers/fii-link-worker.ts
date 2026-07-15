#!/usr/bin/env bun
/**
 * Amarrar CNPJ CVM ↔ tickers FII em companies.
 *
 * Pré-requisito: bun run worker:fii-cvm 2024
 * Uso: bun run worker:fii-link
 */

import 'dotenv/config';
import { linkFiiCnpjToTickers } from '../services/fii-link-service.ts';
import { closeDatabaseConnection } from '../database/connection.ts';

async function main() {
  console.log('🔗 Linking FII tickers to CVM CNPJs…');
  const r = await linkFiiCnpjToTickers();
  console.log(
    `✅ linked=${r.linked} companiesUpdated=${r.updatedCompanies} cvmTouched=${r.updatedCvmRows}`,
  );
  await closeDatabaseConnection().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
