/**
 * Lista mestra de tickers B3 — fonte única para seed, sync e scraping.
 *
 * Centraliza todos os tickers conhecidos para evitar duplicação
 * e inconsistências entre seed, CVM sync e daily snapshot.
 */

/** Ações (stocks) — tickers com cobertura de scraping e CVM */
export const ALL_STOCK_TICKERS = [
  // Bancos
  'ITUB4', 'BBDC4', 'BBAS3', 'SANB11', 'BPAC11',
  // Energia
  'ELET3', 'CPLE6', 'EGIE3', 'CMIG4', 'TAEE11', 'ENGI11', 'ENEV3', 'ALUP11', 'EQTL3', 'CPFE3',
  // Mineração / Siderurgia
  'VALE3', 'GGBR4', 'CSNA3', 'USIM5', 'GOAU4', 'CMIN3',
  // Petróleo
  'PETR4', 'PRIO3', 'BRAV3', 'RECV3',
  // Alimentos / Bebidas
  'ABEV3', 'JBSS3', 'BRFS3', 'MDIA3', 'MRFG3', 'BEEF3',
  // Saúde
  'HAPV3', 'RDOR3', 'FLRY3', 'QUAL3', 'DASA3',
  // Varejo
  'MGLU3', 'LREN3', 'NTCO3', 'ASAI3', 'GMAT3', 'BHIA3', 'PETZ3', 'ARZZ3',
  // Indústria
  'WEGE3', 'EMBR3', 'TUPY3', 'MYPK3', 'ROMI3',
  // Transporte
  'RAIL3', 'CCRO3', 'STBP3', 'ECOR3',
  // Papel / Celulose
  'SUZB3', 'KLBN11',
  // Telecom
  'VIVT3', 'TIMS3',
  // Construção / Imob
  'CYRE3', 'MULT3', 'MRVE3', 'EZTC3', 'DIRR3',
  // Tecnologia
  'TOTS3', 'LWSA3',
  // Outros
  'RADL3', 'RENT3', 'SMTO3', 'SLCE3', 'VAMO3',
  // Holdings
  'ITSA4',
  // Saneamento
  'SAPR11',
  // Adicionais (tickers com alta liquidez)
  'BBSE3', 'B3SA3', 'HYPE3', 'IGTI11', 'RAIZ4', 'PSSA3', 'CSAN3',
];

/** FIIs — tickers cobertos pelo scraper */
export const ALL_FII_TICKERS = [
  // Logística
  'HGLG11', 'XPLG11', 'BTLG11', 'VILG11', 'LVBI11', 'GARE11', 'PATL11',
  // Lajes Corporativas
  'KNRI11', 'RCRB11', 'HGRE11', 'BRCR11',
  // Shopping
  'VISC11', 'XPML11', 'MALL11', 'HSML11',
  // Títulos e Valores Mobiliários (papel)
  'KNIP11', 'KNCR11', 'MXRF11', 'VGIR11', 'IRDM11', 'URPR11',
  'CPTS11', 'RECR11', 'DEVA11', 'RBRR11', 'VGIP11',
  // FoF
  'BCFF11', 'KISU11', 'ITIP11',
  // Renda Urbana
  'HGRU11', 'TRXF11',
  // Agro
  'RZTR11', 'SNAG11',
];

/** Todos os tickers (ações + FIIs) */
export const ALL_TICKERS = [...ALL_STOCK_TICKERS, ...ALL_FII_TICKERS];
