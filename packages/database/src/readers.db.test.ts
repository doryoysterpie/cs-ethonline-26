import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertArticleRevision } from './article.js';
import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  currentPublication,
  decideSignupRequest,
  findOpenSignupRequest,
  getSignupRequest,
  insertPublication,
  insertSignupRequest,
  lockSignupRequest,
  listPendingSignupRequests,
  listPublished,
  recordSignupAttempt,
  verifySignupRequest,
} from './readers.js';
import { insertRoundupRevision } from './roundup.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';
import { completeWeekRun, insertRunningWeekRun, type NewWeekRun } from './week.js';

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

describe('reader sign-up requests and the published mark (migration 0017)', () => {
  let isolated: IsolatedSchema;
  let admin: string;
  let owner: string;
  let weekRunId: string;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    admin = randomUUID();
    owner = randomUUID();
    await isolated.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at)
         VALUES ($1, 'admin_account', 'admin', 'synthetic-not-a-credential', now(), now()),
                ($2, 'owner_account', 'owner', 'synthetic-not-a-credential', now(), now())`,
        [admin, owner],
      );
      await tx.query(
        `INSERT INTO import_batches (
           id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
           header_cells, importer_version, idempotency_key, status, parsed_row_count,
           accepted_row_count, quarantined_row_count, started_at, completed_at
         ) VALUES ($1, 'replay', 'master', NULL, 'week.csv', $2, 10, '["ch"]'::jsonb,
                   'editorial-csv-import@1', $3, 'completed', 0, 0, 0, now(), now())`,
        [randomUUID(), hash('d'), hash('e')],
      );
    });
    const batch = await isolated.db.withClient((c) =>
      c.query<{ id: string }>(`SELECT id FROM import_batches LIMIT 1`),
    );
    const run: NewWeekRun = {
      id: randomUUID(),
      dataOrigin: 'replay',
      batchId: batch.rows[0]?.id ?? '',
      timeZone: 'America/Toronto',
      windowStart: '2026-10-18T03:59:00.000Z',
      windowEnd: '2026-10-25T03:59:00.000Z',
      publicationCutoffAt: '2026-10-26T03:59:00.000Z',
      categories: ['cyberattack'],
      idempotencyKey: hash('f'),
      startedAt: new Date().toISOString(),
    };
    weekRunId = run.id;
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    await isolated.db.withTransaction((tx) =>
      completeWeekRun(tx, run.id, 'completed', new Date().toISOString(), null),
    );
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('retired judge into reader: the role check admits reader, requires its expiry, and refuses judge', async () => {
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO accounts (id, normalized_email, role, created_at, password_changed_at)
           VALUES ($1, 'judge@example.org', 'judge', now(), now())`,
          [randomUUID()],
        ),
      ),
    ).toBe('23514');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO accounts (id, normalized_email, role, created_at, password_changed_at)
           VALUES ($1, 'reader@example.org', 'reader', now(), now())`,
          [randomUUID()],
        ),
      ),
    ).toBe('23514');
    await isolated.db.withTransaction((tx) =>
      tx.query(
        `INSERT INTO accounts (id, normalized_email, role, created_at, password_changed_at, expires_at)
         VALUES ($1, 'reader@example.org', 'reader', now(), now(), now() + interval '1 year')`,
        [randomUUID()],
      ),
    );
  });

  it('moves a request one way: requested, verified once, decided once; one open request per address', async () => {
    const request = {
      id: randomUUID(),
      normalizedEmail: 'someone@example.org',
      codeDigest: hash('1'),
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    expect(await isolated.db.withTransaction((tx) => insertSignupRequest(tx, request))).toBe(
      'inserted',
    );
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSignupRequest(tx, { ...request, id: randomUUID(), codeDigest: hash('2') }),
      ),
    ).toBe('open_exists');
    expect(
      (await isolated.db.withClient((c) => findOpenSignupRequest(c, request.normalizedEmail)))?.id,
    ).toBe(request.id);
    // A decision before verification is refused by the table, not by the code alone.
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `UPDATE signup_requests SET decided_at = now(), decision = 'denied', decided_by = $2 WHERE id = $1`,
          [request.id, admin],
        ),
      ),
    ).toBe('23514');
    expect(
      await isolated.db.withTransaction((tx) =>
        decideSignupRequest(tx, {
          id: request.id,
          decision: 'denied',
          decidedBy: admin,
          accountId: null,
          at: new Date().toISOString(),
        }),
      ),
    ).toBe(false);
    // Wrong codes count up and never down.
    expect(
      (await isolated.db.withTransaction((tx) => recordSignupAttempt(tx, request.id)))
        ?.attemptCount,
    ).toBe(1);
    expect(
      (await isolated.db.withTransaction((tx) => recordSignupAttempt(tx, request.id)))
        ?.attemptCount,
    ).toBe(2);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET attempt_count = 0 WHERE id = $1`, [request.id]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET code_digest = $2 WHERE id = $1`, [
          request.id,
          hash('9'),
        ]),
      ),
    ).toBe('P0001');
    // Verified once.
    const verifiedAt = new Date().toISOString();
    expect(
      await isolated.db.withTransaction((tx) => verifySignupRequest(tx, request.id, verifiedAt)),
    ).toBe(true);
    expect(
      await isolated.db.withTransaction((tx) =>
        verifySignupRequest(tx, request.id, new Date().toISOString()),
      ),
    ).toBe(false);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET verified_at = NULL WHERE id = $1`, [request.id]),
      ),
    ).toBe('P0001');
    const pending = await isolated.db.withClient((c) => listPendingSignupRequests(c, 10));
    expect(pending.map((r) => r.id)).toEqual([request.id]);
    // Approved once, with the account it created; never redecided; never deleted.
    const reader = randomUUID();
    await isolated.db.withTransaction((tx) =>
      tx.query(
        `INSERT INTO accounts (id, normalized_email, role, created_at, password_changed_at, expires_at)
         VALUES ($1, $2, 'reader', now(), now(), now() + interval '1 year')`,
        [reader, request.normalizedEmail],
      ),
    );
    expect(
      await isolated.db.withTransaction((tx) =>
        decideSignupRequest(tx, {
          id: request.id,
          decision: 'approved',
          decidedBy: admin,
          accountId: reader,
          at: new Date().toISOString(),
        }),
      ),
    ).toBe(true);
    expect(
      await isolated.db.withTransaction((tx) =>
        decideSignupRequest(tx, {
          id: request.id,
          decision: 'denied',
          decidedBy: admin,
          accountId: null,
          at: new Date().toISOString(),
        }),
      ),
    ).toBe(false);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET decision = 'denied' WHERE id = $1`, [request.id]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`DELETE FROM signup_requests WHERE id = $1`, [request.id]),
      ),
    ).toBe('P0001');
    const decided = await isolated.db.withClient((c) => getSignupRequest(c, request.id));
    expect(decided).toMatchObject({
      decision: 'approved',
      decidedBy: admin,
      accountId: reader,
      attemptCount: 2,
    });
    expect(
      await isolated.db.withClient((c) => findOpenSignupRequest(c, request.normalizedEmail)),
    ).toBeNull();
    expect(await isolated.db.withClient((c) => listPendingSignupRequests(c, 10))).toEqual([]);
    // After a decision the address may request again; an account on a denial is refused.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSignupRequest(tx, { ...request, id: randomUUID(), codeDigest: hash('3') }),
      ),
    ).toBe('inserted');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO signup_requests (id, normalized_email, code_digest, requested_at, expires_at, verified_at, decided_at, decision, decided_by, account_id)
                  VALUES ($1, 'other@example.org', $2, now(), now() + interval '10 minutes', now(), now(), 'denied', $3, $4)`,
          [randomUUID(), hash('4'), admin, reader],
        ),
      ),
    ).toBe('23514');
  });

  it('supersedes an unverified open request past its expiry when the address asks again, and never a live or a verified one (train review F4)', async () => {
    const t0 = Date.parse('2026-10-23T12:00:00.000Z');
    const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
    const stale = {
      id: randomUUID(),
      normalizedEmail: 'again@example.org',
      codeDigest: hash('a1'),
      requestedAt: at(0),
      expiresAt: at(600),
    };
    expect(await isolated.db.withTransaction((tx) => insertSignupRequest(tx, stale))).toBe(
      'inserted',
    );
    // Before the expiry the address is held to its open request.
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSignupRequest(tx, {
          ...stale,
          id: randomUUID(),
          codeDigest: hash('a2'),
          requestedAt: at(599),
          expiresAt: at(1199),
        }),
      ),
    ).toBe('open_exists');
    // At the expiry a new request supersedes it; the old one is closed in every path.
    const fresh = {
      ...stale,
      id: randomUUID(),
      codeDigest: hash('a3'),
      requestedAt: at(600),
      expiresAt: at(1200),
    };
    expect(await isolated.db.withTransaction((tx) => insertSignupRequest(tx, fresh))).toBe(
      'inserted',
    );
    const old = await isolated.db.withClient((c) => getSignupRequest(c, stale.id));
    expect(Date.parse(old?.supersededAt ?? '')).toBe(Date.parse(at(600)));
    expect(
      (await isolated.db.withClient((c) => findOpenSignupRequest(c, stale.normalizedEmail)))?.id,
    ).toBe(fresh.id);
    expect(await isolated.db.withTransaction((tx) => recordSignupAttempt(tx, stale.id))).toBeNull();
    expect(
      await isolated.db.withTransaction((tx) => verifySignupRequest(tx, stale.id, at(601))),
    ).toBe(false);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET verified_at = now() WHERE id = $1`, [stale.id]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET superseded_at = NULL WHERE id = $1`, [stale.id]),
      ),
    ).toBe('P0001');
    // The fresh request is live: it verifies, and a verified request is never superseded.
    expect(
      await isolated.db.withTransaction((tx) => verifySignupRequest(tx, fresh.id, at(700))),
    ).toBe(true);
    expect(
      await isolated.db.withTransaction((tx) =>
        insertSignupRequest(tx, {
          ...stale,
          id: randomUUID(),
          codeDigest: hash('a4'),
          requestedAt: at(5_000),
          expiresAt: at(5_600),
        }),
      ),
    ).toBe('open_exists');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET superseded_at = now() WHERE id = $1`, [fresh.id]),
      ),
    ).toBe('P0001');
    // A live, unverified request is not superseded by hand before its expiry either.
    const live = {
      ...stale,
      id: randomUUID(),
      normalizedEmail: 'live@example.org',
      codeDigest: hash('a5'),
      requestedAt: at(0),
      expiresAt: at(600),
    };
    expect(await isolated.db.withTransaction((tx) => insertSignupRequest(tx, live))).toBe(
      'inserted',
    );
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE signup_requests SET superseded_at = $2::timestamptz WHERE id = $1`, [
          live.id,
          at(599),
        ]),
      ),
    ).toBe('P0001');
    // The lock returns the row for the caller's transaction.
    expect((await isolated.db.withTransaction((tx) => lockSignupRequest(tx, fresh.id)))?.id).toBe(
      fresh.id,
    );
    expect(
      await isolated.db.withTransaction((tx) => lockSignupRequest(tx, randomUUID())),
    ).toBeNull();
  });

  it('marks a revision that exists, decides by the latest record, unmarks by a new record, and never rewrites', async () => {
    const at = new Date().toISOString();
    await isolated.db.withTransaction(async (tx) => {
      await insertRoundupRevision(tx, {
        weekRunId,
        category: 'cyberattack',
        revision: 0,
        kind: 'deterministic',
        slots: { rundown: [] },
        markdown: '# r0',
        provenance: null,
        savedByAccountId: owner,
        createdAt: at,
      });
      await insertRoundupRevision(tx, {
        weekRunId,
        category: 'cyberattack',
        revision: 1,
        kind: 'generated',
        slots: { rundown: [] },
        markdown: '# r1',
        provenance: {
          model: 'claude-opus-5-5',
          promptVersion: 'roundup-prompt@1',
          promptHash: hash('a'),
          templateVersion: 'rundown-template@1',
          templateHash: hash('b'),
          inputDigest: hash('c'),
          inputTokens: 1,
          outputTokens: 1,
          costMicrodollars: 24,
        },
        savedByAccountId: owner,
        createdAt: at,
      });
      await insertArticleRevision(tx, {
        weekRunId,
        category: 'cyberattack',
        revision: 1,
        kind: 'generated',
        slots: { headline: 'x' },
        markdown: '# a1',
        provenance: {
          model: 'claude-opus-5-5',
          promptVersion: 'article-prompt@1',
          promptHash: hash('a'),
          inputDigest: hash('b'),
          inputTokens: 1,
          outputTokens: 1,
          costMicrodollars: 24,
          wordCount: 500,
          namingBasis: 'none',
          sources: [],
        },
        savedByAccountId: owner,
        createdAt: at,
      });
    });
    const mark = (
      output: 'roundup' | 'article',
      revision: number,
      action: 'publish' | 'unpublish',
      createdAt: string,
    ) => ({
      id: randomUUID(),
      weekRunId,
      category: 'cyberattack',
      output,
      revision,
      action,
      actorAccountId: owner,
      createdAt,
    });
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertPublication(tx, mark('roundup', 7, 'publish', at)),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertPublication(tx, mark('article', 0, 'publish', at)),
      ),
    ).toBe('P0001');
    expect(
      await isolated.db.withClient((c) =>
        currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
      ),
    ).toBeNull();
    await isolated.db.withTransaction((tx) =>
      insertPublication(tx, mark('roundup', 1, 'publish', '2026-10-22T10:00:00.000Z')),
    );
    expect(
      (
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        )
      )?.revision,
    ).toBe(1);
    await isolated.db.withTransaction((tx) =>
      insertPublication(tx, mark('article', 1, 'publish', '2026-10-22T10:01:00.000Z')),
    );
    expect(
      (await isolated.db.withClient((c) => listPublished(c, 10))).map((p) => [
        p.output,
        p.revision,
      ]),
    ).toEqual([
      ['article', 1],
      ['roundup', 1],
    ]);
    // Unmarking is a new record; the public page then has nothing; a later mark restores.
    await isolated.db.withTransaction((tx) =>
      insertPublication(tx, mark('roundup', 1, 'unpublish', '2026-10-22T10:02:00.000Z')),
    );
    expect(
      await isolated.db.withClient((c) =>
        currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
      ),
    ).toBeNull();
    expect(
      (await isolated.db.withClient((c) => listPublished(c, 10))).map((p) => p.output),
    ).toEqual(['article']);
    await isolated.db.withTransaction((tx) =>
      insertPublication(tx, mark('roundup', 0, 'publish', '2026-10-22T10:03:00.000Z')),
    );
    expect(
      (
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        )
      )?.revision,
    ).toBe(0);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE output_publications SET revision = 1 WHERE week_run_id = $1`, [weekRunId]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`DELETE FROM output_publications WHERE week_run_id = $1`, [weekRunId]),
      ),
    ).toBe('P0001');
    // The eight audit kinds are admitted.
    for (const kind of [
      'signup_requested',
      'signup_verified',
      'signup_locked',
      'signup_approved',
      'signup_denied',
      'limit_tripped',
      'output_published',
      'output_unpublished',
    ]) {
      await isolated.db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO audit_events (id, at, kind, outcome, code, actor_account_id, subject_account_id, session_id, network_key, subject_id)
           VALUES ($1, now(), $2, 'success', 'sent', NULL, NULL, NULL, NULL, NULL)`,
          [randomUUID(), kind],
        ),
      );
    }
  });
});
