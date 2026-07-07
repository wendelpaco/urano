import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { desc, sql } from 'drizzle-orm';
import { db } from '../../database/connection.ts';
import { companies, companyFundamentals } from '../../database/schema.ts';

const screenerSchema = z.object({
  sector: z.string().optional(),
  minNetIncome: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  maxNetIncome: z.string().optional().transform((v) => (v ? parseFloat(v) : undefined)),
  year: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
  limit: z.string().optional().default('50').transform(Number).pipe(z.number().int().min(1).max(200)),
  sortBy: z.enum(['netIncome', 'ticker']).default('netIncome'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export async function screenerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const filters = screenerSchema.parse(request.query);

  const rows = await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (c.cnpj)
        c.ticker,
        c.name,
        c.sector,
        c.cnpj,
        cf.fiscal_year,
        cf.reference_date,
        cf.net_income,
        cf.net_income_parent,
        cf.equity,
        cf.source
      FROM companies c
      INNER JOIN company_fundamentals cf ON cf.company_cnpj = c.cnpj
      WHERE 1=1
        ${filters.sector ? sql`AND c.sector ILIKE ${`%${filters.sector}%`}` : sql``}
        ${filters.minNetIncome !== undefined ? sql`AND cf.net_income >= ${filters.minNetIncome}` : sql``}
        ${filters.maxNetIncome !== undefined ? sql`AND cf.net_income <= ${filters.maxNetIncome}` : sql``}
        ${filters.year !== undefined ? sql`AND cf.fiscal_year = ${filters.year}` : sql``}
      ORDER BY c.cnpj, cf.reference_date DESC
    ) sub
    ORDER BY
      ${filters.sortBy === 'netIncome'
        ? sql`sub.net_income ${filters.order === 'desc' ? sql`DESC` : sql`ASC`}`
        : sql`sub.ticker ${filters.order === 'desc' ? sql`DESC` : sql`ASC`}`
      }
    LIMIT ${filters.limit}
  `);

  const data = (rows as unknown as Record<string, unknown>[]).map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector ?? null,
    cnpj: r.cnpj,
    fiscalYear: Number(r.fiscal_year),
    referenceDate: String(r.reference_date ?? '').slice(0, 10),
    netIncome: Number(r.net_income ?? 0),
    netIncomeParent: Number(r.net_income_parent ?? 0),
    equity: r.equity ? Number(r.equity) : null,
    source: r.source,
  }));

  reply.send({
    filters: { sector: filters.sector ?? null, minNetIncome: filters.minNetIncome ?? null, maxNetIncome: filters.maxNetIncome ?? null, year: filters.year ?? null },
    total: data.length,
    data,
  });
}
