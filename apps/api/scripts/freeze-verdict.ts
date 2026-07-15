#!/usr/bin/env bun
/**
 * Congela o veredito a partir do último run persistido no Postgres.
 * Escreve docs/backtest/LATEST-RUN.json (repo root relativo a apps/api → ../../docs)
 * e imprime o bloco a copiar para SCORE_VALIDATION se desejado.
 *
 * Não sobrescreve score-validation.data.ts automaticamente (evita commit cego).
 *
 * Uso: bun run scripts/freeze-verdict.ts
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabaseConnection } from '../src/infra/database/connection.ts';
import {
  getLatestStrategyYears,
  summarizeStrategyYears,
} from '../src/infra/database/backtest-queries.ts';
import { getLatestFiiBacktestSummary } from '../src/infra/database/fii-backtest-queries.ts';
import { SCORE_VALIDATION } from '../src/core/data/score-validation.data.ts';

async function main() {
  const strategy = await getLatestStrategyYears(10);
  const fii = await getLatestFiiBacktestSummary();

  if (!strategy && !fii) {
    console.error(
      'Nenhum run em backtest_strategy_years nem fii_backtest_years. Rode: bun run backtest && bun run backtest:fii',
    );
    process.exit(1);
  }

  const summary = strategy ? summarizeStrategyYears(strategy.years) : null;

  const freeze = {
    frozenAt: new Date().toISOString(),
    scoreVersion: SCORE_VALIDATION.scoreVersion,
    staticVerdict: SCORE_VALIDATION.verdict,
    stockStrategy: strategy
      ? {
          runId: strategy.runId,
          scoreVersion: strategy.scoreVersion,
          n: 10,
          ...summary,
        }
      : null,
    fiiBacktest: fii,
    note:
      'Snapshot de runs persistidos. Atualize SCORE_VALIDATION.topN manualmente se quiser alinhar o JSON estático ao run.',
    suggestedTopN: summary
      ? {
          n: 10,
          avgPortfolio: summary.avgPortfolio,
          avgMarket: summary.avgUniverse,
          winYears: summary.winYearsVsUniverse,
          totalYears: summary.totalYears,
          avgIbov: summary.avgIbov,
          winYearsVsIbov: summary.winYearsVsIbov,
        }
      : null,
  };

  const outDir = join(import.meta.dir, '../../../docs/backtest');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'LATEST-RUN.json');
  writeFileSync(outFile, JSON.stringify(freeze, null, 2) + '\n');

  console.log('✅ Freeze escrito em', outFile);
  console.log(JSON.stringify(freeze.suggestedTopN ?? freeze.fiiBacktest, null, 2));

  await closeDatabaseConnection().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
