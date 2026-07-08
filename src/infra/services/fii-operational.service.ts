/**
 * FII Operational Data Service — Dados operacionais complementares de FIIs.
 *
 * Enriquece os dados de mercado (P/VP, DY, cotação) com métricas operacionais
 * extraídas da página de detalhe do StatusInvest:
 * - Composição de ativos (% em imóveis, CRI, etc.)
 * - Vacância e inadimplência ponderadas
 * - Principais imóveis (nome, área, endereço)
 * - Concentração por setor de inquilinos
 * - Administrador, CNPJ, data de início, mandato
 *
 * Design: função pura que recebe HTML ou usa scraper interno.
 * Fallback: retorna campos nulos quando dados indisponíveis.
 */

import * as cheerio from 'cheerio';
import { withRetry } from '../../shared/retry.ts';
import { fiisScraper, type FiisData } from './fiis-scraper.ts';
import { redis } from './redis.ts';
import { stockQuoteService } from './stock-quote-service.ts';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface FiiOperationalData {
  ticker: string;
  name: string;
  /** Fontes dos dados */
  source: {
    market: boolean;       // cotação + P/VP + DY
    operational: boolean;   // composição, vacância, imóveis
    tenants: boolean;       // concentração de inquilinos
  };

  // ── Mercado (do FiisScraper + Yahoo) ──
  price: number | null;
  dy12m: number | null;
  pvp: number | null;
  bookValue: number | null;         // valor patrimonial por cota
  liquidity: number | null;         // volume financeiro diário
  numShareholders: number | null;

  // ── Operacionais (da página HTML) ──
  /** Composição percentual do portfólio */
  assetComposition: {
    realEstateLeasedPct: number | null;      // % imóveis para renda (acabados)
    realEstateUnderConstructionPct: number | null; // % imóveis em construção
    realEstateForSalePct: number | null;     // % imóveis para venda
    otherRealEstatePct: number | null;        // % outros imóveis
    criPct: number | null;                   // % CRI
    debenturesPct: number | null;            // % debêntures
    fiiHoldingsPct: number | null;           // % cotas de outros FIIs
    fixedIncomePct: number | null;            // % renda fixa
    cashPct: number | null;                  // % caixa
  } | null;

  /** Indicadores operacionais */
  vacancyPct: number | null;          // % vacância (ponderada por receita)
  delinquencyPct: number | null;      // % inadimplência (ponderada por receita)
  propertyCount: number | null;       // número total de imóveis
  totalAreaSqm: number | null;        // área total em m²

  /** Principais imóveis (até 5) */
  topProperties: Array<{
    name: string;
    address: string;
    areaSqm: number | null;
    type: string;
  }>;

  /** Concentração de inquilinos por setor */
  tenantSectors: Array<{
    sector: string;
    pct: number;  // % da receita
  }>;

  // ── Administrativos ──
  administrator: string | null;
  administratorCnpj: string | null;
  inceptionDate: string | null;      // data de início do fundo
  durationType: string | null;       // Indeterminado / Determinado
  managementType: string | null;     // Ativa / Passiva
  mandate: string | null;            // Renda / Ganho de Capital / Híbrido
  category: string | null;           // tijolo / papel / híbrido / fundo_de_fundos

  /** Classes de cotas (se houver) */
  targetInvestors: string | null;    // público-alvo
  website: string | null;

  /** Data de referência dos dados operacionais */
  referenceDate: string | null;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number; private lastRefill: number; private refillRate: number;
  constructor(rate: number) {
    this.tokens = rate; this.lastRefill = Date.now(); this.refillRate = rate / 1000;
  }
  async acquire(): Promise<void> {
    const now = Date.now();
    this.tokens = Math.min(2, this.tokens + (now - this.lastRefill) * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens -= 1; return; }
    await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) / this.refillRate)));
    this.tokens = 0; this.lastRefill = Date.now();
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class FiiOperationalService {
  private readonly baseUrl = 'https://statusinvest.com.br';
  private readonly rateLimiter = new TokenBucket(1.5);

  /**
   * Busca todos os dados operacionais de um FII.
   * Cache Redis 1h para dados operacionais (mudam mensalmente).
   */
  async fetchOperationalData(ticker: string): Promise<FiiOperationalData> {
    const t = ticker.toUpperCase();
    const cacheKey = `fii:operational:${t}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* ok */ }

    // 1. Dados de mercado (scraper existente + Yahoo)
    let marketData: FiisData | null = null;
    let quotePrice: number | null = null;
    let quoteVolume: number | null = null;

    try {
      marketData = await fiisScraper.fetchFII(t);
    } catch { /* ok */ }

    try {
      const quote = await stockQuoteService.getQuote(t);
      quotePrice = quote.price;
      quoteVolume = quote.volume;
    } catch { /* ok */ }

    // 2. Dados operacionais (HTML parse)
    let operationalData = null;
    try {
      operationalData = await this.scrapeOperationalSection(t);
    } catch { /* ok */ }

    // 3. Dados de inquilinos
    let tenantData = null;
    try {
      tenantData = await this.scrapeTenantsSection(t);
    } catch { /* ok */ }

    const result: FiiOperationalData = {
      ticker: t,
      name: marketData?.name ?? t,
      source: {
        market: marketData !== null || quotePrice !== null,
        operational: operationalData !== null,
        tenants: tenantData !== null && tenantData.length > 0,
      },

      // Mercado
      price: quotePrice ?? marketData?.price ?? null,
      dy12m: marketData?.dy12m ?? null,
      pvp: marketData?.pvp ?? null,
      bookValue: marketData?.bookValue ?? null,
      liquidity: quoteVolume && quotePrice ? quoteVolume * quotePrice : null,
      numShareholders: marketData?.numShareholders ?? null,

      // Operacionais (do HTML)
      assetComposition: operationalData?.assetComposition ?? null,
      vacancyPct: operationalData?.vacancyPct ?? null,
      delinquencyPct: operationalData?.delinquencyPct ?? null,
      propertyCount: operationalData?.propertyCount ?? null,
      totalAreaSqm: operationalData?.totalAreaSqm ?? null,
      topProperties: operationalData?.topProperties ?? [],
      tenantSectors: tenantData ?? [],

      // Administrativos (do HTML)
      administrator: operationalData?.administrator ?? null,
      administratorCnpj: operationalData?.administratorCnpj ?? null,
      inceptionDate: operationalData?.inceptionDate ?? null,
      durationType: operationalData?.durationType ?? null,
      managementType: operationalData?.managementType ?? null,
      mandate: operationalData?.mandate ?? null,
      category: marketData?.category ?? operationalData?.category ?? null,
      targetInvestors: operationalData?.targetInvestors ?? null,
      website: operationalData?.website ?? null,

      referenceDate: operationalData?.referenceDate ?? null,
    };

    // Cache 1h
    try { await redis.setex(cacheKey, 3600, JSON.stringify(result)); } catch { /* ok */ }

    return result;
  }

  // ─── Extração do HTML ──────────────────────────────────────────────────────

  private async scrapeOperationalSection(ticker: string) {
    const url = `${this.baseUrl}/fundos-imobiliarios/${ticker.toLowerCase()}`;

    await this.rateLimiter.acquire();
    const html = await withRetry(async () => {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 15_000 });

    const $ = cheerio.load(html);

    // -- Composição de ativos (tabela com barras de progresso) --
    const assetComposition = this.parseAssetComposition($);

    // -- Indicadores operacionais (vacância, inadimplência) --
    const indicators = this.parseOperationalIndicators($);

    // -- Principais imóveis --
    const topProperties = this.parseTopProperties($);

    // -- Dados administrativos (tabela de informações do fundo) --
    const admin = this.parseAdminInfo($, ticker);

    return {
      assetComposition,
      vacancyPct: indicators.vacancyPct,
      delinquencyPct: indicators.delinquencyPct,
      propertyCount: indicators.propertyCount,
      totalAreaSqm: indicators.totalAreaSqm,
      topProperties,
      administrator: admin.administrator,
      administratorCnpj: admin.administratorCnpj,
      inceptionDate: admin.inceptionDate,
      durationType: admin.durationType,
      managementType: admin.managementType,
      mandate: admin.mandate,
      category: admin.category,
      targetInvestors: admin.targetInvestors,
      website: admin.website,
      referenceDate: admin.referenceDate,
    };
  }

  /** Faz parse da composição de ativos (barras percentuais) */
  private parseAssetComposition($: cheerio.CheerioAPI): FiiOperationalData['assetComposition'] {
    const comp: NonNullable<FiiOperationalData['assetComposition']> = {
      realEstateLeasedPct: null, realEstateUnderConstructionPct: null,
      realEstateForSalePct: null, otherRealEstatePct: null,
      criPct: null, debenturesPct: null, fiiHoldingsPct: null,
      fixedIncomePct: null, cashPct: null,
    };

    let found = false;

    // Busca cards com indicadores de composição
    // Padrão comum: label + valor percentual
    $('div.indicator, div.card, div[class*="info"], div[class*="item"]').each((_, el) => {
      const text = $(el).text().toLowerCase();

      const match = (label: string): number | null => {
        if (!text.includes(label)) return null;
        // Extrai percentual: padrão "XX,X%" ou "XX.X%"
        const m = $(el).text().match(/(\d+[,.]?\d*)\s*%/);
        if (m) {
          found = true;
          return parseFloat(m[1]!.replace(',', '.'));
        }
        return null;
      };

      const imoveisParaRenda = match('imóveis para renda') ?? match('imóveis acabados');
      if (imoveisParaRenda !== null) comp.realEstateLeasedPct = imoveisParaRenda;

      const emConstrucao = match('em construção') ?? match('imóveis em construção');
      if (emConstrucao !== null) comp.realEstateUnderConstructionPct = emConstrucao;

      const paraVenda = match('para venda');
      if (paraVenda !== null) comp.realEstateForSalePct = paraVenda;

      const cri = match('cri');
      if (cri !== null) comp.criPct = cri;

      const debentures = match('debênture');
      if (debentures !== null) comp.debenturesPct = debentures;

      const fii = match('cotas de fii') ?? match('fundo de fundos');
      if (fii !== null) comp.fiiHoldingsPct = fii;

      const rendaFixa = match('renda fixa') ?? match('tesouro');
      if (rendaFixa !== null) comp.fixedIncomePct = rendaFixa;

      const caixa = match('caixa');
      if (caixa !== null) comp.cashPct = caixa;
    });

    return found || Object.values(comp).some(v => v !== null) ? comp : null;
  }

  /** Faz parse de indicadores operacionais (vacância, inadimplência, nº imóveis, área) */
  private parseOperationalIndicators($: cheerio.CheerioAPI) {
    let vacancyPct: number | null = null;
    let delinquencyPct: number | null = null;
    let propertyCount: number | null = null;
    let totalAreaSqm: number | null = null;

    // Busca cards com rótulos conhecidos
    $('div.indicator, div[class*="info-item"], div[class*="card"], h3.title').each((_, el) => {
      const container = $(el).closest('div');
      const label = $(el).text().toLowerCase().trim();
      const valueText = container.find('strong.value, .value, span.value').first().text().trim();

      const extractPct = (): number | null => {
        const m = valueText.match(/(\d+[,.]?\d*)\s*%/);
        return m ? parseFloat(m[1]!.replace(',', '.')) : null;
      };

      const extractNum = (): number | null => {
        const clean = valueText.replace(/\./g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
        const n = parseFloat(clean);
        return isNaN(n) ? null : n;
      };

      if (label.includes('vacância')) vacancyPct = extractPct();
      if (label.includes('inadimplência')) delinquencyPct = extractPct();
      if (label.includes('imóveis') || label.includes('imoveis')) propertyCount = extractNum();
      if (label.includes('área') || label.includes('area') || label.includes('m²')) {
        const raw = valueText.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
        const n = parseFloat(raw);
        if (!isNaN(n)) totalAreaSqm = n;
      }
    });

    return { vacancyPct, delinquencyPct, propertyCount, totalAreaSqm };
  }

  /** Faz parse dos principais imóveis (tabela ou cards) */
  private parseTopProperties($: cheerio.CheerioAPI): Array<{
    name: string; address: string; areaSqm: number | null; type: string;
  }> {
    const properties: Array<{ name: string; address: string; areaSqm: number | null; type: string }> = [];

    // Busca linhas de tabela de imóveis
    $('table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const name = $(cells[0]).text().trim();
      if (!name || name.length < 3) return;

      const address = $(cells[1]).text().trim();
      const areaText = cells.length >= 3 ? $(cells[2]).text().trim() : '';
      const type = cells.length >= 4 ? $(cells[3]).text().trim() : '';

      let areaSqm: number | null = null;
      const areaMatch = areaText.replace(/\./g, '').replace(',', '.').match(/(\d+\.?\d*)/);
      if (areaMatch) {
        const n = parseFloat(areaMatch[1]!);
        if (!isNaN(n)) areaSqm = n;
      }

      properties.push({ name, address: address || '', areaSqm, type: type || 'Imóvel para renda' });
    });

    // Se não encontrou tabela, busca em cards/listas
    if (properties.length === 0) {
      $('[class*="property"], [class*="imovel"], [class*="imóvel"]').each((_, el) => {
        const name = $(el).find('h4, h5, strong, [class*="name"]').first().text().trim();
        const address = $(el).find('[class*="address"], [class*="endereco"], [class*="endereço"]').first().text().trim();
        if (name) {
          properties.push({ name, address: address || '', areaSqm: null, type: 'Imóvel' });
        }
      });
    }

    return properties.slice(0, 5); // top 5
  }

  /** Faz parse dos dados administrativos do fundo */
  private parseAdminInfo($: cheerio.CheerioAPI, ticker: string) {
    let administrator: string | null = null;
    let administratorCnpj: string | null = null;
    let inceptionDate: string | null = null;
    let durationType: string | null = null;
    let managementType: string | null = null;
    let mandate: string | null = null;
    let category: string | null = null;
    let targetInvestors: string | null = null;
    let website: string | null = null;
    let referenceDate: string | null = null;

    // Busca em blocos de informações
    $('div.info, div[class*="info"], div[class*="details"], div[class*="dados"]').each((_, el) => {
      const text = $(el).text();
      const html = $(el).html() || '';

      // Tenta extrair pares label: valor
      const lines = html.split(/<br\s*\/?>/i);
      for (const line of lines) {
        const clean = cheerio.load(`<div>${line}</div>`)('div').text().trim();
        const [label, ...rest] = clean.split(':');
        if (!label || rest.length === 0) continue;

        const value = rest.join(':').trim();
        const l = label.toLowerCase().trim();

        if (l.includes('administrador') && !l.includes('cnpj')) administrator = value || null;
        if (l.includes('cnpj') && (l.includes('admin') || l.includes('cnpj'))) administratorCnpj = value || null;
        if (l.includes('início') || l.includes('inicio') || l.includes('constituição')) inceptionDate = value || null;
        if (l.includes('prazo') || l.includes('duração') || l.includes('duraçao')) durationType = value || null;
        if (l.includes('gestão') || l.includes('gestao')) managementType = value || null;
        if (l.includes('mandato')) mandate = value || null;
        if (l.includes('público') || l.includes('publico') || l.includes('investidor')) targetInvestors = value || null;
        if (l.includes('site') || l.includes('website')) website = value || null;
        if (l.includes('referência') || l.includes('referencia') || l.includes('data base')) referenceDate = value || null;
      }
    });

    // Fallback para tabelas
    if (!administrator) {
      $('table tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const label = $(cells[0]).text().toLowerCase().trim();
          const value = $(cells[1]).text().trim();
          if (label.includes('administrador') && !label.includes('cnpj')) administrator = value;
          if (label.includes('cnpj') && label.includes('admin')) administratorCnpj = value;
        }
      });
    }

    // Classificação derivada do nome ou segmento
    category = this.deriveCategory($, ticker);

    return {
      administrator, administratorCnpj, inceptionDate, durationType,
      managementType, mandate, category, targetInvestors, website, referenceDate,
    };
  }

  /** Deriva a classificação (tijolo/papel/híbrido) do nome e segmento */
  private deriveCategory($: cheerio.CheerioAPI, ticker: string): string | null {
    const fullText = $('body').text().toLowerCase();

    // Busca classificação explícita
    if (fullText.includes('fundo de fundos')) return 'fundo_de_fundos';
    if (fullText.includes('híbrido')) return 'hibrido';

    // Heurística por nome
    const n = fullText;
    const isTijolo = n.includes('logística') || n.includes('shopping') ||
      n.includes('laje') || n.includes('corporativ') || n.includes('industrial') ||
      n.includes('galpão') || n.includes('galpao') || n.includes('agro');
    const isPapel = n.includes('cri') || n.includes('crédito') || n.includes('credito') ||
      n.includes('recebíveis') || n.includes('recebiveis') || n.includes('papel');

    if (isTijolo && !isPapel) return 'tijolo';
    if (isPapel && !isTijolo) return 'papel';
    if (isTijolo && isPapel) return 'hibrido';

    return 'tijolo'; // fallback
  }

  // ─── Inquilinos ────────────────────────────────────────────────────────────

  private async scrapeTenantsSection(ticker: string): Promise<
    Array<{ sector: string; pct: number }>
  > {
    const url = `${this.baseUrl}/fundos-imobiliarios/${ticker.toLowerCase()}`;

    await this.rateLimiter.acquire();
    const html = await withRetry(async () => {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }, { maxRetries: 1, initialDelay: 500, maxDelay: 2000, timeout: 15_000 });

    const $ = cheerio.load(html);
    const tenants: Array<{ sector: string; pct: number }> = [];

    // Busca seção de inquilinos (tabela ou gráfico)
    // Padrão: tabelas com colunas de setor e percentual
    $('table').each((_, table) => {
      const tableText = $(table).text().toLowerCase();
      // Só processa tabelas que contenham palavras-chave de inquilinos
      if (!tableText.includes('inquilino') && !tableText.includes('setor') && !tableText.includes('locatário')) return;
      if (!tableText.includes('%')) return;

      $(table).find('tbody tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;

        const sector = $(cells[0]).text().trim();
        const pctText = $(cells[cells.length - 1]).text().trim();
        const pctMatch = pctText.match(/(\d+[,.]?\d*)\s*%/);

        if (sector && pctMatch) {
          const pct = parseFloat(pctMatch[1]!.replace(',', '.'));
          if (!isNaN(pct) && pct > 0 && pct <= 100) {
            // Evita duplicatas
            if (!tenants.some(t => t.sector.toLowerCase() === sector.toLowerCase())) {
              tenants.push({ sector, pct });
            }
          }
        }
      });
    });

    return tenants.sort((a, b) => b.pct - a.pct);
  }
}

export const fiiOperationalService = new FiiOperationalService();
