import { describe, expect, test } from 'bun:test';
import { buildRateLimiter, MemoryRateLimitStore } from '../../src/infra/http/middleware/rate-limit.ts';

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function fakeReply() {
  const headers: Record<string, string> = {};
  let captured: CapturedResponse | null = null;

  const reply = {
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      return {
        send(body: unknown) {
          captured = { status: code, body, headers: { ...headers } };
        },
      };
    },
  };

  return { reply, getCaptured: () => captured, getHeaders: () => headers };
}

function fakeRequest(url: string, key?: string) {
  return { url, headers: key ? { 'x-api-key': key } : {} };
}

describe('rateLimiter', () => {
  test('healthcheck é isento de rate limit', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 5 });

    const { reply, getCaptured } = fakeReply();
    await hook(fakeRequest('/v1/healthcheck') as never, reply as never);
    expect(getCaptured()).toBeNull();
  });

  test('dentro do limite: permite passar e seta headers', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 5 });

    const { reply, getCaptured, getHeaders } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_a') as never, reply as never);
    expect(getCaptured()).toBeNull(); // não bloqueia
    expect(getHeaders()['x-ratelimit-limit']).toBe('5');
    expect(getHeaders()['x-ratelimit-remaining']).toBeDefined();
  });

  test('excedeu limite: retorna 429 com Retry-After', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 3 });

    const key = 'key_over';
    for (let i = 0; i < 3; i++) {
      const { reply, getCaptured } = fakeReply();
      await hook(fakeRequest('/v1/companies', key) as never, reply as never);
      expect(getCaptured()).toBeNull();
    }

    const { reply, getCaptured, getHeaders } = fakeReply();
    await hook(fakeRequest('/v1/companies', key) as never, reply as never);
    const captured = getCaptured();
    expect(captured?.status).toBe(429);
    expect(captured?.body).toHaveProperty('error', 'TooManyRequests');
    expect(getHeaders()['retry-after']).toBeDefined();
  });

  test('keys diferentes têm limites independentes', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 2 });

    // Key A atinge o limite
    for (let i = 0; i < 2; i++) {
      const { reply } = fakeReply();
      await hook(fakeRequest('/v1/companies', 'key_a') as never, reply as never);
    }

    // Key A bloqueada
    const { reply: rA, getCaptured: cA } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_a') as never, rA as never);
    expect(cA()?.status).toBe(429);

    // Key B ainda passa
    const { reply: rB, getCaptured: cB } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_b') as never, rB as never);
    expect(cB()).toBeNull();
  });
});
