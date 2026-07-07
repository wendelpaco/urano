import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { healthcheckController } from '../controllers/healthcheck.controller.ts';
import { rebalanceController } from '../controllers/rebalance.controller.ts';
import { listCompaniesController, listSectorsController, getCompanyByTickerController } from '../controllers/companies.controller.ts';
import { getLatestFundamentalsController, getFundamentalsHistoryController } from '../controllers/fundamentals.controller.ts';
import { getStockQuoteController, getBatchQuotesController, getStockHistoryController } from '../controllers/stocks.controller.ts';
import { getDividendsController } from '../controllers/dividends.controller.ts';
import { listFiisController, getFiiByTickerController, getFiiHistoryController } from '../controllers/fiis.controller.ts';
import { listMacroController, getMacroSeriesController } from '../controllers/macro.controller.ts';
import { createApiKeyController, listApiKeysController, deleteApiKeyController } from '../controllers/auth.controller.ts';
import { screenerController } from '../controllers/screener.controller.ts';
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
  // Healthcheck
  app.get('/healthcheck', healthcheckController);

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
  app.get('/stocks/quotes', getBatchQuotesController);

  // Dividends
  app.get('/dividends/:ticker', getDividendsController);

  // FIIs (Fundos Imobiliários)
  app.get('/fiis', listFiisController);
  app.get('/fiis/:ticker', getFiiByTickerController);
  app.get('/fiis/:ticker/history', getFiiHistoryController);

  // Macro
  app.get('/macro', listMacroController);
  app.get('/macro/:series', getMacroSeriesController);

  // Auth / API Keys
  app.post('/keys', createApiKeyController);
  app.get('/keys', listApiKeysController);
  app.delete('/keys/:id', deleteApiKeyController);

  // Screener
  app.get('/screener', screenerController);
}
