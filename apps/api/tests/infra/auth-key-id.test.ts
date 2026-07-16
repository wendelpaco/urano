import { describe, expect, test, mock } from 'bun:test';
import { createHash } from 'node:crypto';

const setexCalls: Array<[string, number, string]> = [];

mock.module('../../src/infra/services/redis.ts', () => ({
  redis: {
    get: async () => null, // cache miss, forces DB lookup path
    setex: async (key: string, ttl: number, value: string) => {
      setexCalls.push([key, ttl, value]);
    },
  },
  checkRedisConnection: async () => true,
  getOrSet: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
}));

mock.module('../../src/infra/database/connection.ts', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          scopes: ['read:market', 'write:wallet', 'admin:keys', 'admin:ops'],
        }],
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  },
  checkDatabaseConnection: async () => {},
  closeDatabaseConnection: async () => {},
}));

const {
  AUTH_CACHE_TTL_SECONDS,
  authCacheKey,
  authMiddleware,
  invalidateCachedAuth,
  parseCachedAuth,
} = await import('../../src/infra/http/middleware/auth.ts');

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeReply() {
  let captured: CapturedResponse | null = null;
  const reply = {
    status(code: number) {
      return {
        send(body: unknown) {
          captured = { status: code, body };
        },
      };
    },
  };
  return { reply, getCaptured: () => captured };
}

function fakeRequest(url: string, key?: string): { url: string; method: string; headers: Record<string, string>; apiKeyId?: string } {
  return { url, method: 'GET', headers: key ? { 'x-api-key': key } : {} };
}

describe('authMiddleware — sets request.apiKeyId', () => {
  test('cache legado ou sem scopes consulta o banco em vez de conceder bootstrap', () => {
    expect(parseCachedAuth('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBeNull();
    expect(parseCachedAuth(JSON.stringify({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    }))).toBeNull();
    expect(parseCachedAuth(JSON.stringify({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      scopes: ['read:market'],
    }))).toEqual({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      scopes: ['read:market'],
    });
  });

  test('attaches the authenticated key id to the request on success', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = fakeRequest('/v1/wallets', 'ur_test');

    await authMiddleware(request as never, reply as never);

    expect(getCaptured()).toBeNull(); // not rejected
    expect(request.apiKeyId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  test('rotation/deactivation overwrites a positive cache with negative immediately', async () => {
    setexCalls.length = 0;
    const plaintext = 'ur_revoked_test_key';
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    const sharedCacheUpdated = await invalidateCachedAuth(keyHash);

    expect(sharedCacheUpdated).toBe(true);
    expect(setexCalls).toEqual([
      [authCacheKey(keyHash), AUTH_CACHE_TTL_SECONDS, 'false'],
    ]);

    // Mesmo que o cache compartilhado/DB tentassem aceitar a chave neste
    // processo, a deny-list local impede uso após a mutação.
    const { reply, getCaptured } = fakeReply();
    const request = fakeRequest('/v1/wallets', plaintext);
    await authMiddleware(request as never, reply as never);
    expect(getCaptured()).toMatchObject({ status: 401 });
    expect(request.apiKeyId).toBeUndefined();
  });
});
