/**
 * Amarrar CNPJ CVM (fii_cvm_monthly) ↔ ticker em companies.
 * Seed usa CNPJ sintético FII… — este job substitui por CNPJ real.
 *
 * Prioridade:
 *  1) fii_cvm_monthly.ticker já preenchido (ISIN no sync)
 *  2) match fuzzy de nome (fund_name) com score alto e CNPJ único
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../database/connection.ts';
import { companies, fiiCvmMonthly } from '../database/schema.ts';

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bfii\b/g, ' ')
    .replace(/\bfundo\b/g, ' ')
    .replace(/\binvestimento\b/g, ' ')
    .replace(/\bimobiliario\b/g, ' ')
    .replace(/\bresp\b/g, ' ')
    .replace(/\bltda\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreNames(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 80;
  const ta = new Set(na.split(' ').filter((t) => t.length > 2));
  const tb = new Set(nb.split(' ').filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return Math.round((2 * inter * 100) / (ta.size + tb.size));
}

function isSyntheticCnpj(cnpj: string): boolean {
  return cnpj.startsWith('FII') || !/^\d{14}$/.test(cnpj);
}

/**
 * Troca CNPJ sintético → real no PK de companies.
 * FK company_fundamentals tem onUpdate cascade.
 */
async function replaceCompanyCnpj(
  oldCnpj: string,
  newCnpj: string,
  ticker: string,
  name: string,
  sector: string | null,
): Promise<boolean> {
  if (oldCnpj === newCnpj) return true;

  // Já existe row com o CNPJ real?
  const [existingReal] = await db
    .select({ cnpj: companies.cnpj, ticker: companies.ticker })
    .from(companies)
    .where(eq(companies.cnpj, newCnpj))
    .limit(1);

  if (existingReal) {
    if (existingReal.ticker === ticker) {
      // só remove sintético se sobrou
      if (oldCnpj !== newCnpj && isSyntheticCnpj(oldCnpj)) {
        await db.delete(companies).where(eq(companies.cnpj, oldCnpj));
      }
      return true;
    }
    // CNPJ real já é de outro ticker — não roubar
    console.warn(
      `[fii-link] ${ticker}: CNPJ ${newCnpj} já é de ${existingReal.ticker}`,
    );
    return false;
  }

  // UPDATE PK in-place (cascade FKs)
  try {
    await db.execute(sql`
      UPDATE companies
      SET cnpj = ${newCnpj},
          name = ${name},
          sector = ${sector},
          updated_at = NOW()
      WHERE cnpj = ${oldCnpj}
    `);
    return true;
  } catch (e) {
    console.warn(
      `[fii-link] UPDATE cnpj ${ticker}:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

export async function linkFiiCnpjToTickers(minScore = 70): Promise<{
  linked: number;
  updatedCompanies: number;
  updatedCvmRows: number;
}> {
  const fiiCompanies = await db
    .select({
      cnpj: companies.cnpj,
      ticker: companies.ticker,
      name: companies.name,
      sector: companies.sector,
    })
    .from(companies)
    .where(sql`${companies.ticker} LIKE '%11'`);

  // CNPJ já amarrado via ISIN no sync
  const isinLinked = await db.execute(sql`
    SELECT DISTINCT ON (ticker) ticker, cnpj
    FROM fii_cvm_monthly
    WHERE ticker IS NOT NULL AND ticker <> ''
    ORDER BY ticker, reference_date DESC
  `);
  const isinList = (
    Array.isArray(isinLinked)
      ? isinLinked
      : ((isinLinked as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ ticker: string; cnpj: string }>;
  const tickerToCnpjFromIsin = new Map(
    isinList.map((r) => [String(r.ticker).toUpperCase(), String(r.cnpj)]),
  );

  const cvmFundsRaw = await db.execute(sql`
    SELECT DISTINCT ON (cnpj) cnpj, fund_name
    FROM fii_cvm_monthly
    WHERE fund_name IS NOT NULL AND fund_name <> ''
    ORDER BY cnpj, reference_date DESC
  `);
  type CvmRow = { cnpj: string; fund_name: string };
  const fundList: CvmRow[] = (
    Array.isArray(cvmFundsRaw)
      ? (cvmFundsRaw as unknown as CvmRow[])
      : (((cvmFundsRaw as { rows?: CvmRow[] }).rows ?? []) as CvmRow[])
  ).filter((f) => f && typeof f.cnpj === 'string');

  if (fundList.length === 0 && tickerToCnpjFromIsin.size === 0) {
    console.warn(
      '[fii-link] Sem fund_name nem ticker ISIN em fii_cvm_monthly — rode worker:fii-cvm.',
    );
  }

  const claimedCnpjs = new Set<string>();
  // CNPJs já reais nas companies
  for (const c of fiiCompanies) {
    if (!isSyntheticCnpj(c.cnpj)) claimedCnpjs.add(c.cnpj);
  }

  let linked = 0;
  let updatedCompanies = 0;
  let updatedCvmRows = 0;

  for (const company of fiiCompanies) {
    const ticker = company.ticker.toUpperCase();
    let bestCnpj: string | null =
      tickerToCnpjFromIsin.get(ticker) ?? null;
    let bestScore = bestCnpj ? 100 : 0;
    let source: 'isin' | 'name' | null = bestCnpj ? 'isin' : null;

    if (!bestCnpj) {
      let best: { cnpj: string; score: number } | null = null;
      for (const f of fundList) {
        if (claimedCnpjs.has(f.cnpj)) continue;
        const sc = scoreNames(company.name, f.fund_name ?? '');
        if (sc >= minScore && (!best || sc > best.score)) {
          best = { cnpj: f.cnpj, score: sc };
        }
      }
      // Exigir margem vs 2º lugar para evitar colisão "logística"
      if (best) {
        const seconds = fundList
          .filter((f) => f.cnpj !== best!.cnpj && !claimedCnpjs.has(f.cnpj))
          .map((f) => scoreNames(company.name, f.fund_name ?? ''))
          .sort((a, b) => b - a);
        const second = seconds[0] ?? 0;
        if (best.score - second < 8 && best.score < 95) {
          console.warn(
            `[fii-link] ${ticker}: match ambíguo score=${best.score} vs ${second} — skip`,
          );
          best = null;
        }
      }
      if (best) {
        bestCnpj = best.cnpj;
        bestScore = best.score;
        source = 'name';
      }
    }

    if (!bestCnpj) continue;
    if (claimedCnpjs.has(bestCnpj) && company.cnpj !== bestCnpj) {
      // Outro ticker já pegou (ISIN race) — se for o mesmo via isin ok
      const owner = fiiCompanies.find((c) => c.cnpj === bestCnpj);
      if (owner && owner.ticker !== company.ticker) {
        console.warn(
          `[fii-link] ${ticker}: CNPJ ${bestCnpj} claimed by ${owner.ticker}`,
        );
        continue;
      }
    }

    let companyOk = true;
    if (isSyntheticCnpj(company.cnpj) || company.cnpj !== bestCnpj) {
      companyOk = await replaceCompanyCnpj(
        company.cnpj,
        bestCnpj,
        ticker,
        company.name,
        company.sector,
      );
      if (companyOk) updatedCompanies += 1;
    }

    if (!companyOk) continue;

    claimedCnpjs.add(bestCnpj);

    await db
      .update(fiiCvmMonthly)
      .set({ ticker })
      .where(eq(fiiCvmMonthly.cnpj, bestCnpj));
    updatedCvmRows += 1;
    linked += 1;
    console.log(
      `[fii-link] ${ticker} ↔ ${bestCnpj} (${source} score ${bestScore})`,
    );
  }

  return { linked, updatedCompanies, updatedCvmRows };
}
