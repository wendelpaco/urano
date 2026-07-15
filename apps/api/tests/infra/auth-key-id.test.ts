import { describe, expect, test, mock } from 'bun:test';

mock.module('../../src/infra/services/redis.ts', () => ({
  redis: {
    get: async () => null, // cache miss, forces DB lookup path
    setex: async () => {},
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

const { authMiddleware } = await import('../../src/infra/http/middleware/auth.ts');

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
  test('attaches the authenticated key id to the request on success', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = fakeRequest('/v1/wallets', 'ur_test');

    await authMiddleware(request as never, reply as never);

    expect(getCaptured()).toBeNull(); // not rejected
    expect(request.apiKeyId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});
