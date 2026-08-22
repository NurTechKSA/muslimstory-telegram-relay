import { Hono } from 'hono';
import type { Env } from './env';
import { handleInbound } from './inbound';
import { handleOutbound } from './outbound';

const app = new Hono<{ Bindings: Env }>();

/** Health check — без секретов и без обращений к Telegram. */
app.get('/health', (c) => c.json({ ok: true }));

/** OUTBOUND: наш сервер → Telegram Bot API. */
app.all('/api/*', (c) => handleOutbound(c, 'api'));

/** OUTBOUND: скачивание файлов (api.telegram.org/file/bot<TOKEN>/...). */
app.all('/file/*', (c) => handleOutbound(c, 'file'));

/** INBOUND: вебхук Telegram → наш origin. */
app.post('/webhook', (c) => handleInbound(c));

app.notFound((c) => c.json({ ok: false, error_code: 404, description: 'Not Found' }, 404));

app.onError((error, c) => {
  // Ни тела запроса, ни токена: только тип ошибки.
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      path: new URL(c.req.url).pathname,
      name: error instanceof Error ? error.name : 'Error',
    }),
  );
  return c.json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
});

export default app;
