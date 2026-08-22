/**
 * Конфигурация воркера. Все значения приходят из `wrangler secret put`,
 * ничего из этого не должно попадать в код, wrangler.toml или логи.
 */
export interface Env {
  /** Токен бота, подставляется воркером в путь Bot API. */
  BOT_TOKEN: string;
  /** Общий секрет между нашим сервером и релеем (заголовок X-Relay-Secret). */
  RELAY_SECRET: string;
  /** secret_token из setWebhook (заголовок X-Telegram-Bot-Api-Secret-Token). */
  WEBHOOK_SECRET: string;
  /** Полный URL обработчика вебхука на нашем сервере в России. */
  ORIGIN_URL: string;

  /** Необязательный тюнинг ретраев (обычные vars, не секреты). */
  RETRY_MAX_ATTEMPTS?: string;
  RETRY_BUDGET_MS?: string;
  RETRY_BASE_DELAY_MS?: string;
}

export type EnvKey = 'BOT_TOKEN' | 'RELAY_SECRET' | 'WEBHOOK_SECRET' | 'ORIGIN_URL';

/** Проверяет, что нужные переменные заданы и непустые. Возвращает имена отсутствующих. */
export function missingConfig(env: Env | undefined, keys: EnvKey[]): EnvKey[] {
  return keys.filter((key) => {
    const value = env?.[key];
    return typeof value !== 'string' || value.length === 0;
  });
}

/** Числовая настройка из vars с безопасным дефолтом. */
export function numericVar(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
