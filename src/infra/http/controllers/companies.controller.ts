import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { companyQueries } from '../../database/company-queries.ts';

function safeParse<T>(schema: z.ZodSchema<T>, data: unknown, reply: FastifyReply, message: string): T | null {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.status(400).send({
      error: 'ValidationError',
      message,
      details: parsed.error.issues.map(({ path, message: m }) => ({ path: path.join('.'), message: m })),
    });
    return null;
  }
  return parsed.data;
}

const paramsSchema = z.object({
  ticker: z
    .string()
    .min(4)
    .max(10)
    .transform((t) => t.toUpperCase()),
});

const querySchema = z.object({
  sector: z.string().optional(),
});

/**
 * GET /v1/companies
 * Lista todas as empresas cadastradas. Filtro opcional por setor.
 */
export async function listCompaniesController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = safeParse(querySchema, request.query, reply, 'Query inválida.');
  if (!parsed) return;

  const companies = await companyQueries.listCompanies(parsed.sector);
  reply.send({ total: companies.length, data: companies });
}

/**
 * GET /v1/companies/sectors
 * Lista setores distintos com empresas cadastradas.
 */
export async function listSectorsController(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sectors = await companyQueries.listSectors();
  reply.send({ total: sectors.length, data: sectors });
}

/**
 * GET /v1/companies/:ticker
 * Detalhes de uma empresa com seus fundamentos mais recentes.
 */
export async function getCompanyByTickerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = safeParse(paramsSchema, request.params, reply, 'Ticker inválido.');
  if (!parsed) return;

  const company = await companyQueries.findDetailByTicker(parsed.ticker);

  if (!company) {
    reply.status(404).send({
      error: 'NotFound',
      message: `Empresa "${parsed.ticker}" não encontrada.`,
    });
    return;
  }

  reply.send(company);
}
