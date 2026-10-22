import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';
import {
  insertModelCall,
  insertRoundupRevision,
  latestRoundupRevision,
  listRoundupRevisions,
  spendBetween,
} from './roundup.js';
import {
  completeWeekRun,
  findCompletedWeekRunByKey,
  getWeekRun,
  insertRunningWeekRun,
  insertWeekRunChild,
  listWeekRunChildren,
  listWeekRuns,
  type NewWeekRun,
} from './week.js';

/**
 * Migration 0014's manifest and children: the one permitted transition, the
 * append-only rules, the completed-key uniqueness that lets a failed attempt
 * be retried, and the child identity checks. Selections, which need real
 * incidents, are exercised in the worker's PostgreSQL suite.
 */

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const WINDOW_START = '2026-10-18T03:59:00.000Z'; // Saturday 17 October 23:59 America/Toronto (EDT)
const WINDOW_END = '2026-10-25T03:59:00.000Z';
const CUTOFF = '2026-10-26T03:59:00.000Z';

async function seedBatch(db: Database): Promise<string> {
  const batchId = randomUUID();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'master', NULL, 'seed.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', 0, 0, 0, now(), now())`,
      [batchId, hash('a'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
    );
  });
  return batchId;
}

function newRun(batchId: string, overrides: Partial<NewWeekRun> = {}): NewWeekRun {
  return {
    id: randomUUID(),
    dataOrigin: 'replay',
    batchId,
    timeZone: 'America/Toronto',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    publicationCutoffAt: CUTOFF,
    categories: ['cyberattack', 'crypto'],
    idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

describe('week runs and their children (migration 0014)', () => {
  let isolated: IsolatedSchema;
  let batchId: string;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    batchId = await seedBatch(isolated.db);
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('inserts a running manifest, records children, completes once, and is then immutable', async () => {
    const run = newRun(batchId);
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    const stored = await isolated.db.withClient((c) => getWeekRun(c, run.id));
    expect(stored).toMatchObject({
      id: run.id,
      status: 'running',
      freezeAt: new Date(WINDOW_END).toISOString().replace('.000Z', '+00:00'),
      categories: ['cyberattack', 'crypto'],
      failureCode: null,
      completedAt: null,
    });
    await isolated.db.withTransaction((tx) =>
      insertWeekRunChild(tx, {
        id: randomUUID(),
        weekRunId: run.id,
        position: 1,
        kind: 'import',
        category: null,
        batchId,
        classificationRunId: null,
        clusteringRunId: null,
        outcome: 'provided',
        errorCode: null,
        createdAt: new Date().toISOString(),
      }),
    );
    // Completed by its one permitted transition.
    expect(
      await isolated.db.withTransaction((tx) =>
        completeWeekRun(tx, run.id, 'completed', new Date().toISOString(), null),
      ),
    ).toBe(true);
    expect(
      await isolated.db.withTransaction((tx) =>
        completeWeekRun(tx, run.id, 'failed', new Date().toISOString(), 'late'),
      ),
    ).toBe(false);
    expect((await isolated.db.withClient((c) => getWeekRun(c, run.id)))?.status).toBe('completed');
    // No child after completion, no edit, no delete.
    const late = await expectRejected(isolated.db, (tx) =>
      insertWeekRunChild(tx, {
        id: randomUUID(),
        weekRunId: run.id,
        position: 2,
        kind: 'classification',
        category: 'cyberattack',
        batchId: null,
        classificationRunId: null,
        clusteringRunId: null,
        outcome: 'failed',
        errorCode: 'late_child',
        createdAt: new Date().toISOString(),
      }),
    );
    expect(late).toBe('P0001');
    const edit = await expectRejected(isolated.db, (tx) =>
      tx.query(`UPDATE week_runs SET categories = '["crypto"]'::jsonb WHERE id = $1`, [run.id]),
    );
    expect(edit).toBe('P0001');
    const remove = await expectRejected(isolated.db, (tx) =>
      tx.query('DELETE FROM week_runs WHERE id = $1', [run.id]),
    );
    expect(remove).toBe('P0001');
    const removeChild = await expectRejected(isolated.db, (tx) =>
      tx.query('DELETE FROM week_run_children WHERE week_run_id = $1', [run.id]),
    );
    expect(removeChild).toBe('P0001');
    expect(await isolated.db.withClient((c) => listWeekRunChildren(c, run.id))).toHaveLength(1);
    expect(
      (await isolated.db.withClient((c) => listWeekRuns(c, 10))).some((r) => r.id === run.id),
    ).toBe(true);
  });

  it('refuses a manifest inserted as completed, a provenance edit while running, and a bad window', async () => {
    const inserted = await expectRejected(isolated.db, (tx) =>
      tx.query(
        `INSERT INTO week_runs (id, data_origin, batch_id, time_zone, window_start, window_end, freeze_at,
           publication_cutoff_at, categories, idempotency_key, status, failure_code, started_at, completed_at)
         VALUES ($1, 'replay', $2, 'America/Toronto', $3, $4, $4, $5, '["cyberattack"]', $6, 'completed', NULL, now(), now())`,
        [randomUUID(), batchId, WINDOW_START, WINDOW_END, CUTOFF, hash('1')],
      ),
    );
    expect(inserted).toBe('P0001');
    const run = newRun(batchId);
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    const edit = await expectRejected(isolated.db, (tx) =>
      tx.query(`UPDATE week_runs SET window_end = $2 WHERE id = $1`, [run.id, CUTOFF]),
    );
    expect(edit).toBe('P0001');
    const badWindow = await expectRejected(isolated.db, (tx) =>
      insertRunningWeekRun(tx, newRun(batchId, { windowEnd: WINDOW_START })),
    );
    expect(badWindow).toBe('23514');
  });

  it('keeps completed manifests unique per key while a failed attempt stays as history', async () => {
    const key = hash('f');
    const failed = newRun(batchId, { idempotencyKey: key });
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, failed));
    await isolated.db.withTransaction((tx) =>
      completeWeekRun(tx, failed.id, 'failed', new Date().toISOString(), 'child_failed'),
    );
    expect(await isolated.db.withClient((c) => findCompletedWeekRunByKey(c, key))).toBeNull();
    const retry = newRun(batchId, { idempotencyKey: key });
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, retry));
    await isolated.db.withTransaction((tx) =>
      completeWeekRun(tx, retry.id, 'completed', new Date().toISOString(), null),
    );
    expect((await isolated.db.withClient((c) => findCompletedWeekRunByKey(c, key)))?.id).toBe(
      retry.id,
    );
    const again = newRun(batchId, { idempotencyKey: key });
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, again));
    const duplicate = await expectRejected(isolated.db, (tx) =>
      completeWeekRun(tx, again.id, 'completed', new Date().toISOString(), null),
    );
    expect(duplicate).toBe('23505');
    // A failure needs a code and a completion needs none.
    const noCode = await expectRejected(isolated.db, (tx) =>
      completeWeekRun(tx, again.id, 'failed', new Date().toISOString(), null),
    );
    expect(noCode).toBe('23514');
  });

  it('checks each child carries exactly the identifier its kind names', async () => {
    const run = newRun(batchId);
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    const base = {
      weekRunId: run.id,
      category: 'cyberattack',
      batchId: null,
      classificationRunId: null,
      clusteringRunId: null,
      errorCode: null,
      createdAt: new Date().toISOString(),
    };
    // A classification child with no run identifier and no failure.
    const missing = await expectRejected(isolated.db, (tx) =>
      insertWeekRunChild(tx, {
        ...base,
        id: randomUUID(),
        position: 1,
        kind: 'classification',
        outcome: 'created',
      }),
    );
    expect(missing).toBe('23514');
    // An import child with a category.
    const importWithCategory = await expectRejected(isolated.db, (tx) =>
      insertWeekRunChild(tx, {
        ...base,
        id: randomUUID(),
        position: 1,
        kind: 'import',
        batchId,
        outcome: 'reused',
      }),
    );
    expect(importWithCategory).toBe('23514');
    // A failed child needs no identifier but needs a code; the same kind and
    // category cannot be recorded twice.
    await isolated.db.withTransaction((tx) =>
      insertWeekRunChild(tx, {
        ...base,
        id: randomUUID(),
        position: 1,
        kind: 'classification',
        outcome: 'failed',
        errorCode: 'run_not_reconciled',
      }),
    );
    const twice = await expectRejected(isolated.db, (tx) =>
      insertWeekRunChild(tx, {
        ...base,
        id: randomUUID(),
        position: 2,
        kind: 'classification',
        outcome: 'failed',
        errorCode: 'run_not_reconciled',
      }),
    );
    expect(twice).toBe('23505');
  });
});

describe('round-up revisions, the model ledger and the owner role (migration 0015)', () => {
  let isolated: IsolatedSchema;
  let batchId: string;
  let owner: string;
  let weekRunId: string;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    batchId = await seedBatch(isolated.db);
    owner = randomUUID();
    // The role the migration admits (D39).
    await isolated.db.withTransaction((tx) =>
      tx.query(
        `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at)
         VALUES ($1, 'owner_account', 'owner', 'synthetic-not-a-credential', now(), now())`,
        [owner],
      ),
    );
    const run = newRun(batchId);
    weekRunId = run.id;
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    await isolated.db.withTransaction((tx) =>
      completeWeekRun(tx, run.id, 'completed', new Date().toISOString(), null),
    );
  });

  afterAll(async () => {
    await isolated.close();
  });

  const provenance = {
    model: 'claude-opus-5-5',
    promptVersion: 'roundup-prompt@1',
    promptHash: hash('a'),
    templateVersion: 'rundown-template@1',
    templateHash: hash('b'),
    inputDigest: hash('c'),
    inputTokens: 1200,
    outputTokens: 400,
    costMicrodollars: 12_800,
  };

  it('keeps revisions in sequence with the kind bound to the number and provenance on the generated one', async () => {
    const base = {
      weekRunId,
      category: 'cyberattack',
      slots: { rundown: [] },
      markdown: '# r',
      savedByAccountId: owner,
      createdAt: new Date().toISOString(),
    };
    // Revision 1 cannot come first; revision 0 must be deterministic; generated needs provenance.
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, { ...base, revision: 1, kind: 'generated', provenance }),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, { ...base, revision: 0, kind: 'generated', provenance }),
      ),
    ).toBe('23514');
    await isolated.db.withTransaction((tx) =>
      insertRoundupRevision(tx, { ...base, revision: 0, kind: 'deterministic', provenance: null }),
    );
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, { ...base, revision: 1, kind: 'generated', provenance: null }),
      ),
    ).toBe('23514');
    await isolated.db.withTransaction((tx) =>
      insertRoundupRevision(tx, { ...base, revision: 1, kind: 'generated', provenance }),
    );
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, { ...base, revision: 3, kind: 'edited', provenance: null }),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, { ...base, revision: 2, kind: 'edited', provenance }),
      ),
    ).toBe('23514');
    await isolated.db.withTransaction((tx) =>
      insertRoundupRevision(tx, {
        ...base,
        revision: 2,
        kind: 'edited',
        provenance: null,
        markdown: '# edited',
      }),
    );
    const listed = await isolated.db.withClient((c) =>
      listRoundupRevisions(c, weekRunId, 'cyberattack'),
    );
    expect(listed.map((r) => [r.revision, r.kind])).toEqual([
      [0, 'deterministic'],
      [1, 'generated'],
      [2, 'edited'],
    ]);
    expect(listed[1]?.provenance).toMatchObject(provenance);
    expect(
      (await isolated.db.withClient((c) => latestRoundupRevision(c, weekRunId, 'cyberattack')))
        ?.markdown,
    ).toBe('# edited');
    // Another category is its own sequence; a running week run takes none.
    await isolated.db.withTransaction((tx) =>
      insertRoundupRevision(tx, {
        ...base,
        category: 'crypto',
        revision: 0,
        kind: 'deterministic',
        provenance: null,
      }),
    );
    const running = newRun(batchId);
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, running));
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertRoundupRevision(tx, {
          ...base,
          weekRunId: running.id,
          revision: 0,
          kind: 'deterministic',
          provenance: null,
        }),
      ),
    ).toBe('P0001');
    // The stored bound on the rendering: 400,000 characters, the constant the package pins.
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO roundup_revisions (week_run_id, category, revision, kind, slots, markdown, saved_by_account_id, created_at)
           SELECT $1, 'cyberattack', max(revision) + 1, 'edited', '{}'::jsonb, repeat('x', 400001), $2, now()
             FROM roundup_revisions WHERE week_run_id = $1 AND category = 'cyberattack'`,
          [weekRunId, owner],
        ),
      ),
    ).toBe('23514');
    // Append-only.
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE roundup_revisions SET markdown = 'x' WHERE week_run_id = $1`, [weekRunId]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`DELETE FROM roundup_revisions WHERE week_run_id = $1`, [weekRunId]),
      ),
    ).toBe('P0001');
  });

  it('sums every billed call of the month, whatever its outcome, and keeps the ledger append-only', async () => {
    const call = (outcome: 'completed' | 'refused' | 'failed', cost: number, at: string) => ({
      id: randomUUID(),
      kind: 'roundup' as const,
      weekRunId,
      category: 'cyberattack',
      model: 'claude-opus-5-5',
      inputTokens: 100,
      outputTokens: 10,
      costMicrodollars: cost,
      outcome,
      code:
        outcome === 'completed'
          ? 'completed'
          : outcome === 'failed'
            ? 'response_sources_differ'
            : 'spend_cap_exceeded',
      actorAccountId: owner,
      createdAt: at,
    });
    await isolated.db.withTransaction(async (tx) => {
      await insertModelCall(tx, call('completed', 600, '2026-10-05T00:00:00.000Z'));
      await insertModelCall(tx, call('completed', 400, '2026-10-20T00:00:00.000Z'));
      // A refusal before any request carries nothing; a response the validator
      // rejected was billed all the same (review F3) and counts.
      await insertModelCall(tx, call('refused', 0, '2026-10-21T00:00:00.000Z'));
      await insertModelCall(tx, call('failed', 300, '2026-10-22T00:00:00.000Z'));
      await insertModelCall(tx, call('completed', 5_000, '2026-11-01T00:00:00.000Z'));
    });
    expect(
      await isolated.db.withClient((c) =>
        spendBetween(c, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      ),
    ).toBe(1_300);
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`DELETE FROM model_calls WHERE week_run_id = $1`, [weekRunId]),
      ),
    ).toBe('P0001');
    // The audit kinds the round-up writes are admitted; an unknown kind is not.
    await isolated.db.withTransaction((tx) =>
      tx.query(
        `INSERT INTO audit_events (id, at, kind, outcome, code, actor_account_id, subject_account_id, session_id, network_key, subject_id)
         VALUES ($1, now(), 'roundup_completed', 'success', 'completed', $2, NULL, NULL, NULL, $3)`,
        [randomUUID(), owner, weekRunId],
      ),
    );
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO audit_events (id, at, kind, outcome, code, actor_account_id, subject_account_id, session_id, network_key, subject_id)
           VALUES ($1, now(), 'roundup_unknown', 'success', 'x', $2, NULL, NULL, NULL, NULL)`,
          [randomUUID(), owner],
        ),
      ),
    ).toBe('23514');
  });
});
