import { afterEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import {
  TEST_ENV,
  TOKEN,
  createExecutionContext,
  installFetchMock,
  jsonResponse,
  relayRequest,
  type FetchMock,
} from './helpers';

let mock: FetchMock | null = null;

afterEach(() => {
  mock?.restore();
  mock = null;
});

async function call(request: Request): Promise<Response> {
  return app.fetch(request, TEST_ENV, createExecutionContext() as unknown as ExecutionContext);
}

describe('outbound: авторизация', () => {
  it('403 без заголовка X-Relay-Secret и Telegram не дёргается', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));
    const request = new Request('https://relay.example.workers.dev/api/sendInvoice', { method: 'POST' });

    const response = await call(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error_code: 403 });
    expect(mock.calls).toHaveLength(0);
  });

  it('403 при неверном секрете', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const response = await call(relayRequest('/api/sendInvoice', { method: 'POST' }, 'wrong-secret'));

    expect(response.status).toBe(403);
    expect(mock.calls).toHaveLength(0);
  });

  it('500, если BOT_TOKEN не сконфигурирован', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));
    const response = await app.fetch(
      relayRequest('/api/sendInvoice', { method: 'POST' }),
      { ...TEST_ENV, BOT_TOKEN: '' },
      createExecutionContext() as unknown as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('outbound: подстановка токена', () => {
  it('подставляет BOT_TOKEN в путь и не требует его от клиента', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true, result: { message_id: 7 } }));

    const response = await call(
      relayRequest('/api/sendInvoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 1, title: 'Stars' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mock.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendInvoice`);
    expect(await response.json()).toEqual({ ok: true, result: { message_id: 7 } });
  });

  it('не пробрасывает X-Relay-Secret наверх', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    await call(relayRequest('/api/getMe'));

    expect(mock.calls[0].headers.get('x-relay-secret')).toBeNull();
  });

  it('сохраняет query-параметры на GET', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true, result: [] }));

    await call(relayRequest('/api/getUpdates?offset=42&timeout=0'));

    expect(mock.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=42&timeout=0`);
    expect(mock.calls[0].method).toBe('GET');
  });

  it('не даёт клиенту протащить свой токен в путь', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const response = await call(relayRequest('/api/bot999:evil/sendMessage', { method: 'POST' }));

    expect(response.status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it('405 на неподдерживаемый метод', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const response = await call(relayRequest('/api/sendInvoice', { method: 'PUT' }));

    expect(response.status).toBe(405);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('outbound: тело запроса', () => {
  it('пробрасывает multipart/form-data вместе с boundary', async () => {
    let upstreamBody = '';
    let upstreamType = '';
    mock = installFetchMock(async (request) => {
      upstreamType = request.headers.get('content-type') ?? '';
      upstreamBody = await request.text();
      return jsonResponse({ ok: true });
    });

    const form = new FormData();
    form.set('chat_id', '42');
    form.set('photo', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'pic.png');

    const response = await call(relayRequest('/api/sendPhoto', { method: 'POST', body: form }));

    expect(response.status).toBe(200);
    expect(upstreamType).toContain('multipart/form-data; boundary=');
    expect(upstreamBody).toContain('name="chat_id"');
    expect(upstreamBody).toContain('filename="pic.png"');
  });

  it('пробрасывает JSON-тело как есть', async () => {
    let upstreamBody = '';
    mock = installFetchMock(async (request) => {
      upstreamBody = await request.text();
      return jsonResponse({ ok: true });
    });

    await call(
      relayRequest('/api/sendInvoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"chat_id":1,"currency":"XTR"}',
      }),
    );

    expect(upstreamBody).toBe('{"chat_id":1,"currency":"XTR"}');
  });
});

describe('outbound: ретраи', () => {
  it('ретраит 429 и отдаёт успешный ответ', async () => {
    mock = installFetchMock((_request, index) =>
      index === 0
        ? jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 429 })
        : jsonResponse({ ok: true, result: { message_id: 5 } }),
    );

    const response = await call(
      relayRequest('/api/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"chat_id":1,"text":"hi"}',
      }),
    );

    expect(mock.calls).toHaveLength(2);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-relay-attempts')).toBe('2');
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('не ретраит 400 и отдаёт ответ Telegram как есть', async () => {
    mock = installFetchMock(() =>
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }),
    );

    const response = await call(relayRequest('/api/sendMessage', { method: 'POST' }));

    expect(mock.calls).toHaveLength(1);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ description: 'Bad Request: chat not found' });
  });

  it('502, если Telegram недоступен во всех попытках', async () => {
    mock = installFetchMock(() => {
      throw new TypeError('fetch failed');
    });

    const response = await call(relayRequest('/api/getMe'));

    expect(response.status).toBe(502);
    expect(mock.calls).toHaveLength(3);
  });
});

describe('outbound: файлы', () => {
  it('проксирует /file/* на file/bot<TOKEN>/', async () => {
    mock = installFetchMock(() => new Response('binary', { status: 200 }));

    const response = await call(relayRequest('/file/documents/file_12.jpg'));

    expect(mock.calls[0].url).toBe(`https://api.telegram.org/file/bot${TOKEN}/documents/file_12.jpg`);
    expect(await response.text()).toBe('binary');
  });

  it('отклоняет обход каталога', async () => {
    mock = installFetchMock(() => new Response('binary'));

    const response = await call(relayRequest('/file/..%2F..%2Fsecret'));

    expect(response.status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });
});
