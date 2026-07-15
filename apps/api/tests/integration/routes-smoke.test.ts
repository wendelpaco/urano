/**
 * Smoke de rotas/scopes sem servidor HTTP: valida contratos estáticos
 * (OpenAPI paths vs routes plugin) e helpers de scope.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_SCOPES,
  hasScope,
  DEFAULT_CHILD_SCOPES,
  BOOTSTRAP_SCOPES,
} from '../../src/infra/http/scopes.ts';
import { openApiController } from '../../src/infra/http/controllers/docs.controller.ts';
import type { FastifyReply, FastifyRequest } from 'fastify';

describe('scopes contract', () => {
  test('ALL_SCOPES cobre market/wallet/admin', () => {
    expect(ALL_SCOPES).toContain('read:market');
    expect(ALL_SCOPES).toContain('write:wallet');
    expect(ALL_SCOPES).toContain('admin:keys');
    expect(ALL_SCOPES).toContain('admin:ops');
  });

  test('hasScope: * libera tudo; escopo exato; falta = false', () => {
    expect(hasScope(['*'], 'admin:ops')).toBe(true);
    expect(hasScope(['read:market'], 'read:market')).toBe(true);
    expect(hasScope(['read:market'], 'admin:ops')).toBe(false);
    expect(hasScope(undefined, 'read:market')).toBe(false);
  });

  test('defaults: child vs bootstrap', () => {
    expect(DEFAULT_CHILD_SCOPES).toEqual(['read:market', 'write:wallet']);
    expect(BOOTSTRAP_SCOPES).toContain('admin:ops');
  });
});

describe('OpenAPI paths vs routes', () => {
  test('documenta benchmarks, fii cvm/tr, metrics, health', async () => {
    let body: unknown;
    const reply = {
      send(payload: unknown) {
        body = payload;
      },
    } as unknown as FastifyReply;
    await openApiController({} as FastifyRequest, reply);
    const spec = body as {
      paths: Record<string, unknown>;
      openapi: string;
    };
    expect(spec.openapi).toBe('3.0.3');
    const paths = Object.keys(spec.paths);
    for (const p of [
      '/benchmarks',
      '/benchmarks/{id}',
      '/fiis/{ticker}/cvm',
      '/fiis/{ticker}/total-return',
      '/metrics',
      '/analysis/validation',
      '/health/data',
      '/health/scraper',
    ]) {
      expect(paths).toContain(p);
    }
  });

  test('routes plugin registra paths críticos', () => {
    const routesSrc = readFileSync(
      join(import.meta.dir, '../../src/infra/http/routes/index.ts'),
      'utf8',
    );
    for (const fragment of [
      "/benchmarks",
      "/fiis/:ticker/cvm",
      "/fiis/:ticker/total-return",
      "/metrics",
      "/analysis/validation",
      "requireScopeHandler('read:market')",
      "requireScopeHandler('admin:ops')",
    ]) {
      expect(routesSrc.includes(fragment)).toBe(true);
    }
  });
});
