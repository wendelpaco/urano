/**
 * FiisScraper — Wrapper de compatibilidade.
 *
 * A lógica completa de scraping de FIIs foi movida para StatusInvestScraper
 * (statusinvest-scraper.ts) como parte da unificação da Fase 2.
 *
 * Este arquivo mantém os exports para não quebrar código existente.
 * Ambos os scrapers compartilham o mesmo rate limiter centralizado.
 */

export {
  statusInvestScraper as fiisScraper,
  type FiisData,
  type DividendEntry,
} from './statusinvest-scraper.ts';
