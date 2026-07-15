import { describe, expect, test, mock, beforeEach } from 'bun:test';

/** Mutable flags so each case can flip DB/Redis health without re-import flakiness. */
const healthState = {
  dbUp: true,
  redisUp: true,
};

mock.module('../../src/infra/services/redis.ts', () => ({
  redis: {
    get: async () => null,
    setex: async () => {},
    ping: async () => 'PONG',
  },
  checkRedisConnection: async () => healthState.redisUp,
  getOrSet: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
}));

mock.module('../../src/infra/database/connection.ts', () => ({
  db: {
    execute: async () => [{ ok: 1 }],
  },
  checkDatabaseConnection: async () => {
    if (!healthState.dbUp) {
      throw new Error('db down');
    }
  },
  closeDatabaseConnection: async () => {},
}));

const { healthcheckController } = await import(
  '../../src/infra/http/controllers/healthcheck.controller.ts'
);

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function fakeReply() {
  let captured: CapturedResponse | null = null;
  const reply = {
    status(code: number) {
      return {
        send(body: Record<string, unknown>) {
          captured = { status: code, body };
          return reply;
        },
      };
    },
    send(body: Record<string, unknown>) {
      captured = { status: 200, body };
    },
  };
  return { reply, getCaptured: () => captured };
}

function fakeRequest() {
  return { url: '/v1/healthcheck', method: 'GET', headers: {} };
}

/** Fields that must never leak from the public healthcheck (old verbose shape). */
const LEAKY_FIELDS = ['circuitBreakers', 'rateLimiters', 'userAgentPool'] as const;

describe('healthcheckController', () => {
  beforeEach(() => {
    healthState.dbUp = true;
    healthState.redisUp = true;
  });

  test('both up → 200 with status ok and minimal payload', async () => {
    const { reply, getCaptured } = fakeReply();

    await healthcheckController(fakeRequest() as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(200);
    expect(captured?.body.status).toBe('ok');
    expect(captured?.body.checks).toEqual({ database: 'up', redis: 'up' });
    expect(typeof captured?.body.uptimeSeconds).toBe('number');
    expect(typeof captured?.body.timestamp).toBe('string');

    for (const field of LEAKY_FIELDS) {
      expect(captured?.body).not.toHaveProperty(field);
    }
  });

  test('db down → 503 degraded', async () => {
    healthState.dbUp = false;
    const { reply, getCaptured } = fakeReply();

    await healthcheckController(fakeRequest() as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(503);
    expect(captured?.body.status).toBe('degraded');
    expect(captured?.body.checks).toEqual({ database: 'down', redis: 'up' });

    for (const field of LEAKY_FIELDS) {
      expect(captured?.body).not.toHaveProperty(field);
    }
  });

  test('redis down → 503 degraded', async () => {
    healthState.redisUp = false;
    const { reply, getCaptured } = fakeReply();

    await healthcheckController(fakeRequest() as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(503);
    expect(captured?.body.status).toBe('degraded');
    expect(captured?.body.checks).toEqual({ database: 'up', redis: 'down' });

    for (const field of LEAKY_FIELDS) {
      expect(captured?.body).not.toHaveProperty(field);
    }
  });

  test('both down → 503 degraded', async () => {
    healthState.dbUp = false;
    healthState.redisUp = false;
    const { reply, getCaptured } = fakeReply();

    await healthcheckController(fakeRequest() as never, reply as never);

    const captured = getCaptured();
    expect(captured?.status).toBe(503);
    expect(captured?.body.status).toBe('degraded');
    expect(captured?.body.checks).toEqual({ database: 'down', redis: 'down' });
  });
});
