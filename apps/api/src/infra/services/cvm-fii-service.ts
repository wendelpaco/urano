/**
 * CVM FII — Informe Mensal Estruturado (dados abertos oficiais, gratuitos).
 *
 * Fonte:
 *   https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS/inf_mensal_fii_YYYY.zip
 *
 * Extrai PL, quantidade de cotas e valor patrimonial por cota quando disponíveis
 * no CSV de resumo/geral do ZIP. Dados reais CVM — sem scrape de site comercial.
 */

import JSZip from 'jszip';
import { eq, desc, sql } from 'drizzle-orm';
import { withRetry } from '../../shared/retry.ts';
import { cvmLimiter } from './rate-limiter.ts';
import { cvmCircuitBreaker } from './circuit-breaker.ts';
import { db } from '../database/connection.ts';
import { companies, fiiCvmMonthly } from '../database/schema.ts';

const BASE =
  'https://dados.cvm.gov.br/dados/FII/DOC/INF_MENSAL/DADOS';

export interface FiiCvmRow {
  cnpj: string;
  fundName: string | null;
  referenceDate: string; // YYYY-MM-DD
  netAssets: number | null;
  sharesOutstanding: number | null;
  navPerShare: number | null;
  /** Ticker inferido do ISIN (BRxxxxCTF…) quando presente no CSV geral */
  isinTicker: string | null;
  raw: Record<string, string>;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function parseBrNumber(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '' || raw.trim() === '-') return null;
  // CVM costuma usar vírgula decimal e ponto milhar, ou só ponto
  let t = raw.trim().replace(/\s/g, '');
  if (t.includes(',') && t.includes('.')) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.includes(',')) {
    t = t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const delim = lines[0]!.includes(';') ? ';' : ',';
  const split = (line: string) =>
    line.split(delim).map((c) => c.replace(/^"|"$/g, '').trim());
  const headers = split(lines[0]!).map((h) => h.toUpperCase());
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

function col(headers: string[], row: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = headers.indexOf(name.toUpperCase());
    if (i >= 0 && row[i] != null && row[i] !== '') return row[i];
  }
  // fuzzy: includes
  for (const name of names) {
    const i = headers.findIndex((h) => h.includes(name.toUpperCase()));
    if (i >= 0 && row[i] != null && row[i] !== '') return row[i];
  }
  return undefined;
}

function mapRow(headers: string[], cells: string[]): FiiCvmRow | null {
  const cnpjRaw = col(
    headers,
    cells,
    'CNPJ_FUNDO_CLASSE',
    'CNPJ_FUNDO',
    'CNPJ',
  );
  if (!cnpjRaw) return null;
  const cnpj = digitsOnly(cnpjRaw).padStart(14, '0').slice(0, 14);
  if (cnpj.length !== 14) return null;

  const refRaw = col(
    headers,
    cells,
    'DATA_REFERENCIA',
    'DT_COMPTC',
    'DT_REF',
    'REFERENCIA',
  );
  if (!refRaw) return null;
  // Accept DD/MM/YYYY or YYYY-MM-DD
  let referenceDate = refRaw.slice(0, 10);
  const br = refRaw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) referenceDate = `${br[3]}-${br[2]}-${br[1]}`;

  const fundName =
    col(headers, cells, 'NOME_FUNDO_CLASSE', 'NOME_FUNDO', 'DENOM_SOCIAL') ?? null;

  const netAssets = parseBrNumber(
    col(
      headers,
      cells,
      'PATRIMONIO_LIQUIDO',
      'VL_PATRIM_LIQ',
      'PATR_LIQUIDO',
      'PL',
    ),
  );
  const sharesOutstanding = parseBrNumber(
    col(
      headers,
      cells,
      'COTAS_EMITIDAS',
      'QUANTIDADE_COTAS',
      'QUANTIDADE_COTAS_EMITIDAS',
      'QT_COTAS',
      'NR_COTAS',
      'TOTAL_COTAS',
    ),
  );

  let navPerShare = parseBrNumber(
    col(
      headers,
      cells,
      'VALOR_PATRIMONIAL_COTAS',
      'VALOR_PATRIMONIAL_COTA',
      'VALOR_COTA',
      'VL_COTA',
    ),
  );
  if (
    navPerShare == null &&
    netAssets != null &&
    sharesOutstanding != null &&
    sharesOutstanding > 0
  ) {
    navPerShare = netAssets / sharesOutstanding;
  }

  // ISIN FII B3: BR + 4 chars + CTF + dígito(s) → ticker = root + 11
  const isin = col(headers, cells, 'CODIGO_ISIN', 'ISIN') ?? '';
  const isinMatch = isin.toUpperCase().match(/^BR([A-Z0-9]{4})CTF/);
  const isinTicker = isinMatch ? `${isinMatch[1]}11` : null;

  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    if (cells[i]) raw[h] = cells[i]!;
  });

  return {
    cnpj,
    fundName,
    referenceDate,
    netAssets,
    sharesOutstanding,
    navPerShare,
    isinTicker,
    raw,
  };
}

/** Prefer latin1 (CVM) — fallback utf-8. */
async function zipCsvText(
  zip: JSZip,
  name: string,
): Promise<string> {
  const bytes = await zip.files[name]!.async('uint8array');
  // CVM ships ISO-8859-1 / Windows-1252 (Bun TextDecoder typings only list utf-*)
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function mergeFiiRows(into: FiiCvmRow, from: FiiCvmRow): FiiCvmRow {
  return {
    cnpj: into.cnpj,
    referenceDate: into.referenceDate,
    fundName: into.fundName ?? from.fundName,
    netAssets: into.netAssets ?? from.netAssets,
    sharesOutstanding: into.sharesOutstanding ?? from.sharesOutstanding,
    navPerShare: into.navPerShare ?? from.navPerShare,
    isinTicker: into.isinTicker ?? from.isinTicker,
    raw: { ...from.raw, ...into.raw },
  };
}

export class CvmFiiService {
  private readonly userAgent =
    'Urano-FinBot/0.1 (ETL-CVM-FII; contato@urano.app)';

  /** Download + parse ZIP anual; retorna linhas mapeadas (sem I/O de DB). */
  async fetchYear(year: number): Promise<FiiCvmRow[]> {
    await cvmCircuitBreaker.beforeRequest();
    await cvmLimiter.acquire();

    const url = `${BASE}/inf_mensal_fii_${year}.zip`;
    let response: Response;
    try {
      response = await withRetry(
        async () => {
          const res = await fetch(url, {
            headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
            redirect: 'error',
          });
          if (!res.ok) throw new Error(`CVM FII HTTP ${res.status} ${url}`);
          return res;
        },
        { maxRetries: 2, initialDelay: 1000, maxDelay: 10_000, timeout: 120_000 },
      );
      await cvmCircuitBreaker.onSuccess();
    } catch (e) {
      await cvmCircuitBreaker.onFailure(
        'network-error',
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }

    const buf = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter(
      (n) => n.toLowerCase().endsWith('.csv') && !zip.files[n]!.dir,
    );

    // complemento = PL/NAV mensal; geral = nome + ISIN. Mesclar ambos.
    // Evitar só "complemento" (bug: match regex pegava complemento antes de geral).
    const order = [
      ...names.filter((n) => /complemento/i.test(n)),
      ...names.filter((n) => /geral|resumo/i.test(n)),
      ...names.filter(
        (n) =>
          !/complemento|geral|resumo|ativo|passivo|imovel|imóvel/i.test(n),
      ),
    ];
    // unique preserve order
    const files = [...new Set(order.length > 0 ? order : names)];
    if (files.length === 0) {
      throw new Error(`ZIP CVM FII ${year} sem CSV utilizável`);
    }

    const byKey = new Map<string, FiiCvmRow>();
    for (const file of files) {
      const text = await zipCsvText(zip, file);
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) continue;
      let mappedCount = 0;
      for (const cells of rows) {
        const mapped = mapRow(headers, cells);
        if (!mapped) continue;
        mappedCount += 1;
        const key = `${mapped.cnpj}|${mapped.referenceDate}`;
        const prev = byKey.get(key);
        byKey.set(key, prev ? mergeFiiRows(prev, mapped) : mapped);
      }
      console.log(
        `[cvm-fii] ${year}: +${mappedCount} linhas de ${file} (merge keys=${byKey.size})`,
      );
    }

    const out = [...byKey.values()];
    const withName = out.filter((r) => r.fundName).length;
    const withNav = out.filter((r) => r.navPerShare != null).length;
    console.log(
      `[cvm-fii] ${year}: total ${out.length} (nome=${withName}, nav=${withNav})`,
    );
    return out;
  }

  /** Persiste no Postgres (upsert por cnpj+reference_date) e tenta amarrar ticker. */
  async syncYear(year: number): Promise<{ upserted: number; withTicker: number }> {
    const rows = await this.fetchYear(year);

    // Map CNPJ → ticker for known FIIs in companies (tickers *11)
    const companyRows = await db
      .select({ cnpj: companies.cnpj, ticker: companies.ticker })
      .from(companies)
      .where(sql`${companies.ticker} LIKE '%11'`);
    const cnpjToTicker = new Map(
      companyRows.map((c) => [c.cnpj, c.ticker.toUpperCase()]),
    );
    const knownTickers = new Set(
      companyRows.map((c) => c.ticker.toUpperCase()),
    );

    let upserted = 0;
    let withTicker = 0;
    const chunk = 100;

    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const values = slice.map((r) => {
        // 1) CNPJ já real em companies  2) ISIN → ticker se estiver no seed
        let ticker = cnpjToTicker.get(r.cnpj) ?? null;
        if (
          !ticker &&
          r.isinTicker &&
          knownTickers.has(r.isinTicker.toUpperCase())
        ) {
          ticker = r.isinTicker.toUpperCase();
        }
        if (ticker) withTicker += 1;
        return {
          cnpj: r.cnpj,
          ticker,
          fundName: r.fundName,
          referenceDate: r.referenceDate,
          netAssets: r.netAssets != null ? String(r.netAssets) : null,
          sharesOutstanding:
            r.sharesOutstanding != null ? String(r.sharesOutstanding) : null,
          navPerShare: r.navPerShare != null ? String(r.navPerShare) : null,
          source: 'cvm_inf_mensal',
          raw: r.raw as Record<string, unknown>,
          extractedAt: new Date(),
        };
      });

      try {
        await db
          .insert(fiiCvmMonthly)
          .values(values)
          .onConflictDoUpdate({
            target: [fiiCvmMonthly.cnpj, fiiCvmMonthly.referenceDate],
            set: {
              ticker: sql`excluded.ticker`,
              fundName: sql`excluded.fund_name`,
              netAssets: sql`excluded.net_assets`,
              sharesOutstanding: sql`excluded.shares_outstanding`,
              navPerShare: sql`excluded.nav_per_share`,
              raw: sql`excluded.raw`,
              extractedAt: sql`excluded.extracted_at`,
              source: sql`excluded.source`,
            },
          });
        upserted += values.length;
      } catch (e) {
        // row-by-row fallback
        for (const v of values) {
          try {
            await db.insert(fiiCvmMonthly).values(v).onConflictDoNothing();
            upserted += 1;
          } catch {
            /* skip */
          }
        }
        console.warn(
          '[cvm-fii] batch upsert partial:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    return { upserted, withTicker };
  }

  async getLatestByTicker(ticker: string) {
    const upper = ticker.toUpperCase();
    const [row] = await db
      .select()
      .from(fiiCvmMonthly)
      .where(eq(fiiCvmMonthly.ticker, upper))
      .orderBy(desc(fiiCvmMonthly.referenceDate))
      .limit(1);
    return row ?? null;
  }

  async getHistoryByTicker(ticker: string, limit = 24) {
    return db
      .select()
      .from(fiiCvmMonthly)
      .where(eq(fiiCvmMonthly.ticker, ticker.toUpperCase()))
      .orderBy(desc(fiiCvmMonthly.referenceDate))
      .limit(limit);
  }

  /**
   * Mapa ticker → último NAV/cota (CVM). Uma query para ranking/screener —
   * evita N scrapes síncronos de P/VP.
   */
  async getLatestNavByTickerMap(): Promise<
    Map<string, { navPerShare: number; referenceDate: string }>
  > {
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (ticker)
        ticker,
        nav_per_share,
        reference_date
      FROM fii_cvm_monthly
      WHERE ticker IS NOT NULL
        AND nav_per_share IS NOT NULL
        AND nav_per_share::numeric > 0
      ORDER BY ticker, reference_date DESC
    `);
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: unknown[] }).rows ?? []);
    const map = new Map<string, { navPerShare: number; referenceDate: string }>();
    for (const r of list as Array<Record<string, unknown>>) {
      const ticker = String(r.ticker ?? '').toUpperCase();
      const nav = Number(r.nav_per_share);
      if (!ticker || !Number.isFinite(nav) || nav <= 0) continue;
      map.set(ticker, {
        navPerShare: nav,
        referenceDate: String(r.reference_date ?? '').slice(0, 10),
      });
    }
    return map;
  }
}

export const cvmFiiService = new CvmFiiService();
