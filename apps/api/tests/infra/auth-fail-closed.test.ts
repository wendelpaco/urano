import { describe, expect, test, mock } from 'bun:test';

mock.module('../../src/infra/services/redis.ts', () => ({
  redis: {
    get: async () => {
      throw new Error('redis down');
    },
    setex: async () => {
      throw new Error('redis down');
    },
  },
  checkRedisConnection: async () => false,
  getOrSet: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
}));

mock.module('../../src/infra/database/connection.ts', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          throw new Error('db down');
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          throw new Error('db down');
        },
      }),
    }),
  },
  checkDatabaseConnection: async () => {
    throw new Error('db down');
  },
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

function fakeRequest(url: string, key?: string) {
  return { url, method: 'GET', headers: key ? { 'x-api-key': key } : {} };
}

describe('authMiddleware — fail-closed on DB outage', () => {
  test('denies the request with 503 instead of letting it through', async () => {
    const { reply, getCaptured } = fakeReply();

    await authMiddleware(fakeRequest('/v1/wallets', 'any-value-should-not-matter') as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(503);
    expect(captured?.body).toHaveProperty('error', 'ServiceUnavailable');
  });
});
