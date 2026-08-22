import { describe, expect, it } from 'vitest';
import { checkRelaySecret, checkWebhookSecret, timingSafeEqual } from '../src/auth';

describe('timingSafeEqual', () => {
  it('принимает одинаковые строки', () => {
    expect(timingSafeEqual('s3cret', 's3cret')).toBe(true);
    expect(timingSafeEqual('юникод-секрет', 'юникод-секрет')).toBe(true);
  });

  it('отклоняет разные строки той же длины', () => {
    expect(timingSafeEqual('s3cret', 's3crea')).toBe(false);
  });

  it('отклоняет строки разной длины', () => {
    expect(timingSafeEqual('s3cret', 's3cret-long')).toBe(false);
    expect(timingSafeEqual('s3cret-long', 's3cret')).toBe(false);
  });

  it('отклоняет пустые и отсутствующие значения', () => {
    expect(timingSafeEqual('', '')).toBe(false);
    expect(timingSafeEqual(null, 'x')).toBe(false);
    expect(timingSafeEqual(undefined, undefined)).toBe(false);
    expect(timingSafeEqual('x', undefined)).toBe(false);
  });

  it('обёртки для конкретных заголовков ведут себя так же', () => {
    expect(checkRelaySecret('a', 'a')).toBe(true);
    expect(checkRelaySecret('a', 'b')).toBe(false);
    expect(checkWebhookSecret(null, 'b')).toBe(false);
  });
});
