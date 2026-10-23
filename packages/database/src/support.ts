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

/** One subscription's latest status, by the event's own instant. */
export interface SubscriptionState {
  readonly subscriptionId: string | null;
  readonly status: SubscriptionStatus;
  readonly asOf: string;
}

/**
 * The account's standing: the subscription whose latest status ranks best
 * (active or trialing, then past due, then the rest; the latest on a tie),
 * and every subscription's state beside it.
 */
export interface SupporterStatus extends SubscriptionState {
  readonly subscriptions: readonly SubscriptionState[];
}

/**
 * Records the session once; a session already recorded (the provider answered
 * the same idempotent request twice) is left as it is.
 */
export async function insertCheckoutSession(
  client: Queryable,
  session: NewCheckoutSession,
): Promise<void> {
  await client.query(
    `INSERT INTO checkout_sessions (id, account_id, created_at) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    [session.id, session.accountId, session.createdAt],
  );
}

// ---------------------------------------------------------------- checkout attempts (migration 0020)

/**
 * One hand-off in progress for an account (train review F7): the idempotency
 * key every request to the provider reuses until the attempt closes, the
 * session and its address once the provider answered, and the instant the
 * attempt closes, at its expiry or when its session completes.
 */
export interface CheckoutAttemptRecord {
  readonly id: string;
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sessionId: string | null;
  readonly url: string | null;
  readonly closedAt: string | null;
}

export type NewCheckoutAttempt = Pick<
  CheckoutAttemptRecord,
  'id' | 'accountId' | 'idempotencyKey' | 'createdAt' | 'expiresAt'
>;

const ATTEMPT_COLUMNS = `id, account_id, idempotency_key,
  to_json(created_at) #>> '{}' AS created_at, to_json(expires_at) #>> '{}' AS expires_at,
  session_id, url, to_json(closed_at) #>> '{}' AS closed_at`;

interface AttemptRow {
  id: string;
  account_id: string;
  idempotency_key: string;
  created_at: string;
  expires_at: string;
  session_id: string | null;
  url: string | null;
  closed_at: string | null;
}

function toAttempt(row: AttemptRow): CheckoutAttemptRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sessionId: row.session_id,
    url: row.url,
    closedAt: row.closed_at,
  };
}

/** Closes the account's open attempt when it is past its expiry at `now`; returns how many closed. */
export async function closeExpiredCheckoutAttempts(
  client: Queryable,
  accountId: string,
  now: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE checkout_attempts SET closed_at = $2::timestamptz
      WHERE account_id = $1 AND closed_at IS NULL AND expires_at <= $2::timestamptz`,
    [accountId, now],
  );
  return result.rowCount ?? 0;
}

/** The account's open attempt, locked for the caller's transaction, or null. */
export async function lockOpenCheckoutAttempt(
  client: Queryable,
  accountId: string,
): Promise<CheckoutAttemptRecord | null> {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM checkout_attempts
      WHERE account_id = $1 AND closed_at IS NULL FOR UPDATE`,
    [accountId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toAttempt(row);
}

/** Opens an attempt; `open_exists` when the account has one open already. */
export async function insertCheckoutAttempt(
  client: Queryable,
  attempt: NewCheckoutAttempt,
): Promise<'inserted' | 'open_exists'> {
  const result = await client.query(
    `INSERT INTO checkout_attempts (id, account_id, idempotency_key, created_at, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
     ON CONFLICT (account_id) WHERE closed_at IS NULL DO NOTHING`,
    [attempt.id, attempt.accountId, attempt.idempotencyKey, attempt.createdAt, attempt.expiresAt],
  );
  return result.rowCount === 1 ? 'inserted' : 'open_exists';
}

/** Binds the provider's answer to the attempt, once. */
export async function bindCheckoutAttempt(
  client: Queryable,
  id: string,
  session: { readonly sessionId: string; readonly url: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE checkout_attempts SET session_id = $2, url = $3
      WHERE id = $1 AND session_id IS NULL AND closed_at IS NULL`,
    [id, session.sessionId, session.url],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Closes the attempt bound to a session that completed; returns how many closed. */
export async function closeCheckoutAttemptForSession(
  client: Queryable,
  sessionId: string,
  now: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE checkout_attempts SET closed_at = $2::timestamptz
      WHERE session_id = $1 AND closed_at IS NULL`,
    [sessionId, now],
  );
  return result.rowCount ?? 0;
}

export async function listCheckoutAttempts(
  client: Queryable,
  accountId: string,
): Promise<CheckoutAttemptRecord[]> {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM checkout_attempts WHERE account_id = $1 ORDER BY created_at, id`,
    [accountId],
  );
  return result.rows.map(toAttempt);
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
 * The events that belong to an account: those bound to it directly, and
 * those naming a subscription or a customer that any event bound to it
 * (train review F6), so a status delivered before the binding event counts
 * once the binding lands; the ledger itself is never rewritten.
 */
const BOUND_EVENTS = `
  WITH own AS (
    SELECT subscription_id, customer_id FROM supporter_events WHERE account_id = $1
  )
  SELECT e.subscription_id, e.status,
         to_json(e.occurred_at) #>> '{}' AS occurred_at, e.received_at
    FROM supporter_events e
   WHERE e.status IS NOT NULL AND (
         e.account_id = $1
      OR (e.subscription_id IS NOT NULL
          AND e.subscription_id IN (SELECT subscription_id FROM own WHERE subscription_id IS NOT NULL))
      OR (e.customer_id IS NOT NULL
          AND e.customer_id IN (SELECT customer_id FROM own WHERE customer_id IS NOT NULL)))`;

/**
 * The supporter status of an account, one state per subscription (train
 * review F7): each subscription's latest status by the event's own instant,
 * then by arrival; the account's standing is the best of them, so a second
 * subscription that is still billing is never hidden by the cancellation of
 * another. Null when no event carried a status.
 */
export async function supporterStatus(
  client: Queryable,
  accountId: string,
): Promise<SupporterStatus | null> {
  const result = await client.query<{
    subscription_id: string | null;
    status: SubscriptionStatus;
    occurred_at: string;
  }>(
    `SELECT subscription_id, status, occurred_at FROM (
       SELECT DISTINCT ON (COALESCE(subscription_id, '')) subscription_id, status, occurred_at
         FROM (${BOUND_EVENTS}) bound
        ORDER BY COALESCE(subscription_id, ''), occurred_at DESC, received_at DESC
     ) latest
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'trialing' THEN 0 WHEN 'past_due' THEN 1 ELSE 2 END,
              occurred_at DESC`,
    [accountId],
  );
  const subscriptions = result.rows.map((row) => ({
    subscriptionId: row.subscription_id,
    status: row.status,
    asOf: row.occurred_at,
  }));
  const best = subscriptions[0];
  return best === undefined ? null : { ...best, subscriptions };
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
