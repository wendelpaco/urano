import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  buildRateLimiter,
  MemoryRateLimitStore,
  RedisRateLimitStore,
  type RedisRateLimitClient,
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

function fakeRequest(
  url: string,
  key?: string,
  ip = '203.0.113.10',
  apiKeyId?: string,
) {
  return { url, ip, apiKeyId, headers: key ? { 'x-api-key': key } : {} };
}

/** Store wrapper that records keys passed to increment for assertions. */
class RecordingRateLimitStore implements RateLimitStore {
  readonly keys: string[] = [];
  private inner = new MemoryRateLimitStore();

  async increment(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    this.keys.push(key);
    return this.inner.increment(key, windowSeconds);
  }
}

/** Minimal Redis model for exercising the single atomic EVAL boundary. */
class AtomicRedisClient implements RedisRateLimitClient {
  count: number;
  remainingTtl: number;
  failAfterCommit = false;
  calls: Array<{ script: string; numberOfKeys: number; args: Array<string | number> }> = [];

  constructor(count = 0, remainingTtl = -2) {
    this.count = count;
    this.remainingTtl = remainingTtl;
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    this.calls.push({ script, numberOfKeys, args });

    // Redis runs this whole state transition before replying to the client.
    this.count += 1;
    if (this.remainingTtl < 0) this.remainingTtl = Number(args[1]);

    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error('socket closed after Redis committed EVAL');
    }
    // N-5: script Lua retorna {count, ttl} (array no Redis).
    return [this.count, this.remainingTtl];
  }
}

describe('rateLimiter', () => {
  test('Redis incrementa e cria/repara expiração em um único script atômico', async () => {
    // Simula contador legado que ficou persistente após INCR bem-sucedido e
    // EXPIRE perdido na implementação antiga.
    const client = new AtomicRedisClient(7, -1);
    const store = new RedisRateLimitStore(true, client);

    const result = await store.increment('ip:legacy', 45);
    expect(result.count).toBe(8);
    expect(result.ttl).toBe(45);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.numberOfKeys).toBe(1);
    expect(client.calls[0]?.args).toEqual(['ratelimit:ip:legacy', 45]);
    expect(client.calls[0]?.script).toContain("redis.call('INCR', KEYS[1])");
    expect(client.calls[0]?.script).toContain("redis.call('EXPIRE', KEYS[1]");
    expect(client.calls[0]?.script).toContain('if ttl < 0 then');
  });

  test('falha de resposta após commit não deixa contador sem TTL permanente', async () => {
    const client = new AtomicRedisClient();
    client.failAfterCommit = true;
    const store = new RedisRateLimitStore(false, client);

    // Fail-open sees no count because the response was lost, while the Redis
    // state already contains both the increment and its expiration.
    const r1 = await store.increment('ip:ambiguous', 30);
    expect(r1.count).toBe(0);
    expect(r1.ttl).toBe(30);

    // A later request observes the same expiring bucket, not a poisoned key.
    const r2 = await store.increment('ip:ambiguous', 30);
    expect(r2.count).toBe(2);
    expect(r2.ttl).toBe(30);
  });

  test('healthcheck público tem bucket e limite próprio', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({
      store,
      limit: 5,
      pathLimits: { '/v1/healthcheck': 1 },
    });

    const first = fakeReply();
    await hook(fakeRequest('/v1/healthcheck') as never, first.reply as never);
    expect(first.getCaptured()).toBeNull();
    expect(first.getHeaders()['x-ratelimit-limit']).toBe('1');

    const second = fakeReply();
    await hook(fakeRequest('/v1/healthcheck?ready=1') as never, second.reply as never);
    expect(second.getCaptured()?.status).toBe(429);
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

  test('trocar x-api-key não cria novo bucket antes da autenticação', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 2 });

    // Mesmo IP atinge o limite usando cabeçalhos diferentes/aleatórios.
    for (const key of ['key_a', 'key_b']) {
      const { reply } = fakeReply();
      await hook(fakeRequest('/v1/companies', key) as never, reply as never);
    }

    const blocked = fakeReply();
    await hook(
      fakeRequest('/v1/companies', 'another-random-key') as never,
      blocked.reply as never,
    );
    expect(blocked.getCaptured()?.status).toBe(429);
  });

  test('IPs diferentes têm limites pre-auth independentes', async () => {
    const store = new MemoryRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 1 });

    const first = fakeReply();
    await hook(fakeRequest('/v1/companies', 'same', '203.0.113.1') as never, first.reply as never);
    expect(first.getCaptured()).toBeNull();

    const blocked = fakeReply();
    await hook(fakeRequest('/v1/companies', 'same', '203.0.113.1') as never, blocked.reply as never);
    expect(blocked.getCaptured()?.status).toBe(429);

    const otherIp = fakeReply();
    await hook(fakeRequest('/v1/companies', 'same', '203.0.113.2') as never, otherIp.reply as never);
    expect(otherIp.getCaptured()).toBeNull();
  });

  test('store persiste hash do IP, nunca IP nem API key em texto puro', async () => {
    const store = new RecordingRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 10 });
    const plaintext = 'my-secret-key';
    const ip = '203.0.113.77';
    const expectedHash = createHash('sha256').update(ip).digest('hex');

    const { reply } = fakeReply();
    await hook(fakeRequest('/v1/companies', plaintext, ip) as never, reply as never);

    expect(store.keys.length).toBeGreaterThan(0);
    for (const key of store.keys) {
      expect(key).not.toBe(plaintext);
      expect(key).not.toContain(ip);
      expect(key).toBe(`ip:${expectedHash}`);
    }
  });

  test('camada post-auth usa somente apiKeyId validado e ignora header bruto', async () => {
    const store = new RecordingRateLimitStore();
    const hook = buildRateLimiter({ store, limit: 1, identity: 'authenticatedKey' });
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    const first = fakeReply();
    await hook(
      fakeRequest('/v1/companies', 'first-secret', '203.0.113.1', id) as never,
      first.reply as never,
    );
    expect(first.getCaptured()).toBeNull();
    expect(store.keys[0]).toBe(`apikey:${id}`);

    const blocked = fakeReply();
    await hook(
      fakeRequest('/v1/companies', 'changed-secret', '203.0.113.2', id) as never,
      blocked.reply as never,
    );
    expect(blocked.getCaptured()?.status).toBe(429);

    const unvalidated = fakeReply();
    await hook(
      fakeRequest('/v1/companies', 'random-header', '203.0.113.3') as never,
      unvalidated.reply as never,
    );
    expect(unvalidated.getCaptured()).toBeNull();

    expect(store.keys).toEqual([`apikey:${id}`, `apikey:${id}`]);
  });

  test('store throws + failClosed true → 503 ServiceUnavailable', async () => {
    const store: RateLimitStore = {
      async increment() {
        throw new Error('redis down');
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
    };
    const hook = buildRateLimiter({ store, limit: 10, failClosed: false });

    const { reply, getCaptured } = fakeReply();
    await hook(fakeRequest('/v1/companies', 'key_a') as never, reply as never);

    expect(getCaptured()).toBeNull();
  });
});
