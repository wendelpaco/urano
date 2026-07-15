/**
 * Amarrar CNPJ CVM (fii_cvm_monthly) ↔ ticker em companies.
 * Seed atual usa CNPJ sintético FII… — este job substitui por CNPJ real quando o nome bate.
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

export async function linkFiiCnpjToTickers(minScore = 55): Promise<{
  linked: number;
  updatedCompanies: number;
  updatedCvmRows: number;
}> {
  // Distinct latest fund names from CVM
  const cvmFunds = await db.execute(sql`
    SELECT DISTINCT ON (cnpj) cnpj, fund_name
    FROM fii_cvm_monthly
    WHERE fund_name IS NOT NULL AND fund_name <> ''
    ORDER BY cnpj, reference_date DESC
  `);

  const fiiCompanies = await db
    .select({
      cnpj: companies.cnpj,
      ticker: companies.ticker,
      name: companies.name,
    })
    .from(companies)
    .where(sql`${companies.ticker} LIKE '%11'`);

  let linked = 0;
  let updatedCompanies = 0;
  let updatedCvmRows = 0;

  type CvmRow = { cnpj: string; fund_name: string };
  const funds = cvmFunds as unknown as CvmRow[];

  for (const company of fiiCompanies) {
    let best: { cnpj: string; score: number } | null = null;
    for (const f of funds) {
      const sc = scoreNames(company.name, f.fund_name ?? '');
      if (sc >= minScore && (!best || sc > best.score)) {
        best = { cnpj: f.cnpj, score: sc };
      }
    }
    if (!best) continue;

    // Já real (14 dígitos numéricos) e igual → só amarra ticker na CVM
    const isSynthetic = company.cnpj.startsWith('FII') || !/^\d{14}$/.test(company.cnpj);

    if (isSynthetic || company.cnpj !== best.cnpj) {
      // Atualiza companies: precisa trocar PK cnpj com cuidado
      // Estratégia: se já existe row com cnpj real, só atualiza ticker na fii_cvm;
      // senão update cnpj via delete+insert ou sql update se FK permitir.
      try {
        if (isSynthetic) {
          // Insert real CNPJ company, delete synthetic if different
          await db
            .insert(companies)
            .values({
              cnpj: best.cnpj,
              ticker: company.ticker,
              name: company.name,
              sector: null,
            })
            .onConflictDoUpdate({
              target: companies.cnpj,
              set: {
                ticker: company.ticker,
                name: company.name,
                updatedAt: new Date(),
              },
            });
          // Remove synthetic if different key
          if (company.cnpj !== best.cnpj) {
            await db.delete(companies).where(eq(companies.cnpj, company.cnpj));
          }
          updatedCompanies += 1;
        }
      } catch (e) {
        console.warn(
          `[fii-link] company ${company.ticker}:`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }
    }

    const upd = await db
      .update(fiiCvmMonthly)
      .set({ ticker: company.ticker })
      .where(eq(fiiCvmMonthly.cnpj, best.cnpj));
    // drizzle doesn't return rowCount consistently — count via select
    void upd;
    updatedCvmRows += 1;
    linked += 1;
    console.log(
      `[fii-link] ${company.ticker} ↔ ${best.cnpj} (score ${best.score})`,
    );
  }

  return { linked, updatedCompanies, updatedCvmRows };
}
