import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { authMiddleware } from '../middleware/auth.ts';
import { requireScopeHandler } from '../middleware/scope-guard.ts';
import { healthcheckController } from '../controllers/healthcheck.controller.ts';
import { openApiController } from '../controllers/docs.controller.ts';
import { rebalanceController } from '../controllers/rebalance.controller.ts';
import { listCompaniesController, listSectorsController, getCompanyByTickerController } from '../controllers/companies.controller.ts';
import { getLatestFundamentalsController, getFundamentalsHistoryController } from '../controllers/fundamentals.controller.ts';
import { getStockQuoteController, getBatchQuotesController, getStockHistoryController, getStockStatsController, getCorporateEventsController, getTechnicalIndicatorsController } from '../controllers/stocks.controller.ts';
import { getDividendsController } from '../controllers/dividends.controller.ts';
import { listFiisController, getFiiByTickerController, getFiiHistoryController, fiiScreenerController, getFiiOperationalController, getFiiCvmController, getFiiTotalReturnController } from '../controllers/fiis.controller.ts';
import { listMacroController, getMacroSeriesController } from '../controllers/macro.controller.ts';
import { createApiKeyController, listApiKeysController, deleteApiKeyController, rotateApiKeyController } from '../controllers/auth.controller.ts';
import { screenerController } from '../controllers/screener.controller.ts';
import {
  getStockAnalysisController,
  getFiiAnalysisController,
  getRankingController,
  getAllocationController,
  compareController,
  getValidationController,
  searchController,
} from '../controllers/analysis.controller.ts';
import { getDataHealthController } from '../controllers/health.controller.ts';
import { scraperDiagnosticsController } from '../controllers/diagnostics.controller.ts';
import { contributionController } from '../controllers/contribution.controller.ts';
import { metricsController } from '../controllers/metrics.controller.ts';
import {
  listBenchmarksController,
  getBenchmarkController,
} from '../controllers/benchmark.controller.ts';
import {
  createWalletController,
  listWalletsController,
  getWalletController,
  updateWalletController,
  deleteWalletController,
  addAssetToWalletController,
  removeAssetFromWalletController,
} from '../controllers/wallets.controller.ts';

const market = { preHandler: requireScopeHandler('read:market') };
const wallet = { preHandler: requireScopeHandler('write:wallet') };
const adminOps = { preHandler: requireScopeHandler('admin:ops') };
// keys routes enforce scopes inside controllers (list partial, create full)

export async function routesPlugin(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.addHook('onRequest', authMiddleware);

  // Public
  app.get('/healthcheck', healthcheckController);

  // OpenAPI — any authenticated key (docs are not secret)
  app.get('/docs/openapi.json', openApiController);

  // Ops — admin:ops only (scraper internals + process metrics)
  app.get('/metrics', { ...adminOps }, metricsController);
  app.get('/health/scraper', { ...adminOps }, scraperDiagnosticsController);
  // Data health is product-facing (contribution warnings) — any market reader
  app.get('/health/data', { ...market }, getDataHealthController);

  // Wallets — write:wallet
  app.post('/wallets', { ...wallet }, createWalletController);
  app.get('/wallets', { ...wallet }, listWalletsController);
  app.get('/wallets/:walletId', { ...wallet }, getWalletController);
  app.put('/wallets/:walletId', { ...wallet }, updateWalletController);
  app.delete('/wallets/:walletId', { ...wallet }, deleteWalletController);
  app.post('/wallets/:walletId/assets', { ...wallet }, addAssetToWalletController);
  app.delete('/wallets/:walletId/assets/:assetId', { ...wallet }, removeAssetFromWalletController);
  app.post('/wallets/:walletId/rebalance', { ...wallet }, rebalanceController);

  // Market data — read:market
  app.get('/companies', { ...market }, listCompaniesController);
  app.get('/companies/sectors', { ...market }, listSectorsController);
  app.get('/companies/:ticker', { ...market }, getCompanyByTickerController);

  app.get('/fundamentals/:ticker', { ...market }, getLatestFundamentalsController);
  app.get('/fundamentals/:ticker/history', { ...market }, getFundamentalsHistoryController);

  app.get('/stocks/:ticker/quote', { ...market }, getStockQuoteController);
  app.get('/stocks/:ticker/history', { ...market }, getStockHistoryController);
  app.get('/stocks/:ticker/stats', { ...market }, getStockStatsController);
  app.get('/stocks/:ticker/corporate-events', { ...market }, getCorporateEventsController);
  app.get('/stocks/:ticker/indicators', { ...market }, getTechnicalIndicatorsController);
  app.get('/stocks/quotes', { ...market }, getBatchQuotesController);

  app.get('/dividends/:ticker', { ...market }, getDividendsController);

  app.get('/fiis', { ...market }, listFiisController);
  app.get('/fiis/screener', { ...market }, fiiScreenerController);
  app.get('/fiis/:ticker', { ...market }, getFiiByTickerController);
  app.get('/fiis/:ticker/history', { ...market }, getFiiHistoryController);
  app.get('/fiis/:ticker/operational', { ...market }, getFiiOperationalController);
  app.get('/fiis/:ticker/cvm', { ...market }, getFiiCvmController);
  app.get('/fiis/:ticker/total-return', { ...market }, getFiiTotalReturnController);

  app.get('/macro', { ...market }, listMacroController);
  app.get('/macro/:series', { ...market }, getMacroSeriesController);

  // Benchmarks free (Yahoo IBOV / IFIX experimental)
  app.get('/benchmarks', { ...market }, listBenchmarksController);
  app.get('/benchmarks/:id', { ...market }, getBenchmarkController);

  app.get('/screener', { ...market }, screenerController);

  app.get('/search', { ...market }, searchController);
  app.get('/analysis/stocks/:ticker', { ...market }, getStockAnalysisController);
  app.get('/analysis/fiis/:ticker', { ...market }, getFiiAnalysisController);
  app.get('/analysis/ranking', { ...market }, getRankingController);
  app.post('/analysis/allocate', { ...market }, getAllocationController);
  app.post('/analysis/compare', { ...market }, compareController);
  app.post('/analysis/contribution', { ...market }, contributionController);
  app.get('/analysis/validation', { ...market }, getValidationController);

  // Keys — scoped inside controllers
  app.post('/keys', createApiKeyController);
  app.get('/keys', listApiKeysController);
  app.post('/keys/:id/rotate', rotateApiKeyController);
  app.delete('/keys/:id', deleteApiKeyController);
}
