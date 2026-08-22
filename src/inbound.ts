import type { Context } from 'hono';
import { checkWebhookSecret } from './auth';
import { missingConfig, type Env } from './env';
import { fetchWithRetry, type RetryOptions } from './retry';

/**
 * Типы апдейтов, на которые Telegram ждёт ответ в течение 10 секунд.
 * Их нельзя форвардить через waitUntil — только синхронно.
 */
export const SYNC_UPDATE_TYPES = ['pre_checkout_query'] as const;

/** Таймаут синхронного форварда: укладываемся в окно Telegram в 10 секунд. */
const SYNC_TIMEOUT_MS = 8_000;
/** Фоновый форвард может позволить себе чуть больше и пару ретраев. */
const ASYNC_TIMEOUT_MS = 10_000;

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

function ack(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Определяем тип апдейта, не логируя и не пересобирая его содержимое. */
export function needsSyncForward(rawBody: string): boolean {
  let update: unknown;
  try {
    update = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (typeof update !== 'object' || update === null) return false;
  return SYNC_UPDATE_TYPES.some((type) => type in (update as Record<string, unknown>));
}

function originRequest(env: Env, body: string, signal: AbortSignal): Request {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'telegram-relay/1.0',
    // Пробрасываем секрет дальше: origin может проверять его тем же кодом,
    // что и при прямом вебхуке от Telegram.
    'x-telegram-bot-api-secret-token': env.WEBHOOK_SECRET,
    'x-relay-forwarded': 'telegram-webhook',
  });
  return new Request(env.ORIGIN_URL, { method: 'POST', headers, body, signal });
}

/**
 * INBOUND: Telegram → наш сервер.
 *
 * Обычные апдейты подтверждаем сразу (200) и форвардим в фоне через waitUntil.
 * pre_checkout_query форвардим синхронно и отдаём ответ origin как есть.
 */
export async function handleInbound(
  c: Context<{ Bindings: Env }>,
  retryOverrides: Partial<RetryOptions> = {},
): Promise<Response> {
  const env = c.env;
  const request = c.req.raw;

  const missing = missingConfig(env, ['WEBHOOK_SECRET', 'ORIGIN_URL']);
  if (missing.length > 0) {
    console.error(JSON.stringify({ route: 'webhook', event: 'misconfigured', missing }));
    // 500 — пусть Telegram повторит апдейт, когда конфиг починят.
    return plain(500, 'Relay is not configured');
  }

  const provided = request.headers.get('x-telegram-bot-api-secret-token');
  if (!checkWebhookSecret(provided, env.WEBHOOK_SECRET)) {
    console.warn(JSON.stringify({ route: 'webhook', event: 'auth_failed', status: 401 }));
    // Origin не дёргаем вообще.
    return plain(401, 'Unauthorized');
  }

  // Апдейты маленькие, но тело нужно целиком: по нему определяем тип апдейта
  // и его же переиспользуем для форварда (в лог содержимое не попадает).
  const body = await request.text();
  const sync = needsSyncForward(body);

  if (sync) {
    const startedAt = Date.now();
    try {
      const response = await fetch(originRequest(env, body, AbortSignal.timeout(SYNC_TIMEOUT_MS)));
      const headers = new Headers();
      response.headers.forEach((value, name) => {
        if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      });
      console.log(
        JSON.stringify({
          route: 'webhook',
          mode: 'sync',
          status: response.status,
          ms: Date.now() - startedAt,
        }),
      );
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          route: 'webhook',
          mode: 'sync',
          event: 'origin_unreachable',
          message: error instanceof Error ? error.message : String(error),
          ms: Date.now() - startedAt,
        }),
      );
      // Origin недоступен — Telegram всё равно получает 200, чтобы не копить ретраи.
      return ack();
    }
  }

  const forward = (async () => {
    const startedAt = Date.now();
    try {
      const { response, attempts } = await fetchWithRetry(
        originRequest(env, body, AbortSignal.timeout(ASYNC_TIMEOUT_MS)),
        { budgetMs: ASYNC_TIMEOUT_MS, ...retryOverrides },
      );
      response.body?.cancel().catch(() => {});
      console.log(
        JSON.stringify({
          route: 'webhook',
          mode: 'async',
          status: response.status,
          attempts,
          ms: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          route: 'webhook',
          mode: 'async',
          event: 'origin_unreachable',
          message: error instanceof Error ? error.message : String(error),
          ms: Date.now() - startedAt,
        }),
      );
    }
  })();

  try {
    c.executionCtx.waitUntil(forward);
  } catch {
    // Нет ExecutionContext (например, локальный вызов) — не роняем ответ Telegram.
    void forward;
  }

  return ack();
}
