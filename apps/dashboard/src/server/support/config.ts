import 'server-only';

import { DashboardError } from '../errors.ts';

/**
 * The supporter tier's provider configuration (CAS-008, D44): three values,
 * read once when the runtime is built. All three absent means the tier is
 * not configured and every support action fails closed with a fixed code;
 * some but not all present is a configuration error at start-up, because a
 * half-configured provider would accept hand-offs it can never confirm.
 *
 * Every value is a secret or names one: none is printed, logged or echoed in
 * a rejection. The API version is pinned here, not left to the account's
 * default, so a Stripe-side upgrade cannot change the shape this code reads.
 */
export const STRIPE_SECRET_KEY_VARIABLE = 'STRIPE_SECRET_KEY';
export const STRIPE_WEBHOOK_SECRET_VARIABLE = 'STRIPE_WEBHOOK_SECRET';
export const STRIPE_PRICE_ID_VARIABLE = 'STRIPE_PRICE_ID';
/** The Stripe API version every request names, current on 22 October 2026. */
export const STRIPE_API_VERSION = '2026-09-30.endive';

/** A secret or restricted key; restricted keys are preferred (least privilege). */
const SECRET_KEY_SHAPE = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/u;
const WEBHOOK_SECRET_SHAPE = /^whsec_[A-Za-z0-9]{16,}$/u;
const PRICE_SHAPE = /^price_[A-Za-z0-9]{8,}$/u;

export type StripeMode = 'test' | 'live';

export interface SupportConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly priceId: string;
  /** Read from the key's own prefix; shown on the support page so a test key is never mistaken for a live one. */
  readonly mode: StripeMode;
}

function configuration(code: string, message: string): DashboardError {
  return new DashboardError('configuration', code, message);
}

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

export function loadSupportConfig(
  env: Readonly<Record<string, string | undefined>>,
): SupportConfig | null {
  const secretKey = read(env, STRIPE_SECRET_KEY_VARIABLE);
  const webhookSecret = read(env, STRIPE_WEBHOOK_SECRET_VARIABLE);
  const priceId = read(env, STRIPE_PRICE_ID_VARIABLE);
  const present = [secretKey, webhookSecret, priceId].filter((value) => value !== null).length;
  if (present === 0) return null;
  if (present !== 3) {
    throw configuration(
      'support_config_partial',
      `${STRIPE_SECRET_KEY_VARIABLE}, ${STRIPE_WEBHOOK_SECRET_VARIABLE} and ${STRIPE_PRICE_ID_VARIABLE} are set together or not at all`,
    );
  }
  const key = SECRET_KEY_SHAPE.exec(secretKey ?? '');
  if (key === null) {
    throw configuration(
      'support_key_invalid',
      `${STRIPE_SECRET_KEY_VARIABLE} rejected: not a Stripe secret or restricted key`,
    );
  }
  if (!WEBHOOK_SECRET_SHAPE.test(webhookSecret ?? '')) {
    throw configuration(
      'support_webhook_secret_invalid',
      `${STRIPE_WEBHOOK_SECRET_VARIABLE} rejected: not a Stripe endpoint signing secret`,
    );
  }
  if (!PRICE_SHAPE.test(priceId ?? '')) {
    throw configuration(
      'support_price_invalid',
      `${STRIPE_PRICE_ID_VARIABLE} rejected: not a Stripe price identifier`,
    );
  }
  return {
    secretKey: secretKey ?? '',
    webhookSecret: webhookSecret ?? '',
    priceId: priceId ?? '',
    mode: key[1] === 'live' ? 'live' : 'test',
  };
}
