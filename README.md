# telegram-relay

Двусторонний релей для Telegram Bot API на Cloudflare Workers.

Нужен там, где сервер (например, в России) не может напрямую ходить на
`api.telegram.org` — в частности для оплаты Telegram Stars (`sendInvoice`,
`pre_checkout_query`, `answerPreCheckoutQuery`).

```
                 ┌─────────────────────── Cloudflare Worker ───────────────────────┐
  наш сервер ──► │  POST /api/sendInvoice   ──►  api.telegram.org/bot<TOKEN>/...    │ ──► Telegram
  (Россия)       │  GET  /file/<path>       ──►  api.telegram.org/file/bot<TOKEN>/  │
                 │                                                                 │
  Telegram   ──► │  POST /webhook           ──►  ORIGIN_URL                         │ ──► наш сервер
                 └─────────────────────────────────────────────────────────────────┘
```

## Маршруты

| Маршрут | Метод | Авторизация | Что делает |
| --- | --- | --- | --- |
| `/health` | GET | нет | `200 {"ok":true}` |
| `/api/<method>` | GET, POST | `X-Relay-Secret` | проксирует на `https://api.telegram.org/bot<BOT_TOKEN>/<method>` |
| `/file/<path>` | GET, POST | `X-Relay-Secret` | проксирует на `https://api.telegram.org/file/bot<BOT_TOKEN>/<path>` |
| `/webhook` | POST | `X-Telegram-Bot-Api-Secret-Token` | форвардит апдейт на `ORIGIN_URL` |

Коды ошибок релея: `403` — неверный `X-Relay-Secret`, `401` — неверный секрет вебхука
(origin при этом не дёргается вообще), `400` — недопустимое имя метода или путь файла,
`405` — метод HTTP кроме GET/POST, `502` — Telegram недоступен, `500` — не заданы секреты.

## Деплой

```bash
npm install
npm test
npx wrangler deploy
```

Первый деплой попросит залогиниться (`npx wrangler login`). Имя воркера — `telegram-relay`
в [wrangler.toml](wrangler.toml), адрес получится вида
`https://telegram-relay.<your-subdomain>.workers.dev`.

## Секреты

В коде и в `wrangler.toml` секретов нет. Всё кладётся через `wrangler secret put` —
значение вводится в stdin и хранится зашифрованным на стороне Cloudflare:

```bash
npx wrangler secret put BOT_TOKEN       # 123456789:AA... — токен от @BotFather
npx wrangler secret put RELAY_SECRET    # общий секрет: наш сервер → релей
npx wrangler secret put WEBHOOK_SECRET  # secret_token из setWebhook: Telegram → релей
npx wrangler secret put ORIGIN_URL      # https://our-server.ru/tg/webhook
```

Сгенерировать сильные секреты:

```bash
openssl rand -hex 32   # RELAY_SECRET
openssl rand -hex 32   # WEBHOOK_SECRET (Telegram допускает A-Z a-z 0-9 _ -, 1..256 символов)
```

Проверка:

```bash
npx wrangler secret list
curl https://telegram-relay.<your-subdomain>.workers.dev/health   # {"ok":true}
```

### Локальная разработка

Создайте `.dev.vars` (он в `.gitignore`, в git не попадает):

```ini
BOT_TOKEN="123456789:AA..."
RELAY_SECRET="dev-relay-secret"
WEBHOOK_SECRET="dev-webhook-secret"
ORIGIN_URL="http://localhost:8000/tg/webhook"
```

```bash
npx wrangler dev
```

## Настройка вебхука

`setWebhook` вызывается **через сам релей** (сервер в России в Telegram напрямую не ходит).
URL вебхука указывает на релей, а релей уже форвардит апдейты на `ORIGIN_URL`.

```bash
RELAY="https://telegram-relay.<your-subdomain>.workers.dev"
RELAY_SECRET="<то же значение, что в wrangler secret put RELAY_SECRET>"
WEBHOOK_SECRET="<то же значение, что в wrangler secret put WEBHOOK_SECRET>"

curl -sS -X POST "$RELAY/api/setWebhook" \
  -H "X-Relay-Secret: $RELAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "'"$RELAY"'/webhook",
        "secret_token": "'"$WEBHOOK_SECRET"'",
        "allowed_updates": ["message","callback_query","pre_checkout_query","message_reaction"],
        "drop_pending_updates": false,
        "max_connections": 40
      }'
```

Проверить и снять:

```bash
curl -sS "$RELAY/api/getWebhookInfo" -H "X-Relay-Secret: $RELAY_SECRET"
curl -sS -X POST "$RELAY/api/deleteWebhook" -H "X-Relay-Secret: $RELAY_SECRET"
```

Отправить инвойс на Stars:

```bash
curl -sS -X POST "$RELAY/api/sendInvoice" \
  -H "X-Relay-Secret: $RELAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "chat_id": 111111111,
        "title": "Подписка",
        "description": "30 дней доступа",
        "payload": "sub-30d",
        "currency": "XTR",
        "prices": [{"label": "Подписка", "amount": 100}]
      }'
```

## Клиент: Python

Токен клиенту не нужен — его подставляет воркер. Меняется только базовый URL и добавляется
заголовок `X-Relay-Secret`.

```python
import os
import requests

RELAY_URL = os.environ["RELAY_URL"]          # https://telegram-relay.<sub>.workers.dev
RELAY_SECRET = os.environ["RELAY_SECRET"]

session = requests.Session()
session.headers["X-Relay-Secret"] = RELAY_SECRET


def call(method: str, **payload):
    """Было: https://api.telegram.org/bot<TOKEN>/<method>
       Стало: {RELAY_URL}/api/<method>"""
    response = session.post(f"{RELAY_URL}/api/{method}", json=payload, timeout=15)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(f"{method} failed: {data.get('description')}")
    return data["result"]


def send_photo(chat_id: int, path: str, caption: str = ""):
    # multipart/form-data проходит через релей стримом, как есть
    with open(path, "rb") as photo:
        response = session.post(
            f"{RELAY_URL}/api/sendPhoto",
            data={"chat_id": chat_id, "caption": caption},
            files={"photo": photo},
            timeout=60,
        )
    return response.json()


def download_file(file_path: str) -> bytes:
    # file_path — то, что вернул getFile
    return session.get(f"{RELAY_URL}/file/{file_path}", timeout=60).content


if __name__ == "__main__":
    call(
        "sendInvoice",
        chat_id=111111111,
        title="Подписка",
        description="30 дней доступа",
        payload="sub-30d",
        currency="XTR",
        prices=[{"label": "Подписка", "amount": 100}],
    )
```

Обработчик вебхука на нашем сервере остаётся прежним: релей пробрасывает заголовок
`X-Telegram-Bot-Api-Secret-Token` дальше, так что существующая проверка секрета работает
без изменений. Для `pre_checkout_query` ответ надо вернуть **прямо в теле HTTP-ответа**
(релей передаёт его в Telegram как есть):

```python
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]


@app.post("/tg/webhook")
async def webhook(request: Request, x_telegram_bot_api_secret_token: str = Header("")):
    if x_telegram_bot_api_secret_token != WEBHOOK_SECRET:
        raise HTTPException(status_code=401)

    update = await request.json()
    if "pre_checkout_query" in update:
        # синхронный путь: у Telegram всего 10 секунд
        return {
            "method": "answerPreCheckoutQuery",
            "pre_checkout_query_id": update["pre_checkout_query"]["id"],
            "ok": True,
        }

    handle_update(update)
    return {"ok": True}
```

## Клиент: Node

```js
const RELAY_URL = process.env.RELAY_URL;
const RELAY_SECRET = process.env.RELAY_SECRET;

// Было: https://api.telegram.org/bot<TOKEN>/<method>
// Стало: `${RELAY_URL}/api/<method>`
export async function call(method, payload) {
  const response = await fetch(`${RELAY_URL}/api/${method}`, {
    method: 'POST',
    headers: {
      'X-Relay-Secret': RELAY_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`${method} failed: ${response.status} ${data.description ?? ''}`);
  }
  return data.result;
}

// multipart: FormData уходит стримом, boundary сохраняется
export async function sendPhoto(chatId, blob, filename = 'photo.jpg') {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('photo', blob, filename);

  const response = await fetch(`${RELAY_URL}/api/sendPhoto`, {
    method: 'POST',
    headers: { 'X-Relay-Secret': RELAY_SECRET },
    body: form,
  });
  return response.json();
}

await call('sendInvoice', {
  chat_id: 111111111,
  title: 'Подписка',
  description: '30 дней доступа',
  payload: 'sub-30d',
  currency: 'XTR',
  prices: [{ label: 'Подписка', amount: 100 }],
});
```

### Если используется библиотека

Библиотеки обычно позволяют подменить базовый URL. Важное отличие релея: **токен в путь
не подставляется клиентом**, путь выглядит как `/api/<method>`, а секрет едет в заголовке.

```js
// grammY
import { Bot } from 'grammy';

const bot = new Bot(process.env.BOT_TOKEN, {
  client: {
    apiRoot: process.env.RELAY_URL,
    buildUrl: (root, _token, method) => `${root}/api/${method}`,
    baseFetchConfig: { headers: { 'X-Relay-Secret': process.env.RELAY_SECRET } },
  },
});
```

```python
# aiogram 3.x
from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

server = TelegramAPIServer(
    base=f"{RELAY_URL}/api/{{method}}",   # {token} в шаблоне не используется
    file=f"{RELAY_URL}/file/{{path}}",
)
session = AiohttpSession(api=server)
session._session_headers = {"X-Relay-Secret": RELAY_SECRET}  # проверьте под свою версию
bot = Bot(token=os.environ["BOT_TOKEN"], session=session)
```

Точные имена опций зависят от версии библиотеки — проверьте на `getMe` перед боем.
Токен боту всё равно придётся передать (библиотеки его требуют), но в сеть он не уходит:
релей игнорирует всё, что пришло от клиента, и подставляет собственный `BOT_TOKEN`.

## Поведение

**Outbound (`/api/*`, `/file/*`)**

- Токен берётся только из `env.BOT_TOKEN`; имя метода валидируется по `^[A-Za-z0-9_]{1,64}$`,
  так что протащить свой `bot<token>/` в путь нельзя.
- `X-Relay-Secret` сверяется constant-time, сам заголовок наверх не пробрасывается.
  Не пробрасываются также `cf-*`, `x-forwarded-*`, hop-by-hop заголовки.
- Тело идёт стримом, без буферизации: `application/json` и `multipart/form-data`
  (в т.ч. `sendPhoto`/`sendDocument`) проходят как есть вместе с `boundary`.
- Query-параметры сохраняются, ответ Telegram (статус, тело, заголовки) отдаётся как есть,
  плюс диагностический `X-Relay-Attempts`.
- Ретраи: `429` и `5xx`, до 3 попыток, экспоненциальный backoff с джиттером, общий бюджет
  8 секунд. На `429` пауза берётся из `Retry-After` или `parameters.retry_after` ответа
  Telegram; если пауза не влезает в бюджет — ретрая не будет, отдаётся ответ Telegram.
  Настраивается через `[vars]`: `RETRY_MAX_ATTEMPTS`, `RETRY_BUDGET_MS`, `RETRY_BASE_DELAY_MS`.
- Сетевая ошибка на всех попытках → `502`.

**Inbound (`/webhook`)**

- `X-Telegram-Bot-Api-Secret-Token` сверяется constant-time с `WEBHOOK_SECRET`; при
  несовпадении — `401` и origin не дёргается.
- Обычные апдейты: Telegram сразу получает `200 {"ok":true}`, форвард на `ORIGIN_URL`
  идёт в фоне через `ctx.waitUntil` (до 3 попыток, бюджет 10 секунд).
- `pre_checkout_query` форвардится синхронно (таймаут 8 секунд) и ответ origin —
  статус, заголовки, тело — уходит в Telegram как есть. Это позволяет отвечать
  `answerPreCheckoutQuery` прямо телом HTTP-ответа и уложиться в 10-секундное окно.
- Если origin недоступен, Telegram всё равно получает `200` — ошибка пишется в лог,
  чтобы Telegram не копил ретраи апдейтов.

**Логи и приватность**

Не логируются: токен, тела запросов и ответов, содержимое апдейтов. В лог идёт только
структурированный JSON: маршрут, имя метода Bot API, HTTP-статус, число попыток,
длительность. В текстах ошибок токен дополнительно вырезается (`<redacted>`).
CORS отсутствует намеренно — это server-to-server.

## Тесты

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Покрыто: constant-time сравнение, `403` без секрета, `401` на чужом вебхуке (и что origin
не дёргается), подстановка токена и запрет клиентского токена в пути, сохранение query,
multipart-стриминг, ретрай на `429` с `retry_after`, backoff на `5xx`, остановка по бюджету,
`502` при недоступности Telegram, `/file/*` и защита от обхода каталога, синхронный путь
для `pre_checkout_query`, фоновый форвард через `waitUntil`, живучесть при упавшем origin,
`/health` и `404`.

## Структура

```
src/index.ts      Hono, роутинг, /health, обработка ошибок
src/outbound.ts   /api/* и /file/* → api.telegram.org
src/inbound.ts    /webhook → ORIGIN_URL
src/auth.ts       constant-time сравнение секретов
src/retry.ts      ретраи 429/5xx с бюджетом
src/env.ts        типы и валидация конфигурации
test/             vitest
```
