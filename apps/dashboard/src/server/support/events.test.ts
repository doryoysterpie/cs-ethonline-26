import { describe, expect, it } from 'vitest';

import { parseStripeEvent, SUBSCRIBED_EVENT_TYPES } from './events.ts';

function envelope(
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id: 'evt_1Test000000000001',
    object: 'event',
    api_version: '2026-09-30.endive',
    created: 1_800_000_000,
    livemode: false,
    type,
    data: { object },
    ...extra,
  });
}

describe('the Stripe event parser', () => {
  it('reads a completed checkout session: the session, the reference, the customer and the subscription', () => {
    const event = parseStripeEvent(
      envelope('checkout.session.completed', {
        id: 'cs_test_a1b2c3d4e5f6g7h8',
        object: 'checkout.session',
        client_reference_id: '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
        customer: 'cus_Test00000001',
        subscription: 'sub_Test00000001',
        status: 'complete',
        customer_details: { email: 'reader@example.org' },
      }),
    );
    expect(event).toEqual({
      id: 'evt_1Test000000000001',
      type: 'checkout.session.completed',
      created: 1_800_000_000,
      livemode: false,
      handled: true,
      sessionId: 'cs_test_a1b2c3d4e5f6g7h8',
      clientReferenceId: '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      customerId: 'cus_Test00000001',
      subscriptionId: 'sub_Test00000001',
      status: null,
    });
    expect(JSON.stringify(event)).not.toContain('example.org');
  });

  it('reads subscription events with their status, a deletion as canceled, and expanded references by id', () => {
    const updated = parseStripeEvent(
      envelope('customer.subscription.updated', {
        id: 'sub_Test00000001',
        object: 'subscription',
        customer: { id: 'cus_Test00000001', object: 'customer' },
        status: 'past_due',
      }),
    );
    expect([updated?.subscriptionId, updated?.customerId, updated?.status]).toEqual([
      'sub_Test00000001',
      'cus_Test00000001',
      'past_due',
    ]);
    const deleted = parseStripeEvent(
      envelope('customer.subscription.deleted', {
        id: 'sub_Test00000001',
        object: 'subscription',
        customer: 'cus_Test00000001',
        status: 'active',
      }),
    );
    expect(deleted?.status).toBe('canceled');
    const unknownStatus = parseStripeEvent(
      envelope('customer.subscription.created', {
        id: 'sub_Test00000001',
        customer: 'cus_Test00000001',
        status: 'something_new',
      }),
    );
    expect(unknownStatus?.status).toBeNull();
  });

  it('reads an invoice with the subscription under either placement and no status', () => {
    const legacy = parseStripeEvent(
      envelope('invoice.paid', {
        id: 'in_1',
        customer: 'cus_Test00000001',
        subscription: 'sub_Test00000001',
      }),
    );
    const current = parseStripeEvent(
      envelope('invoice.payment_failed', {
        id: 'in_2',
        customer: 'cus_Test00000001',
        parent: { subscription_details: { subscription: 'sub_Test00000002' } },
      }),
    );
    expect([legacy?.subscriptionId, legacy?.status, current?.subscriptionId]).toEqual([
      'sub_Test00000001',
      null,
      'sub_Test00000002',
    ]);
  });

  it('records a type outside the subscription as unhandled, with no identifiers read', () => {
    const event = parseStripeEvent(
      envelope('charge.succeeded', { id: 'ch_1', customer: 'cus_Test00000001' }),
    );
    expect(event?.handled).toBe(false);
    expect(event?.customerId).toBeNull();
    expect(SUBSCRIBED_EVENT_TYPES).toHaveLength(6);
  });

  it('refuses anything that is not an event envelope with well-formed identifiers', () => {
    const bad = [
      'not json',
      '[]',
      '{}',
      envelope('invoice.paid', {}, { object: 'charge' }),
      envelope('invoice.paid', {}, { id: 'not-an-event' }),
      envelope('Invoice.Paid', {}),
      envelope('invoice.paid', {}, { created: -1 }),
      envelope('invoice.paid', {}, { created: 1.5 }),
      envelope('invoice.paid', {}, { livemode: 'yes' }),
      JSON.stringify({
        id: 'evt_1Test000000000001',
        object: 'event',
        type: 'invoice.paid',
        created: 1,
        livemode: false,
      }),
      envelope('checkout.session.completed', { id: 'nope' }),
      envelope('customer.subscription.updated', { id: 'cs_wrong_prefix_0001' }),
    ];
    for (const body of bad) expect(parseStripeEvent(body)).toBeNull();
  });
});
