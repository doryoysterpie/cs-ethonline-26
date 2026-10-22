import 'server-only';

import type { SubscriptionStatus } from '@cas/database';

/**
 * The Stripe events the webhook endpoint subscribes to (CAS-008, report
 * section 1.2), parsed from a verified body into the few fields the
 * supporter record keeps. Every identifier is shape-checked; anything else
 * in the body is ignored and never stored. An event of a type outside the
 * subscription is still a valid event: it is recorded by identifier, marked
 * unhandled, and changes no status.
 */
export const SUBSCRIBED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;
export type SubscribedEventType = (typeof SUBSCRIBED_EVENT_TYPES)[number];

const EVENT_ID = /^evt_[A-Za-z0-9_]{8,200}$/u;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{2,79}$/u;
const SESSION_ID = /^cs_[A-Za-z0-9_]{8,200}$/u;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{8,200}$/u;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{8,200}$/u;
const REFERENCE = /^[A-Za-z0-9_-]{1,200}$/u;
const STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
];

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  /** Stripe's `created`, unix seconds. */
  readonly created: number;
  readonly livemode: boolean;
  /** True for a subscribed type; false for a type recorded but not acted on. */
  readonly handled: boolean;
  readonly sessionId: string | null;
  readonly clientReferenceId: string | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly status: SubscriptionStatus | null;
}

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A Stripe reference: the identifier string, or the `id` of an expanded object, or null. */
function reference(value: unknown, shape: RegExp): string | null {
  const id = typeof value === 'string' ? value : record(value)?.['id'];
  return typeof id === 'string' && shape.test(id) ? id : null;
}

function status(value: unknown): SubscriptionStatus | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : null;
}

export function isSubscribedType(type: string): type is SubscribedEventType {
  return (SUBSCRIBED_EVENT_TYPES as readonly string[]).includes(type);
}

/** Null for anything that is not a Stripe event envelope with well-formed identifiers. */
export function parseStripeEvent(body: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const envelope = record(parsed);
  if (envelope === null || envelope['object'] !== 'event') return null;
  const id = envelope['id'];
  const type = envelope['type'];
  const created = envelope['created'];
  const livemode = envelope['livemode'];
  if (typeof id !== 'string' || !EVENT_ID.test(id)) return null;
  if (typeof type !== 'string' || !EVENT_TYPE.test(type)) return null;
  if (typeof created !== 'number' || !Number.isInteger(created) || created <= 0) return null;
  if (typeof livemode !== 'boolean') return null;
  const object = record(record(envelope['data'])?.['object']);
  if (object === null) return null;

  const base = {
    id,
    type,
    created,
    livemode,
    sessionId: null,
    clientReferenceId: null,
    customerId: null,
    subscriptionId: null,
    status: null,
  };
  if (!isSubscribedType(type)) return { ...base, handled: false };
  switch (type) {
    case 'checkout.session.completed': {
      const sessionId = reference(object['id'], SESSION_ID);
      if (sessionId === null) return null;
      const clientReferenceId = object['client_reference_id'];
      return {
        ...base,
        handled: true,
        sessionId,
        clientReferenceId:
          typeof clientReferenceId === 'string' && REFERENCE.test(clientReferenceId)
            ? clientReferenceId
            : null,
        customerId: reference(object['customer'], CUSTOMER_ID),
        subscriptionId: reference(object['subscription'], SUBSCRIPTION_ID),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = reference(object['id'], SUBSCRIPTION_ID);
      if (subscriptionId === null) return null;
      return {
        ...base,
        handled: true,
        subscriptionId,
        customerId: reference(object['customer'], CUSTOMER_ID),
        // A deletion ends the subscription whatever status the object carries.
        status: type === 'customer.subscription.deleted' ? 'canceled' : status(object['status']),
      };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // The subscription moved under `parent.subscription_details` in the
      // 2025 major versions; both placements are read.
      const details = record(record(object['parent'])?.['subscription_details']);
      return {
        ...base,
        handled: true,
        customerId: reference(object['customer'], CUSTOMER_ID),
        subscriptionId:
          reference(object['subscription'], SUBSCRIPTION_ID) ??
          reference(details?.['subscription'], SUBSCRIPTION_ID),
      };
    }
    default:
      return { ...base, handled: false };
  }
}
