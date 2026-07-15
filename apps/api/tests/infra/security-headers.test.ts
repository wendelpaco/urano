import { describe, expect, test } from 'bun:test';
import { buildSecurityHeaders } from '../../src/infra/http/middleware/security-headers.ts';

describe('buildSecurityHeaders', () => {
  test('sets baseline security headers', () => {
    const headers = buildSecurityHeaders('/v1/companies');

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=()',
    );
  });

  test('adds Cache-Control: no-store for authenticated /v1 routes', () => {
    const headers = buildSecurityHeaders('/v1/metrics');
    expect(headers['Cache-Control']).toBe('no-store');
  });

  test('omits Cache-Control no-store for healthcheck', () => {
    const headers = buildSecurityHeaders('/v1/healthcheck');
    expect(headers['Cache-Control']).toBeUndefined();
  });

  test('strips query string when deciding cache policy', () => {
    const protectedPath = buildSecurityHeaders('/v1/companies?limit=10');
    expect(protectedPath['Cache-Control']).toBe('no-store');

    const health = buildSecurityHeaders('/v1/healthcheck?ready=1');
    expect(health['Cache-Control']).toBeUndefined();
  });

  test('does not force no-store outside /v1', () => {
    const headers = buildSecurityHeaders('/');
    expect(headers['Cache-Control']).toBeUndefined();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
