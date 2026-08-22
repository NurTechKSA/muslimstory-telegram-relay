import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { TEST_ENV, createExecutionContext } from './helpers';

const ctx = () => createExecutionContext() as unknown as ExecutionContext;

describe('роутинг', () => {
  it('GET /health → 200 {"ok":true}', async () => {
    const response = await app.fetch(
      new Request('https://relay.example.workers.dev/health'),
      TEST_ENV,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('неизвестный путь → 404', async () => {
    const response = await app.fetch(
      new Request('https://relay.example.workers.dev/nope'),
      TEST_ENV,
      ctx(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error_code: 404 });
  });

  it('GET /webhook не обрабатывается (только POST)', async () => {
    const response = await app.fetch(
      new Request('https://relay.example.workers.dev/webhook'),
      TEST_ENV,
      ctx(),
    );

    expect(response.status).toBe(404);
  });
});
