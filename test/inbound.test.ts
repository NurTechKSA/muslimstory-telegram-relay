import { afterEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import {
  TEST_ENV,
  createExecutionContext,
  installFetchMock,
  jsonResponse,
  webhookRequest,
  type FetchMock,
  type TestExecutionContext,
} from './helpers';

let mock: FetchMock | null = null;

afterEach(() => {
  mock?.restore();
  mock = null;
});

async function call(request: Request, ctx: TestExecutionContext = createExecutionContext()) {
  const response = await app.fetch(request, TEST_ENV, ctx as unknown as ExecutionContext);
  return { response, ctx };
}

const MESSAGE_UPDATE = { update_id: 1, message: { message_id: 10, text: 'привет' } };
const PRE_CHECKOUT_UPDATE = {
  update_id: 2,
  pre_checkout_query: { id: 'pcq-1', total_amount: 100, currency: 'XTR' },
};

describe('inbound: авторизация', () => {
  it('401 на чужом секрете и origin не дёргается', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const { response, ctx } = await call(webhookRequest(MESSAGE_UPDATE, 'not-our-secret'));

    expect(response.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
    expect(ctx.pending).toHaveLength(0);
  });

  it('401 без заголовка секрета', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const { response } = await call(webhookRequest(MESSAGE_UPDATE, null));

    expect(response.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  it('401 даже на pre_checkout_query с чужим секретом', async () => {
    mock = installFetchMock(() => jsonResponse({ ok: true }));

    const { response } = await call(webhookRequest(PRE_CHECKOUT_UPDATE, 'not-our-secret'));

    expect(response.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('inbound: обычные апдейты', () => {
  it('сразу отвечает 200 и форвардит на origin через waitUntil', async () => {
    let forwardedBody = '';
    let forwardedSecret: string | null = null;
    mock = installFetchMock(async (request) => {
      forwardedSecret = request.headers.get('x-telegram-bot-api-secret-token');
      forwardedBody = await request.text();
      return new Response('', { status: 200 });
    });

    const { response, ctx } = await call(webhookRequest(MESSAGE_UPDATE));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Форвард отдан в waitUntil, а не заблокировал ответ Telegram.
    expect(ctx.pending).toHaveLength(1);

    await ctx.settled();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe(TEST_ENV.ORIGIN_URL);
    expect(forwardedSecret).toBe(TEST_ENV.WEBHOOK_SECRET);
    expect(JSON.parse(forwardedBody)).toEqual(MESSAGE_UPDATE);
  });

  it('отдаёт Telegram 200, даже если origin лежит', async () => {
    mock = installFetchMock(() => {
      throw new TypeError('fetch failed');
    });

    const { response, ctx } = await call(webhookRequest(MESSAGE_UPDATE));

    expect(response.status).toBe(200);
    await expect(ctx.settled()).resolves.toBeDefined();
    expect(mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('битый JSON не ломает ответ Telegram', async () => {
    mock = installFetchMock(() => new Response('', { status: 200 }));

    const { response, ctx } = await call(webhookRequest('not-json-at-all'));

    expect(response.status).toBe(200);
    await ctx.settled();
    expect(mock.calls).toHaveLength(1);
  });
});

describe('inbound: pre_checkout_query', () => {
  it('форвардит синхронно и отдаёт ответ origin как есть', async () => {
    const originAnswer = {
      method: 'answerPreCheckoutQuery',
      pre_checkout_query_id: 'pcq-1',
      ok: true,
    };
    let forwardedBody = '';
    mock = installFetchMock(async (request) => {
      forwardedBody = await request.text();
      return jsonResponse(originAnswer, { status: 200, headers: { 'x-origin-marker': 'yes' } });
    });

    const { response, ctx } = await call(webhookRequest(PRE_CHECKOUT_UPDATE));

    // Никакого waitUntil: ответ должен уйти в Telegram синхронно, в окно 10 секунд.
    expect(ctx.pending).toHaveLength(0);
    expect(mock.calls).toHaveLength(1);
    expect(JSON.parse(forwardedBody)).toEqual(PRE_CHECKOUT_UPDATE);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-origin-marker')).toBe('yes');
    expect(await response.json()).toEqual(originAnswer);
  });

  it('пробрасывает статус ошибки origin как есть', async () => {
    mock = installFetchMock(() => new Response('boom', { status: 503 }));

    const { response } = await call(webhookRequest(PRE_CHECKOUT_UPDATE));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('boom');
  });

  it('если origin недоступен — Telegram всё равно получает 200', async () => {
    mock = installFetchMock(() => {
      throw new TypeError('fetch failed');
    });

    const { response } = await call(webhookRequest(PRE_CHECKOUT_UPDATE));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Синхронный путь не ретраит: окно Telegram всего 10 секунд.
    expect(mock.calls).toHaveLength(1);
  });
});

describe('inbound: конфигурация', () => {
  it('500, если ORIGIN_URL не задан (Telegram повторит апдейт)', async () => {
    mock = installFetchMock(() => new Response('', { status: 200 }));

    const response = await app.fetch(
      webhookRequest(MESSAGE_UPDATE),
      { ...TEST_ENV, ORIGIN_URL: '' },
      createExecutionContext() as unknown as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(mock.calls).toHaveLength(0);
  });
});
