import { describe, expect, test } from 'bun:test';
import { parseTrustProxy } from '../../src/config/env.ts';

describe('parseTrustProxy', () => {
  test('desabilita confiança em proxy por padrão', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
  });

  test('aceita apenas uma allow-list explícita de IPs/CIDRs', () => {
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
    ]);
  });

  test('rejeita TRUST_PROXY=true, que confiaria em qualquer remetente', () => {
    expect(() => parseTrustProxy('true')).toThrow('TRUST_PROXY=true é inseguro');
  });
});
