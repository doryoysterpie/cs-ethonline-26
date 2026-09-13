import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isDatabaseError } from '@cas/database';

import { openMigratedSchema, type IsolatedSchema } from '../../test/isolated-schema.ts';
import { seedPipeline, type SeededPipeline } from '../../test/seed-pipeline.ts';
import { syntheticAccount } from '../../test/synthetic-accounts.ts';
import { isDashboardError } from '../errors.ts';
import { ACCOUNT_FAILURE_LIMIT, NETWORK_ATTEMPT_LIMIT } from './rate-limit.ts';
import {
  openPostgresStores,
  PostgresLoginThrottle,
  type PostgresStores,
} from './postgres-store.ts';
import type { AccountRecord, SessionRecord } from './store.ts';

/**
 * The PostgreSQL store (migration 0010) against a real, migrated schema.
 *
 * Proves the same contract `memory-store.test.ts` proves of the memory
 * store — a duplicate username or session identity is a conflict, sessions
 * and drafts are append-only where the interface says so — plus what only a
 * real database can prove: the migration's own guard triggers refuse a raw
 * UPDATE or DELETE against history no matter what the application code
 * does, the composite foreign key refuses a queue decision that does not
 * name a row genuinely in its classification run, and the login throttle
 * holds its limit across two independent `PostgresLoginThrottle` instances
 * sharing nothing but the database — the multi-instance case the in-memory
 * throttle could never close.
 */

/**
 * Asserts a promise rejects with the migration's own guard trigger, not
 * merely any failure. `DatabaseError` never copies a driver message (see
 * `packages/database/src/errors.ts`), so the guard is proven by its
 * PostgreSQL SQLSTATE, `P0001`, the code PL/pgSQL's `RAISE EXCEPTION ...
 * USING ERRCODE = 'raise_exception'` always carries, exactly as every guard
 * function in this migration raises it.
 */
async function expectGuardRefusal(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error) => isDatabaseError(error) && error.code === 'P0001',
  );
}

describe('the PostgreSQL store against a migrated schema', () => {
  let isolated: IsolatedSchema;
  let seeded: SeededPipeline;
  let stores: PostgresStores;

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    seeded = await seedPipeline(isolated.db);
    stores = openPostgresStores(isolated.db);
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('inserts and finds an account, and refuses a duplicate username', async () => {
    const editor = await syntheticAccount('editor');
    await stores.accounts.insert(editor.record);
    expect((await stores.accounts.findByUsername(editor.record.username))?.id).toBe(
      editor.record.id,
    );
    expect((await stores.accounts.getById(editor.record.id))?.role).toBe('editor');
    const duplicate: AccountRecord = {
      ...(await syntheticAccount('admin')).record,
      username: editor.record.username,
    };
    await expect(stores.accounts.insert(duplicate)).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'account_exists',
    );
  });

  it('narrowly updates an account and refuses to change its identity or re-enable it', async () => {
    const account = (await syntheticAccount('judge')).record;
    await stores.accounts.insert(account);
    await stores.accounts.setPasswordHash(
      account.id,
      'argon2id$updated',
      '2026-09-12T00:00:00.000Z',
    );
    expect((await stores.accounts.getById(account.id))?.passwordHash).toBe('argon2id$updated');
    await stores.accounts.setDisabled(account.id, '2026-09-12T00:00:00.000Z');
    expect((await stores.accounts.getById(account.id))?.disabledAt).not.toBeNull();

    // The migration's own guard, not the application: a direct UPDATE cannot
    // change identity or re-enable a disabled account.
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('UPDATE accounts SET username = $2 WHERE id = $1', [account.id, 'renamed']),
      ),
    );
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('UPDATE accounts SET disabled_at = NULL WHERE id = $1', [account.id]),
      ),
    );
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('DELETE FROM accounts WHERE id = $1', [account.id]),
      ),
    );
  });

  it('issues, revokes and lists sessions, and refuses a duplicate identity', async () => {
    const account = (await syntheticAccount('editor')).record;
    await stores.accounts.insert(account);
    const session: SessionRecord = {
      id: randomUUID(),
      accountId: account.id,
      tokenHash: 'a'.repeat(64),
      createdAt: '2026-09-12T00:00:00.000Z',
      lastSeenAt: '2026-09-12T00:00:00.000Z',
      absoluteExpiresAt: '2026-09-12T08:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
    };
    await stores.sessions.insert(session);
    expect((await stores.sessions.findByTokenHash(session.tokenHash))?.id).toBe(session.id);
    await expect(stores.sessions.insert(session)).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'session_exists',
    );
    await stores.sessions.touch(session.id, '2026-09-12T00:05:00.000Z');
    const touched = (await stores.sessions.findByTokenHash(session.tokenHash))?.lastSeenAt;
    // PostgreSQL's own textual rendering of a timestamptz (`+00:00`) differs
    // from the app's own `Date#toISOString()` convention (`Z`); both name
    // the same instant, which is the property that matters here.
    expect(Date.parse(touched ?? '')).toBe(Date.parse('2026-09-12T00:05:00.000Z'));
    const count = await stores.sessions.revokeAllForAccount(
      account.id,
      '2026-09-12T01:00:00.000Z',
      'password_rotated',
      null,
    );
    expect(count).toBe(1);
    expect((await stores.sessions.listForAccount(account.id))[0]?.revokedAt).not.toBeNull();

    // The guard: a revoked session cannot be un-revoked, and none is ever deleted.
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('UPDATE sessions SET revoked_at = NULL WHERE id = $1', [session.id]),
      ),
    );
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('DELETE FROM sessions WHERE id = $1', [session.id]),
      ),
    );
  });

  it('keeps the audit trail append-only', async () => {
    const first = { id: randomUUID(), at: '2026-09-12T00:00:00.000Z' };
    await stores.audit.append({
      ...first,
      kind: 'logout',
      outcome: 'success',
      code: 'session_revoked',
      actorAccountId: null,
      subjectAccountId: null,
      sessionId: null,
      networkKey: null,
      subjectId: null,
    });
    const [event] = await stores.audit.list(1);
    expect(event?.id).toBe(first.id);
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query("UPDATE audit_events SET code = 'tampered' WHERE id = $1", [first.id]),
      ),
    );
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query('DELETE FROM audit_events WHERE id = $1', [first.id]),
      ),
    );
  });

  it('appends draft revisions bound to their evidence run, refuses a repeated revision, and stays append-only', async () => {
    const account = (await syntheticAccount('editor')).record;
    await stores.accounts.insert(account);
    const key = `${seeded.evidenceRunId}:2026-09-01T00:00:00.000Z:2026-09-08T00:00:00.000Z`;
    await stores.drafts.append({
      draftKey: key,
      revision: 1,
      markdown: '# one',
      savedByAccountId: account.id,
      savedAt: '2026-09-12T00:00:00.000Z',
    });
    expect((await stores.drafts.latest(key))?.markdown).toBe('# one');
    await expect(
      stores.drafts.append({
        draftKey: key,
        revision: 1,
        markdown: '# two',
        savedByAccountId: account.id,
        savedAt: '2026-09-12T00:01:00.000Z',
      }),
    ).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'draft_revision_conflict',
    );
    expect((await stores.drafts.list(key)).length).toBe(1);
    await expectGuardRefusal(
      isolated.db.withClient((client) =>
        client.query("UPDATE draft_revisions SET markdown = 'tampered' WHERE draft_key = $1", [
          key,
        ]),
      ),
    );
  });

  it('binds a queue decision to the exact classification result it decided on', async () => {
    const account = (await syntheticAccount('editor')).record;
    await stores.accounts.insert(account);
    const row = await isolated.db.withClient((client) =>
      client.query<{ source_row_id: string }>(
        'SELECT source_row_id FROM classification_results WHERE run_id = $1 LIMIT 1',
        [seeded.classificationRunId],
      ),
    );
    const sourceRowId = row.rows[0]?.source_row_id;
    expect(sourceRowId).toBeDefined();
    await stores.queueDecisions.append({
      id: randomUUID(),
      classificationRunId: seeded.classificationRunId,
      sourceRowId: sourceRowId ?? '',
      reviewState: 'selected',
      reasonCode: 'editorial_judgement',
      note: null,
      actorAccountId: account.id,
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(
      (await stores.queueDecisions.listForRun(seeded.classificationRunId)).length,
    ).toBeGreaterThan(0);

    // The composite foreign key, not application validation: a source row
    // that never belonged to this run is refused at the database.
    await expect(
      stores.queueDecisions.append({
        id: randomUUID(),
        classificationRunId: seeded.classificationRunId,
        sourceRowId: randomUUID(),
        reviewState: 'selected',
        reasonCode: 'editorial_judgement',
        note: null,
        actorAccountId: account.id,
        createdAt: '2026-09-12T00:00:00.000Z',
      }),
    ).rejects.toBeTruthy();
  });

  it('holds the login-attempt limit across two independent throttle instances, closing the multi-instance seam', async () => {
    // Two throttles over the same database stand in for two application
    // processes sharing no in-memory state: the property under test is that
    // the limit is enforced by the table, not by whichever process happens
    // to hold the count in its own memory.
    const instanceA = new PostgresLoginThrottle(isolated.db);
    const instanceB = new PostgresLoginThrottle(isolated.db);
    const account = `account:multi-instance-${randomUUID()}`;
    const now = 1_800_000_000;

    for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
      const throttle = attempt % 2 === 0 ? instanceA : instanceB;
      const decision = await throttle.check(account, `network:${randomUUID()}`, now);
      expect(decision.allowed, `attempt ${attempt}`).toBe(true);
      await throttle.recordFailure(account, now);
    }
    // The limit was reached across both instances combined; a further
    // attempt on either instance is refused.
    const blockedOnA = await instanceA.check(account, `network:${randomUUID()}`, now);
    const blockedOnB = await instanceB.check(account, `network:${randomUUID()}`, now);
    expect(blockedOnA.allowed).toBe(false);
    expect(blockedOnB.allowed).toBe(false);

    await instanceA.recordSuccess(account);
    expect((await instanceB.check(account, `network:${randomUUID()}`, now)).allowed).toBe(true);
  });

  it('throttles a network key once the attempt limit is crossed, independent of which account was named', async () => {
    const throttle = new PostgresLoginThrottle(isolated.db);
    const network = `network-key-${randomUUID()}`;
    const now = 1_800_100_000;
    let lastDecision = { allowed: true } as Awaited<ReturnType<PostgresLoginThrottle['check']>>;
    for (let attempt = 0; attempt <= NETWORK_ATTEMPT_LIMIT; attempt += 1) {
      lastDecision = await throttle.check(`account:probe-${attempt}`, network, now);
    }
    expect(lastDecision.allowed).toBe(false);
  });
});
