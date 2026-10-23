import { describe, expect, it } from 'vitest';

import { isDashboardError } from '../errors.ts';
import { STRIPE_API_VERSION } from './config.ts';
import { createStripeClient, isStripeHostedUrl, type StripeRequestInit } from './stripe.ts';

const KEY = 'rk_test_' + 'A'.repeat(24);

function recorder(status: number, body: string) {
  const calls: { url: string; init: StripeRequestInit }[] = [];
  const fetchImpl = async (url: string, init: StripeRequestInit) => {
    calls.push({ url, init });
    return { status, text: async () => body };
  };
  return { calls, fetchImpl };
}

describe('the Stripe client', () => {
  it('posts a form-encoded subscription checkout with the key in the header, the version pinned, and nothing in the URL', async () => {
    const stripe = recorder(
      200,
      JSON.stringify({
        id: 'cs_test_a1b2c3d4e5f6g7h8',
        url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8#fragment',
      }),
    );
    const client = createStripeClient({ secretKey: KEY }, stripe.fetchImpl);
    const session = await client.createCheckoutSession({
      priceId: 'price_Test00000001',
      accountId: '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      customerId: null,
      customerEmail: 'reader@example.org',
      successUrl: 'https://dashboard.example.org/support?notice=checkout_returned',
      cancelUrl: 'https://dashboard.example.org/support?notice=checkout_cancelled',
      idempotencyKey: '0f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      expiresAtSeconds: 1_800_002_100,
    });
    expect(session).toEqual({
      id: 'cs_test_a1b2c3d4e5f6g7h8',
      url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8#fragment',
    });
    expect(stripe.calls).toHaveLength(1);
    const call = stripe.calls[0];
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(call?.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call?.init.headers['stripe-version']).toBe(STRIPE_API_VERSION);
    // The attempt's key, not a fresh one: a retry of the same attempt answers the same session.
    expect(call?.init.headers['idempotency-key']).toBe('0f6a6e2e-1c2b-4a3d-8e5f-0123456789ab');
    const form = new URLSearchParams(call?.init.body ?? '');
    expect(Object.fromEntries(form.entries())).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_Test00000001',
      'line_items[0][quantity]': '1',
      success_url: 'https://dashboard.example.org/support?notice=checkout_returned',
      cancel_url: 'https://dashboard.example.org/support?notice=checkout_cancelled',
      client_reference_id: '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      expires_at: '1800002100',
      customer_email: 'reader@example.org',
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the email for an account without one, and posts the portal session with its customer', async () => {
    const stripe = recorder(
      200,
      JSON.stringify({ id: 'cs_test_a1b2c3d4e5f6g7h8', url: 'https://checkout.stripe.com/c/x' }),
    );
    const client = createStripeClient({ secretKey: KEY }, stripe.fetchImpl);
    await client.createCheckoutSession({
      priceId: 'price_Test00000001',
      accountId: 'a',
      customerId: null,
      customerEmail: null,
      successUrl: 'https://d.example/s',
      cancelUrl: 'https://d.example/c',
      idempotencyKey: '0f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      expiresAtSeconds: 1_800_002_100,
    });
    expect(new URLSearchParams(stripe.calls[0]?.init.body ?? '').has('customer_email')).toBe(false);
    // A known customer is reused in place of the address (train review F7).
    await client.createCheckoutSession({
      priceId: 'price_Test00000001',
      accountId: 'a',
      customerId: 'cus_Test00000001',
      customerEmail: 'reader@example.org',
      successUrl: 'https://d.example/s',
      cancelUrl: 'https://d.example/c',
      idempotencyKey: '0f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      expiresAtSeconds: 1_800_002_100,
    });
    const bound = new URLSearchParams(stripe.calls[1]?.init.body ?? '');
    expect([bound.get('customer'), bound.has('customer_email')]).toEqual([
      'cus_Test00000001',
      false,
    ]);
    const portal = recorder(
      200,
      JSON.stringify({ url: 'https://billing.stripe.com/p/session?secret=x' }),
    );
    const portalClient = createStripeClient({ secretKey: KEY }, portal.fetchImpl);
    expect(
      await portalClient.createPortalSession({
        customerId: 'cus_Test00000001',
        returnUrl: 'https://d.example/support',
      }),
    ).toEqual({ url: 'https://billing.stripe.com/p/session?secret=x' });
    expect(portal.calls[0]?.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(
      Object.fromEntries(new URLSearchParams(portal.calls[0]?.init.body ?? '').entries()),
    ).toEqual({
      customer: 'cus_Test00000001',
      return_url: 'https://d.example/support',
    });
  });

  it('answers one fixed code for a non-2xx, a thrown transport, a malformed body and a URL off stripe.com', async () => {
    const attempts = [
      createStripeClient(
        { secretKey: KEY },
        recorder(402, '{"error":{"message":"secret detail"}}').fetchImpl,
      ),
      createStripeClient({ secretKey: KEY }, async () => {
        throw new Error('socket hang up');
      }),
      createStripeClient({ secretKey: KEY }, recorder(200, 'not json').fetchImpl),
      createStripeClient({ secretKey: KEY }, recorder(200, '[]').fetchImpl),
      createStripeClient(
        { secretKey: KEY },
        recorder(
          200,
          JSON.stringify({ id: 'cs_test_a1b2c3d4e5f6g7h8', url: 'https://evil.example/pay' }),
        ).fetchImpl,
      ),
      createStripeClient(
        { secretKey: KEY },
        recorder(
          200,
          JSON.stringify({ id: 'cs_test_a1b2c3d4e5f6g7h8', url: 'http://checkout.stripe.com/c' }),
        ).fetchImpl,
      ),
      createStripeClient(
        { secretKey: KEY },
        recorder(200, JSON.stringify({ id: 'bad', url: 'https://checkout.stripe.com/c' }))
          .fetchImpl,
      ),
    ];
    for (const client of attempts) {
      let caught: unknown;
      try {
        await client.createCheckoutSession({
          priceId: 'price_Test00000001',
          accountId: 'a',
          customerId: null,
          customerEmail: null,
          successUrl: 'https://d/s',
          cancelUrl: 'https://d/c',
          idempotencyKey: '0f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
          expiresAtSeconds: 1_800_002_100,
        });
      } catch (error) {
        caught = error;
      }
      expect(
        isDashboardError(caught) &&
          caught.kind === 'unavailable' &&
          caught.code === 'checkout_unavailable',
      ).toBe(true);
      expect(String((caught as Error).message)).not.toContain('secret detail');
    }
  });

  it('recognises a Stripe-hosted https URL and nothing else', () => {
    expect(isStripeHostedUrl('https://checkout.stripe.com/c/pay/cs_x')).toBe(true);
    expect(isStripeHostedUrl('https://billing.stripe.com/p/session?secret=x')).toBe(true);
    expect(isStripeHostedUrl('https://stripe.com/')).toBe(true);
    for (const bad of [
      'https://notstripe.com/x',
      'https://stripe.com.evil.example/x',
      'http://checkout.stripe.com/x',
      'https://user:pw@checkout.stripe.com/x',
      'javascript:alert(1)',
      42,
      null,
      'https://' + 'a'.repeat(2_100) + '.stripe.com/',
    ])
      expect(isStripeHostedUrl(bad)).toBe(false);
  });
});
