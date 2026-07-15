/**
 * API key scopes — coarse RBAC for critical routes.
 *
 * - read:market   — companies, fundamentals, stocks, FIIs, macro, screener, analysis
 * - write:wallet  — wallet CRUD, assets, rebalance, contribution against wallet
 * - admin:keys    — create child keys, list owned keys inventory
 * - admin:ops     — metrics, scraper diagnostics
 * - *             — full access (bootstrap / CLI keys)
 */

export const ALL_SCOPES = [
  'read:market',
  'write:wallet',
  'admin:keys',
  'admin:ops',
] as const;

export type Scope = (typeof ALL_SCOPES)[number] | '*';

/** Default for HTTP-created child keys (no admin surface). */
export const DEFAULT_CHILD_SCOPES: string[] = ['read:market', 'write:wallet'];

/** Bootstrap / CLI keys get full power. */
export const BOOTSTRAP_SCOPES: string[] = [...ALL_SCOPES];

export function normalizeScopes(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...BOOTSTRAP_SCOPES];
  return raw.map(String).filter(Boolean);
}

export function hasScope(scopes: string[] | undefined, required: string): boolean {
  if (!scopes || scopes.length === 0) return false;
  if (scopes.includes('*')) return true;
  return scopes.includes(required);
}

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sends 403 and returns false when the caller lacks `required`.
 * Callers: `if (!requireScope(request, reply, 'admin:ops')) return;`
 */
export function requireScope(
  request: FastifyRequest,
  reply: FastifyReply,
  required: string,
): boolean {
  if (hasScope(request.scopes, required)) return true;
  reply.status(403).send({
    error: 'Forbidden',
    message: `Escopo '${required}' é necessário para esta operação.`,
    requiredScope: required,
  });
  return false;
}
