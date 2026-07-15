import { describe, expect, test } from 'bun:test';
import {
  createGenReqId,
  resolveRequestId,
} from '../../src/infra/http/middleware/request-id.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('resolveRequestId', () => {
  test('returns incoming id when present', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
  });

  test('trims whitespace', () => {
    expect(resolveRequestId('  corr-id  ')).toBe('corr-id');
  });

  test('generates uuid when missing or empty', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_RE);
    expect(resolveRequestId('')).toMatch(UUID_RE);
    expect(resolveRequestId('   ')).toMatch(UUID_RE);
  });

  test('uses first value when header is an array', () => {
    expect(resolveRequestId(['first', 'second'])).toBe('first');
  });

  test('strips CR/LF to avoid header injection', () => {
    expect(resolveRequestId('safe\r\ninjected')).toBe('safeinjected');
  });

  test('truncates oversize ids', () => {
    const long = 'x'.repeat(200);
    expect(resolveRequestId(long).length).toBe(128);
  });
});

describe('createGenReqId', () => {
  test('reads x-request-id from headers', () => {
    const gen = createGenReqId();
    expect(gen({ headers: { 'x-request-id': 'from-client' } })).toBe('from-client');
  });

  test('generates when header absent', () => {
    const gen = createGenReqId();
    expect(gen({ headers: {} })).toMatch(UUID_RE);
  });
});
