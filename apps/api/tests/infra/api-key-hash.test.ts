import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

describe('API key hashing', () => {
  test('sha256 hex digest is deterministic and matches expected format', () => {
    const key = 'ur_deadbeef_deadbeef_deadbeef_deadbeef';
    const hash = createHash('sha256').update(key).digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(key).digest('hex')).toBe(hash);
  });
});
