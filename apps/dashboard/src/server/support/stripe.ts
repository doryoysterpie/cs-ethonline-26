import 'server-only';

import { randomUUID } from 'node:crypto';

import { DashboardError } from '../errors.ts';
import { STRIPE_API_VERSION, type SupportConfig } from './config.ts';

/**
 * The one boundary to Stripe (CAS-008, report section 1.2): two
 * form-encoded POSTs to `api.stripe.com`, the key in the `Authorization`
 * header and nowhere else, the API version pinned, an idempotency key per
 * request, a ten-second deadline. The transport is injected so tests see the
 * exact request and no socket opens. A failure of any kind is one fixed code;
 * Stripe's response body is never surfaced.
 *
 * The URL Stripe returns is checked before a browser is sent to it: https,
 * and a host under stripe.com. A custom checkout domain would be a reviewed
 * change here, not a configuration value.
 */
export const STRIPE_API_ORIGIN = 'https://api.stripe.com';
export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 1_048_576;
const SESSION_ID = /^cs_[A-Za-z0-9_]{8,200}$/u;

export interface StripeRequestInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface StripeResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: StripeRequestInit) => Promise<StripeResponseLike>;

export interface CheckoutSessionInput {
  readonly priceId: string;
  readonly accountId: string;
  readonly customerEmail: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface PortalSessionInput {
  readonly customerId: string;
  readonly returnUrl: string;
}

export interface StripeClient {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: PortalSessionInput): Promise<{ url: string }>;
}

function unavailable(): DashboardError {
  return new DashboardError(
    'unavailable',
    'checkout_unavailable',
    'the payment provider did not answer',
  );
}

export function isStripeHostedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))
  );
}

export function createStripeClient(
  config: Pick<SupportConfig, 'secretKey'>,
  fetchImpl: FetchLike,
  options: { readonly timeoutMs?: number | undefined } = {},
): StripeClient {
  const timeoutMs = options.timeoutMs ?? STRIPE_REQUEST_TIMEOUT_MS;

  async function post(
    path: string,
    form: URLSearchParams,
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: StripeResponseLike;
    try {
      response = await fetchImpl(`${STRIPE_API_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': STRIPE_API_VERSION,
          'idempotency-key': randomUUID(),
        },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable();
    }
    if (response.status < 200 || response.status >= 300) throw unavailable();
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw unavailable();
    }
    if (text.length > RESPONSE_MAX_BYTES) throw unavailable();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unavailable();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unavailable();
    return parsed as Readonly<Record<string, unknown>>;
  }

  return {
    async createCheckoutSession(input) {
      const form = new URLSearchParams();
      form.set('mode', 'subscription');
      form.set('line_items[0][price]', input.priceId);
      form.set('line_items[0][quantity]', '1');
      form.set('success_url', input.successUrl);
      form.set('cancel_url', input.cancelUrl);
      form.set('client_reference_id', input.accountId);
      if (input.customerEmail !== null) form.set('customer_email', input.customerEmail);
      const session = await post('/v1/checkout/sessions', form);
      const id = session['id'];
      const url = session['url'];
      if (typeof id !== 'string' || !SESSION_ID.test(id) || !isStripeHostedUrl(url)) {
        throw unavailable();
      }
      return { id, url };
    },
    async createPortalSession(input) {
      const form = new URLSearchParams();
      form.set('customer', input.customerId);
      form.set('return_url', input.returnUrl);
      const portal = await post('/v1/billing_portal/sessions', form);
      const url = portal['url'];
      if (!isStripeHostedUrl(url)) throw unavailable();
      return { url };
    },
  };
}
