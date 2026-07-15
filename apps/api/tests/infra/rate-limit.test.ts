import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  buildRateLimiter,
  MemoryRateLimitStore,
  type RateLimitStore,
} from '../../src/infra/http/middleware/rate-limit.ts';

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

/** Store wrapper that records keys passed to increment/ttl for assertions. */
class RecordingRateLimitStore implements RateLimitStore {
  readonly keys: string[] = [];
  private inner = new MemoryRateLimitStore();

  async increment(key: string, windowSeconds: number): Promise<number> {
    this.keys.push(key);
    return this.inner.increment(key, windowSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.inner.ttl(key);
  }
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

  test('store keys are sha256 hex digests, never the plaintext API key', async () => {
    const store = new RecordingRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 10 });
    const plaintext = 'my-secret-key';
    const expectedHash = createHash('sha256').update(plaintext).digest('hex');

    const { reply } = fakeReply();
    await hook(fakeRequest('/v1/companies', plaintext) as never, reply as never);

    expect(store.keys.length).toBeGreaterThan(0);
    for (const key of store.keys) {
      expect(key).not.toBe(plaintext);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toBe(expectedHash);
    }
  });

  test('anonymous requests use the anonymous store key (no hash of empty string as secret)', async () => {
    const store = new RecordingRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 10 });

    const { reply } = fakeReply();
    await hook(fakeRequest('/v1/companies') as never, reply as never);

    expect(store.keys[0]).toBe('anonymous');
  });

  test('store throws + failClosed true → 503 ServiceUnavailable', async () => {
    const store: RateLimitStore = {
      async increment() {
        throw new Error('redis down');
      },
      async ttl() {
        return 60;
      },
    };
    const hook = buildRateLimiter({ store, limit: 10, failClosed: true });

    const { reply, getCaptured } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_a') as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(503);
    expect(captured?.body).toHaveProperty('error', 'ServiceUnavailable');
  });

  test('store throws + failClosed false (default) → fail-open, request allowed', async () => {
    const store: RateLimitStore = {
      async increment() {
        throw new Error('redis down');
      },
      async ttl() {
        return 60;
      },
    };
    const hook = buildRateLimiter({ store, limit: 10, failClosed: false });

    const { reply, getCaptured } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_a') as never, reply as never);

    expect(getCaptured()).toBeNull();
  });
});
