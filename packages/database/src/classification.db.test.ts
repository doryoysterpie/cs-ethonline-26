import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countBatchSourceRows,
  countReviewState,
  countRunDecisions,
  countRunRationaleCodes,
  countUnclassifiedRows,
  fetchCalibrationMatrix,
  fetchClassificationInputs,
  fetchReviewQueue,
  findBatchReviewSnapshot,
  findClassificationRunByIdempotencyKey,
  getClassificationRun,
  insertClassificationResults,
  insertClassificationRun,
  type NewClassificationResult,
  type NewClassificationRun,
} from './classification.js';
import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * Persistence-level coverage of migration 0003. Every contradiction the
 * composite keys forbid is attempted directly and must be rejected by
 * PostgreSQL, and the classification input query is proven to expose no
 * prohibited field and to join no human review table.
 */

interface Seeded {
  readonly batchId: string;
  readonly snapshotId: string;
  readonly rowIds: readonly string[];
}

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One weekly batch: three rows, one quarantined, all with review entries. */
async function seedBatch(db: Database, label: string): Promise<Seeded> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const rowIds = [randomUUID(), randomUUID(), randomUUID()];
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', $2, 'seed.csv', $3, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $4, 'completed_with_issues', 3, 2, 1, now(), now())`,
      [batchId, label, hash('a'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, $3, 'replay', now())`,
      [snapshotId, batchId, label],
    );
    for (const [index, id] of rowIds.entries()) {
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           raw_ch, raw_url, raw_category, normalized_title, derived_summary_text,
           text_transform, row_hash
         ) VALUES ($1, $2, $3, 'replay', $4, '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', 'https://seed.example/x', 'Security', $5, $6,
                   'html-to-text@1', $7)`,
        [
          id,
          batchId,
          index + 1,
          index === 2 ? 'quarantined' : 'accepted',
          `title ${index}`,
          `summary ${index}`,
          hash(String(index)),
        ],
      );
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state)
         VALUES ($1, $2, $3, $4, 'TRUE', $5)`,
        [randomUUID(), snapshotId, id, batchId, index === 1 ? 'rejected' : 'selected'],
      );
    }
  });
  return { batchId, snapshotId, rowIds };
}

function newRun(
  batchId: string,
  overrides: Partial<NewClassificationRun> = {},
): NewClassificationRun {
  return {
    id: randomUUID(),
    batchId,
    dataOrigin: 'replay',
    classifierVersion: 'rules-classifier@1',
    rulesetVersion: 'classification-signal-policy@1',
    rulesetHash: hash('f'),
    mode: 'rules',
    idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    expectedRowCount: 3,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function newResult(
  run: NewClassificationRun,
  sourceRowId: string,
  decision: NewClassificationResult['decision'],
  overrides: Partial<NewClassificationResult> = {},
): NewClassificationResult {
  return {
    id: randomUUID(),
    runId: run.id,
    batchId: run.batchId,
    sourceRowId,
    decision,
    rationaleCodes: ['decisive_signal'],
    matchedSignals: ['ransomware'],
    signalScore: 3,
    rowHash: hash('b'),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Writes a complete run of three results in one transaction. */
async function completeRun(
  db: Database,
  seeded: Seeded,
  overrides: Partial<NewClassificationRun> = {},
): Promise<NewClassificationRun> {
  const run = newRun(seeded.batchId, overrides);
  await db.withTransaction(async (tx) => {
    await insertClassificationRun(tx, run, {
      classifiedRowCount: 3,
      includeCount: 1,
      excludeCount: 1,
      reviewCount: 1,
      completedAt: new Date().toISOString(),
    });
    await insertClassificationResults(tx, [
      newResult(run, seeded.rowIds[0] ?? '', 'include'),
      newResult(run, seeded.rowIds[1] ?? '', 'exclude', {
        rationaleCodes: ['no_signal_match', 'out_of_scope_signal'],
        matchedSignals: ['lifestyle'],
        signalScore: 0,
      }),
      newResult(run, seeded.rowIds[2] ?? '', 'review', {
        rationaleCodes: ['row_quarantined'],
        matchedSignals: [],
        signalScore: 0,
      }),
    ]);
  });
  return run;
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

describe('classification persistence (migration 0003)', () => {
  let isolated: IsolatedSchema;
  let batchA: Seeded;
  let batchB: Seeded;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    batchA = await seedBatch(isolated.db, 'CS01');
    batchB = await seedBatch(isolated.db, 'CS02');
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('loads only the fields the classifier may read, page by page', async () => {
    const page = await isolated.db.withClient((c) =>
      fetchClassificationInputs(c, batchA.batchId, { afterRowNumber: 0, limit: 2 }),
    );
    expect(page).toHaveLength(2);
    const [first] = page;
    if (first === undefined) throw new Error('no row');
    expect(Object.keys(first).sort()).toEqual([
      'derivedDescriptionText',
      'derivedSummaryText',
      'normalizedTitle',
      'rowHash',
      'rowNumber',
      'sourceRowId',
      'status',
    ]);
    const serialized = JSON.stringify(page);
    for (const forbidden of ['TRUE', 'https://seed.example', 'Security', 'selected', 'CS01']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    const next = await isolated.db.withClient((c) =>
      fetchClassificationInputs(c, batchA.batchId, {
        afterRowNumber: first.rowNumber + 1,
        limit: 2,
      }),
    );
    expect(next.map((r) => r.rowNumber)).toEqual([3]);
    expect(next[0]?.status).toBe('quarantined');
    expect(await isolated.db.withClient((c) => countBatchSourceRows(c, batchA.batchId))).toBe(3);
  });

  it('refuses an out-of-range page size rather than loading the whole batch', async () => {
    await expect(
      isolated.db.withClient((c) =>
        fetchClassificationInputs(c, batchA.batchId, { afterRowNumber: 0, limit: 0 }),
      ),
    ).rejects.toMatchObject({ kind: 'query' });
    await expect(
      isolated.db.withClient((c) =>
        fetchClassificationInputs(c, batchA.batchId, { afterRowNumber: 0, limit: 5000 }),
      ),
    ).rejects.toMatchObject({ kind: 'query' });
  });

  it('stores a completed run with one result per row and reconciles its counts', async () => {
    const run = await completeRun(isolated.db, batchA);
    const stored = await isolated.db.withClient((c) => getClassificationRun(c, run.id));
    expect(stored?.status).toBe('completed');
    expect(stored?.classifiedRowCount).toBe(3);
    expect(stored?.expectedRowCount).toBe(3);
    expect(await isolated.db.withClient((c) => countRunDecisions(c, run.id))).toEqual({
      include: 1,
      exclude: 1,
      review: 1,
      total: 3,
    });
    expect(
      await isolated.db.withClient((c) => countUnclassifiedRows(c, run.id, batchA.batchId)),
    ).toBe(0);
    const codes = await isolated.db.withClient((c) => countRunRationaleCodes(c, run.id));
    expect(codes).toEqual([
      { code: 'decisive_signal', count: 1 },
      { code: 'no_signal_match', count: 1 },
      { code: 'out_of_scope_signal', count: 1 },
      { code: 'row_quarantined', count: 1 },
    ]);
  });

  it('finds a run by its idempotency key and refuses a duplicate key', async () => {
    const run = await completeRun(isolated.db, batchB);
    const found = await isolated.db.withClient((c) =>
      findClassificationRunByIdempotencyKey(c, run.idempotencyKey),
    );
    expect(found?.id).toBe(run.id);
    const code = await expectRejected(isolated.db, (tx) =>
      insertClassificationRun(tx, newRun(batchB.batchId, { idempotencyKey: run.idempotencyKey }), {
        classifiedRowCount: 3,
        includeCount: 3,
        excludeCount: 0,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      }),
    );
    expect(code).toBe('23505');
  });

  it('refuses a run whose counts do not reconcile with its batch', async () => {
    const short = await expectRejected(isolated.db, (tx) =>
      insertClassificationRun(tx, newRun(batchA.batchId, { expectedRowCount: 3 }), {
        classifiedRowCount: 2,
        includeCount: 2,
        excludeCount: 0,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      }),
    );
    expect(short).toBe('23514');
    const mismatched = await expectRejected(isolated.db, (tx) =>
      insertClassificationRun(tx, newRun(batchA.batchId), {
        classifiedRowCount: 3,
        includeCount: 1,
        excludeCount: 1,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      }),
    );
    expect(mismatched).toBe('23514');
  });

  it('refuses a run whose origin differs from its batch', async () => {
    const code = await expectRejected(isolated.db, (tx) =>
      insertClassificationRun(tx, newRun(batchA.batchId, { dataOrigin: 'live' }), {
        classifiedRowCount: 3,
        includeCount: 3,
        excludeCount: 0,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      }),
    );
    expect(code).toBe('23503');
  });

  it('refuses every cross-batch run, result and source-row combination', async () => {
    const runA = await completeRun(isolated.db, batchA);
    // A result naming batch A's run but a source row of batch B.
    const crossRow = await expectRejected(isolated.db, (tx) =>
      insertClassificationResults(tx, [
        newResult({ ...runA, batchId: batchA.batchId }, batchB.rowIds[0] ?? '', 'include'),
      ]),
    );
    expect(crossRow).toBe('23503');
    // A result claiming batch B while its run belongs to batch A.
    const crossRun = await expectRejected(isolated.db, (tx) =>
      insertClassificationResults(tx, [
        newResult(runA, batchB.rowIds[0] ?? '', 'include', { batchId: batchB.batchId }),
      ]),
    );
    expect(crossRun).toBe('23503');
    // A result naming a run that does not exist.
    const noRun = await expectRejected(isolated.db, (tx) =>
      insertClassificationResults(tx, [
        newResult({ ...runA, id: randomUUID() }, batchA.rowIds[0] ?? '', 'include'),
      ]),
    );
    expect(noRun).toBe('23503');
  });

  it('refuses two results for the same row in the same run', async () => {
    const run = await completeRun(isolated.db, batchA);
    const code = await expectRejected(isolated.db, (tx) =>
      insertClassificationResults(tx, [newResult(run, batchA.rowIds[0] ?? '', 'review')]),
    );
    expect(code).toBe('23505');
  });

  it('refuses an empty rationale-code list and an unknown decision', async () => {
    const run = newRun(batchA.batchId);
    const empty = await expectRejected(isolated.db, async (tx) => {
      await insertClassificationRun(tx, run, {
        classifiedRowCount: 3,
        includeCount: 3,
        excludeCount: 0,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      });
      await insertClassificationResults(tx, [
        newResult(run, batchA.rowIds[0] ?? '', 'include', { rationaleCodes: [] }),
      ]);
    });
    expect(empty).toBe('23514');
    const unknown = await expectRejected(isolated.db, async (tx) => {
      const other = newRun(batchA.batchId);
      await insertClassificationRun(tx, other, {
        classifiedRowCount: 3,
        includeCount: 3,
        excludeCount: 0,
        reviewCount: 0,
        completedAt: new Date().toISOString(),
      });
      await insertClassificationResults(tx, [
        newResult(other, batchA.rowIds[0] ?? '', 'maybe' as 'include'),
      ]);
    });
    expect(unknown).toBe('23514');
  });

  it('rolls the whole run back when a result fails, leaving no partial run', async () => {
    const before = await isolated.db.withClient((c) =>
      c.query<{ count: string }>('SELECT count(*)::text AS count FROM classification_runs'),
    );
    const run = newRun(batchA.batchId);
    await expect(
      isolated.db.withTransaction(async (tx) => {
        await insertClassificationRun(tx, run, {
          classifiedRowCount: 3,
          includeCount: 3,
          excludeCount: 0,
          reviewCount: 0,
          completedAt: new Date().toISOString(),
        });
        await insertClassificationResults(tx, [newResult(run, batchA.rowIds[0] ?? '', 'include')]);
        throw new Error('simulated failure after the first page');
      }),
    ).rejects.toThrowError('simulated failure');
    const after = await isolated.db.withClient((c) =>
      c.query<{ count: string }>('SELECT count(*)::text AS count FROM classification_runs'),
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(await isolated.db.withClient((c) => getClassificationRun(c, run.id))).toBeNull();
  });

  it('serves the needs-review queue for one explicit run, without source text', async () => {
    const run = await completeRun(isolated.db, batchA);
    const queue = await isolated.db.withClient((c) =>
      fetchReviewQueue(c, run.id, { afterRowNumber: 0, limit: 100 }),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.rationaleCodes).toEqual(['row_quarantined']);
    expect(JSON.stringify(queue)).not.toContain('title');
    expect(JSON.stringify(queue)).not.toContain('summary');
    // A different run's queue is disjoint: the queue is never global.
    const other = await completeRun(isolated.db, batchB);
    const otherQueue = await isolated.db.withClient((c) =>
      fetchReviewQueue(c, other.id, { afterRowNumber: 0, limit: 100 }),
    );
    expect(otherQueue.map((e) => e.sourceRowId)).not.toEqual(queue.map((e) => e.sourceRowId));
  });

  it('computes the calibration matrix only after classification, as counts', async () => {
    const run = await completeRun(isolated.db, batchA);
    const snapshot = await isolated.db.withClient((c) =>
      findBatchReviewSnapshot(c, batchA.batchId),
    );
    expect(snapshot?.reviewLabel).toBe('CS01');
    const matrix = await isolated.db.withClient((c) => fetchCalibrationMatrix(c, run.id));
    expect(matrix.reduce((sum, cell) => sum + cell.count, 0)).toBe(3);
    for (const cell of matrix) {
      expect(Object.keys(cell).sort()).toEqual(['count', 'decision', 'reviewState']);
      expect(typeof cell.count).toBe('number');
    }
    // A batch with no snapshot yields none.
    const noSnapshot = await isolated.db.withClient((c) =>
      findBatchReviewSnapshot(c, randomUUID()),
    );
    expect(noSnapshot).toBeNull();
  });

  it('never mutates the human review tables', async () => {
    const before = await isolated.db.withClient(countReviewState);
    await completeRun(isolated.db, batchA);
    await completeRun(isolated.db, batchB);
    expect(await isolated.db.withClient(countReviewState)).toEqual(before);
    expect(before.entries).toBe(6);
    expect(before.selected).toBe(4);
    expect(before.rejected).toBe(2);
  });
});
