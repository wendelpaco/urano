import { describe, expect, test } from 'bun:test';
import {
  createApiKeyController,
  rotateApiKeyController,
  deleteApiKeyController,
  resolveChildScopes,
} from '../../src/infra/http/controllers/auth.controller.ts';
import { BOOTSTRAP_SCOPES } from '../../src/infra/http/scopes.ts';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeReply() {
  let captured: CapturedResponse | null = null;
  const reply = {
    status(code: number) {
      return {
        send(body: unknown) {
          captured = { status: code, body };
          return reply;
        },
      };
    },
    send(body: unknown) {
      captured = { status: 200, body };
    },
  };
  return { reply, getCaptured: () => captured };
}

const OWN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('key management — ownership enforcement', () => {
  // 404 (not 403) so we do not confirm existence of foreign keys.
  test('rotateApiKeyController: 404 when id is not the caller\'s own key and no admin:keys', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID, scopes: ['read:market'] };

    await rotateApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(404);
  });

  test('deleteApiKeyController: 404 when id is not the caller\'s own key and no admin:keys', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID, scopes: ['read:market'] };

    await deleteApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(404);
  });
});

describe('key management — delegated scopes', () => {
  test('nem bootstrap pode entregar admin:* a uma chave filha HTTP', () => {
    const result = resolveChildScopes(
      ['read:market', 'admin:keys', 'admin:ops', '*'],
      ['*'],
    );

    expect(result.scopes).toEqual(['read:market']);
    expect(result.denied).toEqual(['admin:keys', 'admin:ops', '*']);
  });

  test('defaults também são apenas a interseção dos scopes do criador', () => {
    const result = resolveChildScopes(undefined, ['read:market', 'admin:keys']);

    expect(result.scopes).toEqual(['read:market']);
    expect(result.denied).toEqual([]);
  });

  test('uma chave legada com admin:keys não pode redelegar admin:keys', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = {
      body: { name: 'grandchild', scopes: ['admin:keys'] },
      apiKeyId: OWN_ID,
      scopes: ['admin:keys'],
    };

    await createApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(403);
    expect(getCaptured()?.body).toHaveProperty('deniedScopes', ['admin:keys']);
  });

  test('criador autorizado segue podendo delegar subset não-admin', () => {
    const result = resolveChildScopes(['write:wallet'], ['*']);

    expect(result.scopes).toEqual(['write:wallet']);
    expect(result.denied).toEqual([]);
  });

  test('bootstrap/CLI preserva escopos administrativos próprios', () => {
    expect(BOOTSTRAP_SCOPES).toContain('admin:keys');
    expect(BOOTSTRAP_SCOPES).toContain('admin:ops');
  });
});
