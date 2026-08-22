/**
 * Ретраи для запросов в Telegram: 429 (с учётом retry_after) и 5xx.
 *
 * Тело запроса не буферизуется: перед каждой попыткой мы делаем `request.clone()`,
 * который тее-ит поток, и отправляем оригинал. Копия остаётся для следующей попытки.
 */

export interface RetryOptions {
  /** Всего попыток, включая первую. */
  maxAttempts: number;
  /** Общий бюджет по времени на все попытки вместе со сном. */
  budgetMs: number;
  /** База экспоненциального backoff. */
  baseDelayMs: number;
  /** Потолок для одной паузы. */
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 0..1, используется как джиттер; в тестах подменяется на константу. */
  jitter: () => number;
  fetchImpl: typeof fetch;
}

export const DEFAULT_RETRY_OPTIONS: Omit<RetryOptions, 'fetchImpl'> = {
  maxAttempts: 3,
  budgetMs: 8_000,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  jitter: () => Math.random(),
};

export interface RetryResult {
  response: Response;
  /** Сколько попыток реально было сделано (1 — ретраев не было). */
  attempts: number;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Достаёт паузу из ответа Telegram: сначала заголовок Retry-After,
 * затем `parameters.retry_after` из тела. Возвращает мс или null.
 */
export async function readRetryAfterMs(response: Response): Promise<number | null> {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;

  try {
    const body = (await response.clone().json()) as {
      retry_after?: unknown;
      parameters?: { retry_after?: unknown };
    };
    const seconds = body?.parameters?.retry_after ?? body?.retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  } catch {
    // Тело не читается / не JSON — считаем, что подсказки нет. Тело не логируем.
  }
  return null;
}

function backoffDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  // Полный джиттер, чтобы несколько воркеров не долбили Telegram синхронно.
  return Math.round(capped * (0.5 + 0.5 * options.jitter()));
}

/**
 * Освобождает неиспользованное тело. Промис от cancel() НЕ ждём: у ветки tee
 * (а именно её даёт request.clone()) он резолвится только когда закрыта и вторая
 * ветка — ожидание здесь привело бы к вечному зависанию.
 */
function discard(source: Request | Response | null | undefined): void {
  try {
    source?.body?.cancel().catch(() => {});
  } catch {
    // ignore
  }
}

export async function fetchWithRetry(
  request: Request,
  overrides: Partial<RetryOptions> = {},
): Promise<RetryResult> {
  const options: RetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    fetchImpl: overrides.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init)),
    ...overrides,
  };

  const startedAt = options.now();
  let pending: Request | null = request;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const current: Request | null = pending;
    if (!current) break;
    attemptsMade = attempt;

    const canRetryAgain = attempt < options.maxAttempts;
    // Копию нужно снять ДО отправки: fetch потребляет поток тела.
    let next: Request | null = null;
    if (canRetryAgain) {
      try {
        next = current.clone();
      } catch {
        next = null; // тело уже не клонируется — ретраить нечего
      }
    }

    let response: Response | null = null;
    try {
      response = await options.fetchImpl(current);
      lastError = null;
    } catch (error) {
      lastError = error;
    }

    if (response && !isRetryableStatus(response.status)) {
      discard(next);
      return { response, attempts: attempt };
    }

    lastResponse = response;
    if (!next) break;

    const retryAfterMs = response ? await readRetryAfterMs(response) : null;
    const delay = retryAfterMs ?? backoffDelay(attempt, options);
    const elapsed = options.now() - startedAt;

    if (elapsed + delay >= options.budgetMs) {
      // Бюджет исчерпан — отдаём последний ответ как есть, лишнюю копию закрываем.
      discard(next);
      break;
    }

    discard(response);
    lastResponse = null;
    if (delay > 0) await options.sleep(delay);
    pending = next;
  }

  if (lastResponse) {
    return { response: lastResponse, attempts: attemptsMade };
  }
  throw lastError ?? new Error('upstream request failed');
}
