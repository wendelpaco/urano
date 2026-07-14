import { describe, expect, test } from 'bun:test';
import Fastify from 'fastify';
import cors from '@fastify/cors';

describe('CORS', () => {
  test('allows the configured origin', async () => {
    const app = Fastify();
    await app.register(cors, { origin: ['http://localhost:8080'] });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://localhost:8080' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
  });

  test('omits the header for a different origin', async () => {
    const app = Fastify();
    await app.register(cors, { origin: ['http://localhost:8080'] });
    app.get('/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://evil.example' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
