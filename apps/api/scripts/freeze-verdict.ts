#!/usr/bin/env bun
/**
 * Congela o veredito a partir do último run no Postgres.
 *
 *   bun run freeze-verdict           → docs/backtest/LATEST-RUN.json
 *   bun run freeze-verdict --apply   → também atualiza topN em score-validation.data.ts
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabaseConnection } from '../src/infra/database/connection.ts';
import {
  getLatestStrategyYears,
  summarizeStrategyYears,
} from '../src/infra/database/backtest-queries.ts';
import { getLatestFiiBacktestSummary } from '../src/infra/database/fii-backtest-queries.ts';
import { SCORE_VALIDATION } from '../src/core/data/score-validation.data.ts';

const apply = process.argv.includes('--apply');

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
      'Snapshot de runs persistidos. Use --apply para alinhar topN em score-validation.data.ts.',
    suggestedTopN: summary
      ? {
          n: 10,
          avgPortfolio: summary.avgPortfolio ?? SCORE_VALIDATION.topN?.avgPortfolio ?? 0,
          avgMarket: summary.avgUniverse ?? SCORE_VALIDATION.topN?.avgMarket ?? 0,
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

  if (apply && freeze.suggestedTopN) {
    const dataFile = join(
      import.meta.dir,
      '../src/core/data/score-validation.data.ts',
    );
    let src = readFileSync(dataFile, 'utf8');
    const t = freeze.suggestedTopN;
    const today = new Date().toISOString().slice(0, 10);

    // Só o objeto SCORE_VALIDATION (nunca a interface TypeScript)
    const constMarker = 'export const SCORE_VALIDATION';
    const constIdx = src.indexOf(constMarker);
    if (constIdx < 0) {
      console.error('SCORE_VALIDATION const não encontrado — abort --apply');
      process.exit(1);
    }
    const head = src.slice(0, constIdx);
    let body = src.slice(constIdx);

    // topN com números literais (não tipos TypeScript)
    const topNRe =
      /topN:\s*\{\s*n:\s*[\d.]+,\s*avgPortfolio:\s*[\d.]+,\s*avgMarket:\s*[\d.]+,\s*winYears:\s*[\d.]+,\s*totalYears:\s*[\d.]+,\s*\}/;
    if (!topNRe.test(body)) {
      console.error(
        'Bloco topN numérico não encontrado em SCORE_VALIDATION — abort --apply',
      );
      process.exit(1);
    }
    body = body.replace(
      topNRe,
      `topN: {
    n: ${t.n},
    avgPortfolio: ${t.avgPortfolio},
    avgMarket: ${t.avgMarket},
    winYears: ${t.winYears},
    totalYears: ${t.totalYears},
  }`,
    );
    body = body.replace(
      /validatedAt:\s*'[^']*'/,
      `validatedAt: '${today}'`,
    );

    src = head + body;
    writeFileSync(dataFile, src);
    console.log('✅ SCORE_VALIDATION.topN atualizado em score-validation.data.ts');
    console.log(JSON.stringify(t, null, 2));
  } else if (apply) {
    console.warn('--apply sem suggestedTopN (rode backtest ações primeiro)');
  } else {
    console.log(JSON.stringify(freeze.suggestedTopN ?? freeze.fiiBacktest, null, 2));
    console.log('(use --apply para gravar topN no código)');
  }

  await closeDatabaseConnection().catch(() => {});
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
