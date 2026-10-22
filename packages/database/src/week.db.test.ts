import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';
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
