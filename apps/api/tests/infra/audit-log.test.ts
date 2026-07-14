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
    spy.mockRestore();
  });
});
