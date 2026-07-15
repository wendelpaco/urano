/**
 * Route-level scope enforcement as a Fastify preHandler factory.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireScope } from '../scopes.ts';

export function requireScopeHandler(scope: string) {
  return async function scopeGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!requireScope(request, reply, scope)) {
      // reply already sent — abort the route chain
      return;
    }
  };
}
