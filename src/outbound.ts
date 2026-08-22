import type { Context } from 'hono';
import { checkRelaySecret } from './auth';
import { missingConfig, numericVar, type Env } from './env';
import { fetchWithRetry, type RetryOptions } from './retry';

export const TELEGRAM_ORIGIN = 'https://api.telegram.org';

/** Имя метода Bot API: sendInvoice, answerPreCheckoutQuery и т.п. */
const METHOD_RE = /^[A-Za-z0-9_]{1,64}$/;
/** Путь файла: documents/file_12.jpg, photos/file_3.jpg. */
const FILE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-./]{0,255}$/;

const ALLOWED_METHODS = new Set(['GET', 'POST']);

/** Заголовки, которые нельзя пробрасывать наверх. */
const DROP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'x-relay-secret',
]);

const DROP_PREFIXES = ['cf-', 'x-forwarded-', 'x-real-ip'];

function shouldDropHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (DROP_HEADERS.has(lower)) return true;
  return DROP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Заголовки ответа Telegram, которые не пробрасываем клиенту. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

/** Никогда не даём токену утечь в лог или в текст ошибки. */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<redacted>');
}

function jsonError(status: number, description: string): Response {
  return new Response(JSON.stringify({ ok: false, error_code: status, description }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function upstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!shouldDropHeader(name)) headers.set(name, value);
  });
  return headers;
}

function retryOptionsFromEnv(env: Env): Partial<RetryOptions> {
  const options: Partial<RetryOptions> = {};
  if (env.RETRY_MAX_ATTEMPTS) options.maxAttempts = Math.max(1, numericVar(env.RETRY_MAX_ATTEMPTS, 3));
  if (env.RETRY_BUDGET_MS) options.budgetMs = numericVar(env.RETRY_BUDGET_MS, 8_000);
  if (env.RETRY_BASE_DELAY_MS) options.baseDelayMs = numericVar(env.RETRY_BASE_DELAY_MS, 250);
  return options;
}

export type OutboundKind = 'api' | 'file';

/**
 * OUTBOUND: наш сервер → Telegram.
 *
 * Клиент дёргает /api/sendInvoice (или /file/<path>) без токена;
 * токен подставляет воркер из env.BOT_TOKEN.
 */
export async function handleOutbound(
  c: Context<{ Bindings: Env }>,
  kind: OutboundKind,
  retryOverrides: Partial<RetryOptions> = {},
): Promise<Response> {
  const env = c.env;
  const request = c.req.raw;

  const missing = missingConfig(env, ['BOT_TOKEN', 'RELAY_SECRET']);
  if (missing.length > 0) {
    console.error(JSON.stringify({ route: kind, event: 'misconfigured', missing }));
    return jsonError(500, 'Relay is not configured');
  }

  if (!ALLOWED_METHODS.has(request.method)) {
    return jsonError(405, 'Method Not Allowed');
  }

  if (!checkRelaySecret(request.headers.get('x-relay-secret'), env.RELAY_SECRET)) {
    console.warn(JSON.stringify({ route: kind, event: 'auth_failed', status: 403 }));
    return jsonError(403, 'Forbidden');
  }

  const url = new URL(request.url);
  const prefix = kind === 'api' ? '/api/' : '/file/';
  const tail = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';

  if (kind === 'api' && !METHOD_RE.test(tail)) {
    return jsonError(400, 'Bad Request: unsupported Bot API method');
  }
  if (kind === 'file' && (!FILE_PATH_RE.test(tail) || tail.includes('..'))) {
    return jsonError(400, 'Bad Request: unsupported file path');
  }

  const base = kind === 'api' ? `${TELEGRAM_ORIGIN}/bot${env.BOT_TOKEN}/` : `${TELEGRAM_ORIGIN}/file/bot${env.BOT_TOKEN}/`;
  const target = `${base}${tail}${url.search}`;

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = new Request(target, {
    method: request.method,
    headers: upstreamHeaders(request),
    // Тело идёт стримом, без буферизации; content-type (в т.ч. multipart boundary) сохраняется.
    body: hasBody ? request.body : undefined,
    redirect: 'follow',
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);

  const startedAt = Date.now();
  try {
    const { response, attempts } = await fetchWithRetry(upstream, {
      ...retryOptionsFromEnv(env),
      ...retryOverrides,
    });

    const headers = new Headers();
    response.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    headers.set('x-relay-attempts', String(attempts));

    console.log(
      JSON.stringify({
        route: kind,
        method: request.method,
        // Имя метода Bot API — не секрет; тело и токен не логируем никогда.
        target: kind === 'api' ? tail : 'file',
        status: response.status,
        attempts,
        ms: Date.now() - startedAt,
      }),
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), env.BOT_TOKEN);
    console.error(
      JSON.stringify({ route: kind, event: 'upstream_error', message, ms: Date.now() - startedAt }),
    );
    return jsonError(502, 'Bad Gateway: upstream is unreachable');
  }
}
