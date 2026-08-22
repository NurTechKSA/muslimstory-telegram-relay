import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, isRetryableStatus, readRetryAfterMs } from '../src/retry';

function tg(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(responses: Array<Response | Error>) {
  const sleeps: number[] = [];
  let clock = 0;
  const seenBodies: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    seenBodies.push(request.body ? await request.text() : '');
    const next = responses.shift();
    if (!next) throw new Error('no more mocked responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    sleeps,
    seenBodies,
    options: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      jitter: () => 1,
      baseDelayMs: 250,
    },
    fetchImpl,
  };
}

describe('isRetryableStatus', () => {
  it('ретраит 429 и 5xx, но не 4xx', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('readRetryAfterMs', () => {
  it('читает parameters.retry_after из ответа Telegram', async () => {
    const response = tg({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429);
    expect(await readRetryAfterMs(response)).toBe(7000);
    // Тело осталось читаемым после клонирования.
    expect(await response.text()).toContain('retry_after');
  });

  it('предпочитает заголовок Retry-After', async () => {
    const response = new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    expect(await readRetryAfterMs(response)).toBe(2000);
  });

  it('возвращает null, если подсказки нет', async () => {
    expect(await readRetryAfterMs(tg({ ok: false }, 500))).toBeNull();
  });
});

describe('fetchWithRetry', () => {
  it('не ретраит успешный ответ', async () => {
    const h = harness([tg({ ok: true })]);
    const result = await fetchWithRetry(new Request('https://api.telegram.org/x'), h.options);
    expect(result.attempts).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('ретраит 429 и ждёт retry_after из тела Telegram', async () => {
    const h = harness([
      tg({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, 429),
      tg({ ok: true, result: { message_id: 1 } }),
    ]);
    const result = await fetchWithRetry(new Request('https://api.telegram.org/x'), h.options);

    expect(h.sleeps).toEqual([3000]);
    expect(result.attempts).toBe(2);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ ok: true, result: { message_id: 1 } });
  });

  it('ретраит 5xx с экспоненциальным backoff, максимум 3 попытки', async () => {
    const h = harness([tg({}, 502), tg({}, 503), tg({}, 500)]);
    const result = await fetchWithRetry(new Request('https://api.telegram.org/x'), h.options);

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toEqual([250, 500]);
    expect(result.response.status).toBe(500);
    expect(result.attempts).toBe(3);
  });

  it('не ретраит, если retry_after не влезает в бюджет', async () => {
    const h = harness([tg({ ok: false, parameters: { retry_after: 30 } }, 429)]);
    const result = await fetchWithRetry(new Request('https://api.telegram.org/x'), {
      ...h.options,
      budgetMs: 8000,
    });

    expect(h.sleeps).toEqual([]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
  });

  it('останавливается, когда бюджет исчерпан паузами', async () => {
    const h = harness([tg({}, 500), tg({}, 500), tg({}, 500)]);
    const result = await fetchWithRetry(new Request('https://api.telegram.org/x'), {
      ...h.options,
      budgetMs: 400,
    });

    expect(h.sleeps).toEqual([250]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(500);
  });

  it('ретраит сетевую ошибку и сохраняет тело запроса', async () => {
    const h = harness([new Error('connection reset'), tg({ ok: true })]);
    const request = new Request('https://api.telegram.org/x', {
      method: 'POST',
      body: 'chat_id=1&text=hi',
    });
    const result = await fetchWithRetry(request, h.options);

    expect(result.attempts).toBe(2);
    expect(h.seenBodies).toEqual(['chat_id=1&text=hi', 'chat_id=1&text=hi']);
  });

  it('пробрасывает ошибку, если все попытки упали', async () => {
    const h = harness([new Error('a'), new Error('b'), new Error('c')]);
    await expect(fetchWithRetry(new Request('https://api.telegram.org/x'), h.options)).rejects.toThrow('c');
  });
});
