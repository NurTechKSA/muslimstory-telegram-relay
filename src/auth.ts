/**
 * Constant-time сравнение секретов.
 *
 * Обычное `a === b` выходит из сравнения на первом несовпавшем байте, что даёт
 * атакующему возможность подбирать секрет по времени ответа. Здесь мы всегда
 * проходим весь буфер и накапливаем разницу в аккумуляторе.
 */
const encoder = new TextEncoder();

export function timingSafeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;

  const left = encoder.encode(a);
  const right = encoder.encode(b);

  // Длина утекает в любом случае (её видно по времени передачи), поэтому просто
  // подмешиваем её в аккумулятор и продолжаем сравнивать полный буфер.
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = i < left.length ? left[i] : 0;
    const y = i < right.length ? right[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

/** Проверка заголовка X-Relay-Secret (наш сервер → релей). */
export function checkRelaySecret(header: string | null | undefined, expected: string | undefined): boolean {
  return timingSafeEqual(header, expected);
}

/** Проверка заголовка X-Telegram-Bot-Api-Secret-Token (Telegram → релей). */
export function checkWebhookSecret(header: string | null | undefined, expected: string | undefined): boolean {
  return timingSafeEqual(header, expected);
}
