import { vi } from 'vitest';
import type { Env } from '../src/env';

export const TOKEN = '123456789:AA-TEST-TOKEN';

export const TEST_ENV: Env = {
  BOT_TOKEN: TOKEN,
  RELAY_SECRET: 'relay-secret-value',
  WEBHOOK_SECRET: 'webhook-secret-value',
  ORIGIN_URL: 'https://origin.example.ru/tg/webhook',
  // Быстрый backoff, чтобы тесты не спали по-настоящему.
  RETRY_BASE_DELAY_MS: '1',
};

export interface TestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Дождаться всех фоновых задач, отданных в waitUntil. */
  settled(): Promise<unknown[]>;
  pending: Promise<unknown>[];
}

export function createExecutionContext(): TestExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    settled: () => Promise.all(pending),
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
}

export interface FetchMock {
  calls: FetchCall[];
  restore(): void;
}

type Responder = (request: Request, callIndex: number) => Response | Promise<Response>;

/** Подменяет глобальный fetch и записывает метаданные вызовов (тело не трогаем). */
export function installFetchMock(responder: Responder): FetchMock {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init);
    const index = calls.length;
    calls.push({ url: request.url, method: request.method, headers: new Headers(request.headers) });
    return responder(request, index);
  });
  vi.stubGlobal('fetch', spy);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

export function relayRequest(path: string, init: RequestInit = {}, secret = TEST_ENV.RELAY_SECRET): Request {
  const headers = new Headers(init.headers ?? {});
  if (secret) headers.set('x-relay-secret', secret);
  return new Request(`https://relay.example.workers.dev${path}`, { ...init, headers });
}

export function webhookRequest(body: unknown, secret: string | null = TEST_ENV.WEBHOOK_SECRET): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret !== null) headers.set('x-telegram-bot-api-secret-token', secret);
  return new Request('https://relay.example.workers.dev/webhook', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
