import { describe, expect, it } from 'vitest';

import { isDashboardError } from '../errors.ts';
import { loadSupportConfig, STRIPE_API_VERSION } from './config.ts';

const KEY = 'sk_test_' + 'A'.repeat(24);
const WEBHOOK = 'whsec_' + 'B'.repeat(32);
const PRICE = 'price_1Test00000001';

function code(env: Record<string, string | undefined>): string {
  try {
    const config = loadSupportConfig(env);
    return config === null ? 'null' : `ok:${config.mode}`;
  } catch (error) {
    return isDashboardError(error) ? `${error.kind}:${error.code}` : 'other';
  }
}

describe('the supporter tier configuration', () => {
  it('is absent when all three variables are absent or blank, and present with the mode read from the key', () => {
    expect(code({})).toBe('null');
    expect(code({ STRIPE_SECRET_KEY: ' ', STRIPE_WEBHOOK_SECRET: '', STRIPE_PRICE_ID: '' })).toBe(
      'null',
    );
    expect(
      code({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_PRICE_ID: PRICE }),
    ).toBe('ok:test');
    expect(
      code({
        STRIPE_SECRET_KEY: 'rk_live_' + 'C'.repeat(24),
        STRIPE_WEBHOOK_SECRET: WEBHOOK,
        STRIPE_PRICE_ID: PRICE,
      }),
    ).toBe('ok:live');
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/u);
  });

  it('refuses a partial set and each malformed value with a fixed code that never carries the value', () => {
    const partial = { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK };
    expect(code(partial)).toBe('configuration:support_config_partial');
    expect(
      code({
        STRIPE_SECRET_KEY: 'pk_test_' + 'A'.repeat(24),
        STRIPE_WEBHOOK_SECRET: WEBHOOK,
        STRIPE_PRICE_ID: PRICE,
      }),
    ).toBe('configuration:support_key_invalid');
    expect(
      code({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: 'nope', STRIPE_PRICE_ID: PRICE }),
    ).toBe('configuration:support_webhook_secret_invalid');
    expect(
      code({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_PRICE_ID: 'prod_x' }),
    ).toBe('configuration:support_price_invalid');
    let message = '';
    try {
      loadSupportConfig({
        STRIPE_SECRET_KEY: 'pk_test_SECRETVALUE000000000',
        STRIPE_WEBHOOK_SECRET: WEBHOOK,
        STRIPE_PRICE_ID: PRICE,
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toContain('SECRETVALUE');
  });
});
