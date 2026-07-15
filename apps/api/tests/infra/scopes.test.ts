import { describe, expect, test } from 'bun:test';
import {
  hasScope,
  normalizeScopes,
  DEFAULT_CHILD_SCOPES,
  BOOTSTRAP_SCOPES,
} from '../../src/infra/http/scopes.ts';
import { pathOnly } from '../../src/infra/http/middleware/auth.ts';
import { requireScope } from '../../src/infra/http/scopes.ts';

describe('scopes helpers', () => {
  test('hasScope: * grants everything', () => {
    expect(hasScope(['*'], 'admin:ops')).toBe(true);
  });

  test('hasScope: exact match', () => {
    expect(hasScope(['read:market'], 'read:market')).toBe(true);
    expect(hasScope(['read:market'], 'admin:ops')).toBe(false);
  });

  test('normalizeScopes: empty falls back to bootstrap', () => {
    expect(normalizeScopes(null)).toEqual(BOOTSTRAP_SCOPES);
    expect(normalizeScopes([])).toEqual(BOOTSTRAP_SCOPES);
  });

  test('DEFAULT_CHILD_SCOPES has no admin', () => {
    expect(DEFAULT_CHILD_SCOPES.some((s) => s.startsWith('admin:'))).toBe(false);
  });
});

describe('pathOnly', () => {
  test('strips query string for public route matching', () => {
    expect(pathOnly('/v1/healthcheck?ready=1')).toBe('/v1/healthcheck');
    expect(pathOnly('/v1/wallets')).toBe('/v1/wallets');
  });
});

describe('requireScope', () => {
  test('sends 403 when missing scope', () => {
    let status = 0;
    let body: unknown;
    const reply = {
      status(code: number) {
        status = code;
        return {
          send(b: unknown) {
            body = b;
          },
        };
      },
    };
    const request = { scopes: ['read:market'] };
    const ok = requireScope(request as never, reply as never, 'admin:ops');
    expect(ok).toBe(false);
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Forbidden', requiredScope: 'admin:ops' });
  });

  test('allows when scope present', () => {
    const reply = {
      status() {
        return { send() {} };
      },
    };
    const request = { scopes: ['admin:ops', 'read:market'] };
    expect(requireScope(request as never, reply as never, 'admin:ops')).toBe(true);
  });
});
