import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { authMiddleware } from '../middleware/auth.ts';
import { healthcheckController } from '../controllers/healthcheck.controller.ts';
import { openApiController } from '../controllers/docs.controller.ts';
import { rebalanceController } from '../controllers/rebalance.controller.ts';
import { listCompaniesController, listSectorsController, getCompanyByTickerController } from '../controllers/companies.controller.ts';
import { getLatestFundamentalsController, getFundamentalsHistoryController } from '../controllers/fundamentals.controller.ts';
import { getStockQuoteController, getBatchQuotesController, getStockHistoryController, getStockStatsController, getCorporateEventsController } from '../controllers/stocks.controller.ts';
import { getDividendsController } from '../controllers/dividends.controller.ts';
import { listFiisController, getFiiByTickerController, getFiiHistoryController, fiiScreenerController, getFiiOperationalController } from '../controllers/fiis.controller.ts';
import { listMacroController, getMacroSeriesController } from '../controllers/macro.controller.ts';
import { createApiKeyController, listApiKeysController, deleteApiKeyController, rotateApiKeyController } from '../controllers/auth.controller.ts';
import { screenerController } from '../controllers/screener.controller.ts';
import {
  getStockAnalysisController,
  getFiiAnalysisController,
  getRankingController,
  getAllocationController,
  compareController,
} from '../controllers/analysis.controller.ts';
import { getDataHealthController } from '../controllers/health.controller.ts';
import { contributionController } from '../controllers/contribution.controller.ts';
import {
  createWalletController,
  listWalletsController,
  getWalletController,
  updateWalletController,
  deleteWalletController,
  addAssetToWalletController,
  removeAssetFromWalletController,
} from '../controllers/wallets.controller.ts';

export async function routesPlugin(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // Auth middleware — todas as rotas exceto healthcheck
  app.addHook('onRequest', authMiddleware);

  // Healthcheck + Docs (rotas públicas, sem auth)
  app.get('/healthcheck', healthcheckController);
  app.get('/docs/openapi.json', openApiController);

  // Wallets (CRUD + Rebalance)
  app.post('/wallets', createWalletController);
  app.get('/wallets', listWalletsController);
  app.get('/wallets/:walletId', getWalletController);
  app.put('/wallets/:walletId', updateWalletController);
  app.delete('/wallets/:walletId', deleteWalletController);
  app.post('/wallets/:walletId/assets', addAssetToWalletController);
  app.delete('/wallets/:walletId/assets/:assetId', removeAssetFromWalletController);
  app.post('/wallets/:walletId/rebalance', rebalanceController);

  // Companies
  app.get('/companies', listCompaniesController);
  app.get('/companies/sectors', listSectorsController);
  app.get('/companies/:ticker', getCompanyByTickerController);

  // Fundamentals
  app.get('/fundamentals/:ticker', getLatestFundamentalsController);
  app.get('/fundamentals/:ticker/history', getFundamentalsHistoryController);

  // Stocks
  app.get('/stocks/:ticker/quote', getStockQuoteController);
  app.get('/stocks/:ticker/history', getStockHistoryController);
  app.get('/stocks/:ticker/stats', getStockStatsController);
  app.get('/stocks/:ticker/corporate-events', getCorporateEventsController);
  app.get('/stocks/quotes', getBatchQuotesController);

  // Dividends
  app.get('/dividends/:ticker', getDividendsController);

  // FIIs (Fundos Imobiliários)
  app.get('/fiis', listFiisController);
  // IMPORTANTE: /fiis/screener antes de /fiis/:ticker para não capturar "screener" como ticker
  app.get('/fiis/screener', fiiScreenerController);
  app.get('/fiis/:ticker', getFiiByTickerController);
  app.get('/fiis/:ticker/history', getFiiHistoryController);
  app.get('/fiis/:ticker/operational', getFiiOperationalController);

  // Macro
  app.get('/macro', listMacroController);
  app.get('/macro/:series', getMacroSeriesController);

  // Auth / API Keys
  app.post('/keys', createApiKeyController);
  app.get('/keys', listApiKeysController);
  app.post('/keys/:id/rotate', rotateApiKeyController);
  app.delete('/keys/:id', deleteApiKeyController);

  // Screener
  app.get('/screener', screenerController);

  // Analysis (Onda 2c)
  app.get('/analysis/stocks/:ticker', getStockAnalysisController);
  app.get('/analysis/fiis/:ticker', getFiiAnalysisController);
  app.get('/analysis/ranking', getRankingController);
  app.post('/analysis/allocate', getAllocationController);
  app.post('/analysis/compare', compareController);
  app.post('/analysis/contribution', contributionController);

  // Data health
  app.get('/health/data', getDataHealthController);
}
