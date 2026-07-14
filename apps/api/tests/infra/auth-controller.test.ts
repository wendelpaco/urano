import { describe, expect, test } from 'bun:test';
import { rotateApiKeyController, deleteApiKeyController } from '../../src/infra/http/controllers/auth.controller.ts';

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
  test('rotateApiKeyController: 403 when id is not the caller\'s own key', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID };

    await rotateApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(403);
  });

  test('deleteApiKeyController: 403 when id is not the caller\'s own key', async () => {
    const { reply, getCaptured } = fakeReply();
    const request = { params: { id: OTHER_ID }, apiKeyId: OWN_ID };

    await deleteApiKeyController(request as never, reply as never);

    expect(getCaptured()?.status).toBe(403);
  });
});
