/**
 * Request correlation id — accept incoming x-request-id or generate a UUID.
 *
 * Prefer configuring Fastify with `genReqId` (see server.ts) so `request.id`
 * is the correlation id everywhere (logs, hooks). This module also exposes a
 * light onRequest hook that echoes the id on the response as `x-request-id`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Resolve a safe request id from an optional incoming header value.
 * Empty / whitespace-only values are rejected; oversize values are truncated.
 */
export function resolveRequestId(incoming?: string | string[]): string {
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  if (typeof raw !== 'string') return randomUUID();

  // Strip CR/LF to prevent header injection; keep printable-ish correlation tokens.
  const cleaned = raw.replace(/[\r\n]/g, '').trim();
  if (cleaned.length === 0) return randomUUID();

  return cleaned.slice(0, MAX_REQUEST_ID_LENGTH);
}

/**
 * Fastify `genReqId` factory — reads x-request-id from the raw incoming request.
 * Note: Fastify passes the raw IncomingMessage; we only need headers.
 */
export function createGenReqId(): (req: { headers: IncomingHttpHeaders }) => string {
  return (req) => resolveRequestId(req.headers['x-request-id']);
}

/**
 * Echo request.id on the response as x-request-id (and request.requestId alias).
 */
export async function requestIdHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Fastify always populates request.id via genReqId / default.
  const id = request.id;
  // Optional alias for callers that prefer an explicit name.
  (request as FastifyRequest & { requestId?: string }).requestId = id;
  reply.header('x-request-id', id);
}
