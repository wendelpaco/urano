/**
 * Security headers middleware — baseline browser/proxy hardening.
 *
 * Applied on every response. Does not touch CORS headers (managed by @fastify/cors).
 * Cache-Control: no-store on /v1/* except the public healthcheck.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Pure builder of security headers for a given request path (query stripped).
 * Exported for unit tests.
 */
export function buildSecurityHeaders(url: string): Record<string, string> {
  const path = url.split('?')[0] ?? url;
  const headers: Record<string, string> = { ...BASE_HEADERS };

  // Authenticated API responses must not be cached by intermediaries/browsers.
  // Healthcheck stays cacheable so load balancers / k8s probes stay cheap.
  if (path.startsWith('/v1') && path !== '/v1/healthcheck') {
    headers['Cache-Control'] = 'no-store';
  }

  return headers;
}

/**
 * Fastify onRequest hook: apply security headers without overwriting CORS.
 * Prefer onRequest over onSend so we never risk replacing the response payload.
 */
export async function securityHeadersHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const headers = buildSecurityHeaders(request.url);
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }

  // HSTS only when the request is already HTTPS (direct or via trusted proxy).
  const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  if (proto === 'https' || (request.raw.socket as { encrypted?: boolean } | undefined)?.encrypted) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
