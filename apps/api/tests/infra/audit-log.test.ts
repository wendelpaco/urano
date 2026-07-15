import { describe, expect, test, spyOn } from 'bun:test';
import { logSecurityEvent } from '../../src/infra/http/audit-log.ts';

describe('logSecurityEvent', () => {
  test('writes a structured line including action and details, never a raw key value', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    logSecurityEvent('api_key.create', { apiKeyId: 'abc-123', name: 'test' });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('api_key.create');
    expect(line).toContain('abc-123');
    expect(line).toContain('"audit":true');
    // Must never log a field that looks like a plaintext key
    expect(line).not.toMatch(/"key"\s*:/);
    spy.mockRestore();
  });

  test('does not throw when DB persistence fails (console path is independent)', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    expect(() =>
      logSecurityEvent('wallet.delete', { walletId: 'w-1', apiKeyId: 'k-1' }),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
