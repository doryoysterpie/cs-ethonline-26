import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  accountForCheckoutSession,
  accountForCustomer,
  accountForSubscription,
  customerForAccount,
  insertCheckoutSession,
  insertSupporterEvent,
  listSupporterEvents,
  supporterStatus,
} from './support.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

async function expectRejected(
  db: Database,
  attempt: (tx: Queryable) => Promise<unknown>,
): Promise<string> {
  let caught: unknown;
  try {
    await db.withTransaction(async (tx) => {
      await attempt(tx);
    });
  } catch (error) {
    caught = error;
  }
  expect(isDatabaseError(caught), 'PostgreSQL must reject the contradiction').toBe(true);
  if (!isDatabaseError(caught)) throw new Error('unreachable');
  return caught.code ?? '';
}

describe('checkout sessions and supporter events (migration 0018)', () => {
  let isolated: IsolatedSchema;
  let reader: string;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    reader = randomUUID();
    await isolated.db.withTransaction((tx) =>
      tx.query(
        `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at, expires_at)
         VALUES ($1, 'reader_account', 'reader', 'synthetic-not-a-credential', now(), now(), now() + interval '1 year')`,
        [reader],
      ),
    );
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('binds a checkout session to its account, append-only, with the provider shape', async () => {
    const session = {
      id: 'cs_test_a1b2c3d4e5f6',
      accountId: reader,
      createdAt: new Date().toISOString(),
    };
    await isolated.db.withTransaction((tx) => insertCheckoutSession(tx, session));
    expect(await isolated.db.withClient((c) => accountForCheckoutSession(c, session.id))).toBe(
      reader,
    );
    expect(
      await isolated.db.withClient((c) => accountForCheckoutSession(c, 'cs_test_unknown000')),
    ).toBeNull();
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertCheckoutSession(tx, { ...session, id: 'not-a-session' }),
      ),
    ).toBe('23514');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE checkout_sessions SET account_id = $1`, [reader]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) => tx.query(`DELETE FROM checkout_sessions`)),
    ).toBe('P0001');
  });

  it('records each event once, refuses a replay, derives the status by the event instant, and never rewrites', async () => {
    const event = (
      n: number,
      status: 'active' | 'canceled' | 'past_due' | null,
      occurredAt: string,
      receivedAt: string,
    ) => ({
      id: randomUUID(),
      provider: 'stripe' as const,
      eventId: `evt_test_${String(n).padStart(10, '0')}`,
      eventType: status === null ? 'invoice.paid' : 'customer.subscription.updated',
      occurredAt,
      receivedAt,
      accountId: reader,
      customerId: 'cus_test_c1d2e3f4',
      subscriptionId: 'sub_test_s1t2u3v4',
      status,
      payloadDigest: hash(String(n % 10)),
    });
    // The cancellation arrives first, then the earlier activation: the status is canceled.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSupporterEvent(
          tx,
          event(1, 'canceled', '2026-10-22T12:00:00.000Z', '2026-10-22T12:00:01.000Z'),
        ),
      ),
    ).toBe('inserted');
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSupporterEvent(
          tx,
          event(2, 'active', '2026-10-22T11:00:00.000Z', '2026-10-22T12:00:02.000Z'),
        ),
      ),
    ).toBe('inserted');
    expect(await isolated.db.withClient((c) => supporterStatus(c, reader))).toEqual({
      status: 'canceled',
      subscriptionId: 'sub_test_s1t2u3v4',
      asOf: '2026-10-22T12:00:00+00:00',
    });
    // A replay of either identifier changes nothing.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSupporterEvent(tx, {
          ...event(2, 'past_due', '2026-10-22T13:00:00.000Z', '2026-10-22T13:00:00.000Z'),
          id: randomUUID(),
        }),
      ),
    ).toBe('replay');
    expect((await isolated.db.withClient((c) => listSupporterEvents(c, reader, 10))).length).toBe(
      2,
    );
    // An event without a status (an invoice) binds the customer but does not change the status.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSupporterEvent(
          tx,
          event(3, null, '2026-10-22T14:00:00.000Z', '2026-10-22T14:00:00.000Z'),
        ),
      ),
    ).toBe('inserted');
    expect((await isolated.db.withClient((c) => supporterStatus(c, reader)))?.status).toBe(
      'canceled',
    );
    expect(
      await isolated.db.withClient((c) => accountForSubscription(c, 'sub_test_s1t2u3v4')),
    ).toBe(reader);
    expect(await isolated.db.withClient((c) => accountForCustomer(c, 'cus_test_c1d2e3f4'))).toBe(
      reader,
    );
    expect(
      await isolated.db.withClient((c) => accountForCustomer(c, 'cus_test_unknown0')),
    ).toBeNull();
    expect(await isolated.db.withClient((c) => customerForAccount(c, reader))).toBe(
      'cus_test_c1d2e3f4',
    );
    expect(await isolated.db.withClient((c) => customerForAccount(c, randomUUID()))).toBeNull();
    // A replay inside one transaction leaves the transaction usable.
    expect(
      await isolated.db.withTransaction(async (tx) => {
        const first = await insertSupporterEvent(
          tx,
          event(2, 'active', '2026-10-22T13:30:00.000Z', '2026-10-22T13:30:00.000Z'),
        );
        const count = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM supporter_events`,
        );
        return `${first}:${count.rows[0]?.n ?? ''}`;
      }),
    ).toBe('replay:3');
    // A later reactivation by its own instant wins.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSupporterEvent(
          tx,
          event(4, 'active', '2026-10-22T15:00:00.000Z', '2026-10-22T15:00:00.000Z'),
        ),
      ),
    ).toBe('inserted');
    expect((await isolated.db.withClient((c) => supporterStatus(c, reader)))?.status).toBe(
      'active',
    );
    // Shapes and immutability.
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertSupporterEvent(tx, {
          ...event(5, 'active', '2026-10-22T16:00:00.000Z', '2026-10-22T16:00:00.000Z'),
          eventId: 'nope',
        }),
      ),
    ).toBe('23514');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertSupporterEvent(tx, {
          ...event(6, 'active', '2026-10-22T16:00:00.000Z', '2026-10-22T16:00:00.000Z'),
          payloadDigest: 'short',
        }),
      ),
    ).toBe('23514');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE supporter_events SET status = 'active'`),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) => tx.query(`DELETE FROM supporter_events`)),
    ).toBe('P0001');
    for (const kind of ['checkout_started', 'webhook_received', 'supporter_changed']) {
      await isolated.db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO audit_events (id, at, kind, outcome, code, actor_account_id, subject_account_id, session_id, network_key, subject_id)
           VALUES ($1, now(), $2, 'success', 'active', $3, NULL, NULL, NULL, NULL)`,
          [randomUUID(), kind, reader],
        ),
      );
    }
  });
});
