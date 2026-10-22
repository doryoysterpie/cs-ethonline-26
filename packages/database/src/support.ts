import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * The supporter tier (CAS-008, migration 0018): each hosted-checkout hand-off
 * bound to its account, every webhook event recorded once by its provider
 * identifier, and the supporter status derived from the events by the
 * instant they occurred, never by the order they arrived.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export interface NewCheckoutSession {
  readonly id: string;
  readonly accountId: string;
  readonly createdAt: string;
}

export interface NewSupporterEvent {
  readonly id: string;
  readonly provider: 'stripe';
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly accountId: string | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly status: SubscriptionStatus | null;
  /** SHA-256 of the raw body; the body is never stored. */
  readonly payloadDigest: string;
}

export type SupporterEventRecord = NewSupporterEvent;

export interface SupporterStatus {
  readonly status: SubscriptionStatus;
  readonly subscriptionId: string | null;
  readonly asOf: string;
}

export async function insertCheckoutSession(
  client: Queryable,
  session: NewCheckoutSession,
): Promise<void> {
  await client.query(
    `INSERT INTO checkout_sessions (id, account_id, created_at) VALUES ($1, $2, $3::timestamptz)`,
    [session.id, session.accountId, session.createdAt],
  );
}

export async function accountForCheckoutSession(
  client: Queryable,
  sessionId: string,
): Promise<string | null> {
  const result = await client.query<{ account_id: string }>(
    `SELECT account_id FROM checkout_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0]?.account_id ?? null;
}

const EVENT_COLUMNS = `id, provider, event_id, event_type,
  to_json(occurred_at) #>> '{}' AS occurred_at, to_json(received_at) #>> '{}' AS received_at,
  account_id, customer_id, subscription_id, status, payload_digest`;

interface EventRow {
  id: string;
  provider: 'stripe';
  event_id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  account_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  status: SubscriptionStatus | null;
  payload_digest: string;
}

function toEvent(row: EventRow): SupporterEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    accountId: row.account_id,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    status: row.status,
    payloadDigest: row.payload_digest,
  };
}

/**
 * Records an event once; `replay` when its provider identifier was recorded
 * before. The conflict is absorbed by the statement itself rather than caught,
 * so a replay inside a transaction leaves the transaction usable.
 */
export async function insertSupporterEvent(
  client: Queryable,
  event: NewSupporterEvent,
): Promise<'inserted' | 'replay'> {
  const result = await client.query(
    `INSERT INTO supporter_events (id, provider, event_id, event_type, occurred_at, received_at,
       account_id, customer_id, subscription_id, status, payload_digest)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11)
     ON CONFLICT ON CONSTRAINT supporter_events_event_unique DO NOTHING`,
    [
      event.id,
      event.provider,
      event.eventId,
      event.eventType,
      event.occurredAt,
      event.receivedAt,
      event.accountId,
      event.customerId,
      event.subscriptionId,
      event.status,
      event.payloadDigest,
    ],
  );
  return result.rowCount === 1 ? 'inserted' : 'replay';
}

/** The provider customer an account was last bound to, for the hosted billing portal. */
export async function customerForAccount(
  client: Queryable,
  accountId: string,
): Promise<string | null> {
  const result = await client.query<{ customer_id: string }>(
    `SELECT customer_id FROM supporter_events
      WHERE account_id = $1 AND customer_id IS NOT NULL
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1`,
    [accountId],
  );
  return result.rows[0]?.customer_id ?? null;
}

/** The account a subscription or customer was last bound to, if any event bound it. */
export async function accountForSubscription(
  client: Queryable,
  subscriptionId: string,
): Promise<string | null> {
  const result = await client.query<{ account_id: string }>(
    `SELECT account_id FROM supporter_events
      WHERE subscription_id = $1 AND account_id IS NOT NULL
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1`,
    [subscriptionId],
  );
  return result.rows[0]?.account_id ?? null;
}

export async function accountForCustomer(
  client: Queryable,
  customerId: string,
): Promise<string | null> {
  const result = await client.query<{ account_id: string }>(
    `SELECT account_id FROM supporter_events
      WHERE customer_id = $1 AND account_id IS NOT NULL
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1`,
    [customerId],
  );
  return result.rows[0]?.account_id ?? null;
}

/**
 * The supporter status of an account: the status carried by its most recent
 * subscription event by the event's own instant, then by arrival. Null when
 * no event carried a status.
 */
export async function supporterStatus(
  client: Queryable,
  accountId: string,
): Promise<SupporterStatus | null> {
  const result = await client.query<{
    status: SubscriptionStatus;
    subscription_id: string | null;
    occurred_at: string;
  }>(
    `SELECT status, subscription_id, to_json(occurred_at) #>> '{}' AS occurred_at
       FROM supporter_events
      WHERE account_id = $1 AND status IS NOT NULL
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1`,
    [accountId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { status: row.status, subscriptionId: row.subscription_id, asOf: row.occurred_at };
}

export async function listSupporterEvents(
  client: Queryable,
  accountId: string,
  limit: number,
): Promise<SupporterEventRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new DatabaseError('query', 'limit out of range');
  }
  const result = await client.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM supporter_events WHERE account_id = $1
      ORDER BY occurred_at DESC, received_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return result.rows.map(toEvent);
}
