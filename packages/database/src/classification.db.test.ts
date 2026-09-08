import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  completeClassificationRun,
  countBatchSourceRows,
  freezeBatchSourceSet,
  countReviewQueue,
  countReviewState,
  countRunDecisions,
  countRunRationaleCodes,
  countUnclassifiedRows,
  deriveRunDecisionCounts,
  fetchCalibrationMatrix,
  fetchClassificationInputs,
  fetchReviewQueue,
  findBatchReviewSnapshot,
  findClassificationRunByIdempotencyKey,
  getClassificationRun,
  insertClassificationResults,
  insertRunningClassificationRun,
  type NewClassificationResult,
  type NewClassificationRun,
} from './classification.js';
import type { Database, Queryable } from './database.js';
import { getImportBatch } from './ingestion.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * Persistence-level coverage of migrations 0003 and 0004. Every contradiction
 * the composite keys, the check constraints and the guard triggers forbid is
 * attempted directly and must be rejected by PostgreSQL. The classification
 * input query is proven to expose no prohibited field and to join no human
 * review table.
 *
 * The Codex Desktop audit of Sprint 3 demonstrated two gaps in 0003 alone: a
 * result could carry any syntactically valid SHA-256, and a completed run's
 * decisions and counters could be rewritten by a direct statement. The
 * sections below are the regression matrix for both.
 */

interface Seeded {
  readonly batchId: string;
  readonly snapshotId: string;
  readonly rowIds: readonly string[];
}

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** The hash actually stored on the seeded source row at that position. */
const rowHashAt = (index: number): string => hash(String(index));

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
          rowHashAt(index),
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
    classifierVersion: 'rules-classifier@2',
    rulesetVersion: 'classification-behavior-contract@1',
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
  seeded: Seeded,
  index: number,
  decision: NewClassificationResult['decision'],
  overrides: Partial<NewClassificationResult> = {},
): NewClassificationResult {
  return {
    id: randomUUID(),
    runId: run.id,
    batchId: run.batchId,
    sourceRowId: seeded.rowIds[index] ?? '',
    decision,
    rationaleCodes: ['decisive_signal'],
    matchedSignals: ['ransomware'],
    signalScore: 3,
    rowHash: rowHashAt(index),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** The three results a full run over a seeded batch stores. */
function allResults(run: NewClassificationRun, seeded: Seeded): NewClassificationResult[] {
  return [
    newResult(run, seeded, 0, 'include'),
    newResult(run, seeded, 1, 'exclude', {
      rationaleCodes: ['no_signal_match', 'out_of_scope_signal'],
      matchedSignals: ['lifestyle'],
      signalScore: 0,
    }),
    newResult(run, seeded, 2, 'review', {
      rationaleCodes: ['row_quarantined'],
      matchedSignals: [],
      signalScore: 0,
    }),
  ];
}

/**
 * Writes a run through the real lifecycle: running first, then results, then a
 * completion whose counters are derived from what was actually stored.
 */
async function completeRun(
  db: Database,
  seeded: Seeded,
  overrides: Partial<NewClassificationRun> = {},
): Promise<NewClassificationRun> {
  const run = newRun(seeded.batchId, overrides);
  await db.withTransaction(
    async (tx) => {
      // Migration 0005 refuses completion for a batch whose source set is
      // still mutable, so the freeze comes first exactly as it does in the
      // worker.
      await freezeBatchSourceSet(tx, seeded.batchId);
      await insertRunningClassificationRun(tx, run);
      await insertClassificationResults(tx, allResults(run, seeded));
      await completeClassificationRun(
        tx,
        run.id,
        await deriveRunDecisionCounts(tx, run.id),
        new Date().toISOString(),
      );
    },
    { isolationLevel: 'repeatable read' },
  );
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

describe('classification persistence (migrations 0003 to 0005)', () => {
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
    expect(stored?.completedAt).not.toBeNull();
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
      insertRunningClassificationRun(
        tx,
        newRun(batchB.batchId, { idempotencyKey: run.idempotencyKey }),
      ),
    );
    expect(code).toBe('23505');
  });

  it('refuses a run whose origin differs from its batch', async () => {
    const code = await expectRejected(isolated.db, (tx) =>
      insertRunningClassificationRun(tx, newRun(batchA.batchId, { dataOrigin: 'live' })),
    );
    expect(code).toBe('23503');
  });

  it('refuses every cross-batch run, result and source-row combination', async () => {
    // The run stays `running` throughout: a completed run would be refused by
    // the immutability guard before the relational keys were ever consulted,
    // which would prove nothing about the keys themselves.
    const runA = newRun(batchA.batchId);
    // A result naming batch A's run but a source row of batch B.
    const crossRow = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClassificationRun(tx, runA);
      await insertClassificationResults(tx, [
        { ...newResult(runA, batchB, 0, 'include'), runId: runA.id, batchId: batchA.batchId },
      ]);
    });
    expect(crossRow).toBe('23503');
    // A result claiming batch B while its run belongs to batch A.
    const crossRun = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClassificationRun(tx, runA);
      await insertClassificationResults(tx, [
        { ...newResult(runA, batchB, 0, 'include'), batchId: batchB.batchId },
      ]);
    });
    expect(crossRun).toBe('23503');
    // A result naming a run that does not exist.
    const noRun = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClassificationRun(tx, runA);
      await insertClassificationResults(tx, [
        { ...newResult(runA, batchA, 0, 'include'), runId: randomUUID() },
      ]);
    });
    expect(noRun).toBe('23503');
  });

  it('refuses two results for the same row in the same run', async () => {
    const run = newRun(batchA.batchId);
    const code = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClassificationRun(tx, run);
      await insertClassificationResults(tx, [
        newResult(run, batchA, 0, 'include'),
        newResult(run, batchA, 0, 'review'),
      ]);
    });
    expect(code).toBe('23505');
  });

  it('refuses an empty rationale-code list and an unknown decision', async () => {
    const empty = await expectRejected(isolated.db, async (tx) => {
      const run = newRun(batchA.batchId);
      await insertRunningClassificationRun(tx, run);
      await insertClassificationResults(tx, [
        newResult(run, batchA, 0, 'include', { rationaleCodes: [] }),
      ]);
    });
    expect(empty).toBe('23514');
    const unknown = await expectRejected(isolated.db, async (tx) => {
      const run = newRun(batchA.batchId);
      await insertRunningClassificationRun(tx, run);
      await insertClassificationResults(tx, [newResult(run, batchA, 0, 'maybe' as 'include')]);
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
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [newResult(run, batchA, 0, 'include')]);
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
    // The aggregate the command line uses agrees with the typed page, and is
    // the only one of the two that a compiled command may call.
    expect(await isolated.db.withClient((c) => countReviewQueue(c, run.id))).toBe(1);
    // A different run's queue is disjoint: the queue is never global.
    const other = await completeRun(isolated.db, batchB);
    const otherQueue = await isolated.db.withClient((c) =>
      fetchReviewQueue(c, other.id, { afterRowNumber: 0, limit: 100 }),
    );
    expect(otherQueue.map((e) => e.sourceRowId)).not.toEqual(queue.map((e) => e.sourceRowId));
    expect(await isolated.db.withClient((c) => countReviewQueue(c, randomUUID()))).toBe(0);
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

  // -------------------------------------------------------------------------
  // Audit finding 1a: a result's fingerprint is bound to its source row.

  describe('source-row hash integrity (migration 0004)', () => {
    it('refuses a result whose row hash is not its source row hash', async () => {
      const code = await expectRejected(isolated.db, async (tx) => {
        const run = newRun(batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [
          newResult(run, batchA, 0, 'include', { rowHash: rowHashAt(1) }),
        ]);
      });
      expect(code).toBe('23503');
    });

    it('refuses a result carrying a syntactically valid but unrelated hash', async () => {
      const code = await expectRejected(isolated.db, async (tx) => {
        const run = newRun(batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [
          newResult(run, batchA, 0, 'include', { rowHash: hash('9') }),
        ]);
      });
      expect(code).toBe('23503');
    });

    it('refuses to change a source row hash out from under a stored result', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [newResult(run, batchA, 0, 'include')]);
        await tx.query('UPDATE source_rows SET row_hash = $2 WHERE id = $1', [
          batchA.rowIds[0],
          hash('7'),
        ]);
      });
      expect(code).toBe('23503');
    });

    it('refuses to delete a source row a stored result references', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [newResult(run, batchA, 0, 'include')]);
        await tx.query('DELETE FROM source_rows WHERE id = $1', [batchA.rowIds[0]]);
      });
      expect(code).toBe('23503');
    });
  });

  // -------------------------------------------------------------------------
  // Audit finding 1b: a completed run and its results are immutable.

  describe('completed-run immutability (migration 0004)', () => {
    let frozen: NewClassificationRun;

    beforeAll(async () => {
      frozen = await completeRun(isolated.db, batchA);
    });

    const rejectsWithRaise = async (
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<void> => {
      const code = await expectRejected(isolated.db, (tx) => tx.query(sql, values));
      expect(code).toBe('P0001');
    };

    it('refuses to change a stored decision', async () => {
      await rejectsWithRaise(
        `UPDATE classification_results SET decision = 'exclude' WHERE run_id = $1`,
        [frozen.id],
      );
    });

    it('refuses to change stored rationale codes', async () => {
      await rejectsWithRaise(
        `UPDATE classification_results SET rationale_codes = '["decisive_signal"]'::jsonb
          WHERE run_id = $1`,
        [frozen.id],
      );
    });

    it('refuses to change stored matched signals', async () => {
      await rejectsWithRaise(
        `UPDATE classification_results SET matched_signals = '[]'::jsonb WHERE run_id = $1`,
        [frozen.id],
      );
    });

    it('refuses to change a stored signal score', async () => {
      await rejectsWithRaise(
        `UPDATE classification_results SET signal_score = 0 WHERE run_id = $1`,
        [frozen.id],
      );
    });

    it('refuses to change a stored result row hash', async () => {
      await rejectsWithRaise(`UPDATE classification_results SET row_hash = $2 WHERE run_id = $1`, [
        frozen.id,
        hash('3'),
      ]);
    });

    it('refuses to delete a stored result', async () => {
      await rejectsWithRaise('DELETE FROM classification_results WHERE run_id = $1', [frozen.id]);
    });

    it('refuses to add a result to a completed run', async () => {
      const code = await expectRejected(isolated.db, (tx) =>
        insertClassificationResults(tx, [newResult(frozen, batchA, 0, 'include')]),
      );
      expect(code).toBe('P0001');
    });

    it('refuses to move a completed run back to running', async () => {
      await rejectsWithRaise(
        `UPDATE classification_runs SET status = 'running', completed_at = NULL WHERE id = $1`,
        [frozen.id],
      );
    });

    it('refuses to rewrite a completed run counter', async () => {
      await rejectsWithRaise(
        'UPDATE classification_runs SET include_count = 3, exclude_count = 0, review_count = 0 WHERE id = $1',
        [frozen.id],
      );
    });

    it('refuses to rewrite a completed run ruleset hash', async () => {
      await rejectsWithRaise('UPDATE classification_runs SET ruleset_hash = $2 WHERE id = $1', [
        frozen.id,
        hash('e'),
      ]);
    });

    it('refuses to move a completed run completion time', async () => {
      await rejectsWithRaise('UPDATE classification_runs SET completed_at = now() WHERE id = $1', [
        frozen.id,
      ]);
    });

    it('refuses to delete a completed run', async () => {
      await rejectsWithRaise('DELETE FROM classification_runs WHERE id = $1', [frozen.id]);
      const still = await isolated.db.withClient((c) => getClassificationRun(c, frozen.id));
      expect(still?.status).toBe('completed');
      expect(still?.classifiedRowCount).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Audit finding 2: counters are derived, and completion is validated by the
  // database rather than trusted from the caller.

  describe('completion correctness (migration 0004)', () => {
    it('refuses to insert a run that claims to be already completed', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, (tx) =>
        tx.query(
          `INSERT INTO classification_runs (
             id, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash, mode,
             idempotency_key, status, expected_row_count, classified_row_count, include_count,
             exclude_count, review_count, started_at, completed_at
           ) VALUES ($1, $2, 'replay', 'rules-classifier@2', 'contract@1', $3, 'rules', $4,
                     'completed', 0, 0, 0, 0, 0, now(), now())`,
          [run.id, batchA.batchId, run.rulesetHash, run.idempotencyKey],
        ),
      );
      expect(code).toBe('P0001');
    });

    it('refuses counters that do not match the stored results', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await freezeBatchSourceSet(tx, batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, allResults(run, batchA));
        // Sums correctly and equals the batch size, but misreports the split.
        await completeClassificationRun(
          tx,
          run.id,
          { total: 3, include: 3, exclude: 0, review: 0 },
          new Date().toISOString(),
        );
      });
      expect(code).toBe('P0001');
    });

    it('refuses completion when the results do not cover every row', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await freezeBatchSourceSet(tx, batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [newResult(run, batchA, 0, 'include')]);
        await tx.query(
          `UPDATE classification_runs
              SET status = 'completed', classified_row_count = 3, include_count = 1,
                  exclude_count = 1, review_count = 1, completed_at = now()
            WHERE id = $1`,
          [run.id],
        );
      });
      expect(code).toBe('P0001');
    });

    it('refuses completion whose row count contradicts the batch coverage', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await freezeBatchSourceSet(tx, batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, [newResult(run, batchA, 0, 'include')]);
        await tx.query(
          `UPDATE classification_runs
              SET status = 'completed', classified_row_count = 1, include_count = 1,
                  exclude_count = 0, review_count = 0, completed_at = now()
            WHERE id = $1`,
          [run.id],
        );
      });
      // The guard's coverage check runs before the row-count check constraint
      // is evaluated, so the trigger is what rejects this.
      expect(code).toBe('P0001');
    });

    it('refuses a completed status with no completion time', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await freezeBatchSourceSet(tx, batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, allResults(run, batchA));
        await tx.query(
          `UPDATE classification_runs
              SET status = 'completed', classified_row_count = 3, include_count = 1,
                  exclude_count = 1, review_count = 1
            WHERE id = $1`,
          [run.id],
        );
      });
      // A check constraint, evaluated after the guard lets the row through.
      expect(code).toBe('23514');
    });

    it('refuses to alter the provenance of a running run', async () => {
      const run = newRun(batchA.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await freezeBatchSourceSet(tx, batchA.batchId);
        await insertRunningClassificationRun(tx, run);
        await tx.query('UPDATE classification_runs SET ruleset_hash = $2 WHERE id = $1', [
          run.id,
          hash('c'),
        ]);
      });
      expect(code).toBe('P0001');
    });

    it('refuses to complete a run twice', async () => {
      const run = await completeRun(isolated.db, batchB);
      await expect(
        isolated.db.withClient((c) =>
          completeClassificationRun(
            c,
            run.id,
            { total: 3, include: 1, exclude: 1, review: 1 },
            new Date().toISOString(),
          ),
        ),
      ).rejects.toMatchObject({ kind: 'query' });
      const stored = await isolated.db.withClient((c) => getClassificationRun(c, run.id));
      expect(stored?.status).toBe('completed');
    });

    it('derives its counters from the stored results, not from the caller', async () => {
      const run = newRun(batchA.batchId);
      await isolated.db.withTransaction(
        async (tx) => {
          await freezeBatchSourceSet(tx, batchA.batchId);
          await insertRunningClassificationRun(tx, run);
          await insertClassificationResults(tx, allResults(run, batchA));
          const derived = await deriveRunDecisionCounts(tx, run.id);
          expect(derived).toEqual({ total: 3, include: 1, exclude: 1, review: 1 });
          await completeClassificationRun(tx, run.id, derived, new Date().toISOString());
        },
        { isolationLevel: 'repeatable read' },
      );
      const stored = await isolated.db.withClient((c) => getClassificationRun(c, run.id));
      expect(stored?.includeCount).toBe(1);
      expect(stored?.excludeCount).toBe(1);
      expect(stored?.reviewCount).toBe(1);
      expect(await isolated.db.withClient((c) => deriveRunDecisionCounts(c, run.id))).toEqual({
        total: 3,
        include: 1,
        exclude: 1,
        review: 1,
      });
    });

    it('leaves an unfinished run visible as running, never as a completed lie', async () => {
      const run = newRun(batchA.batchId);
      await isolated.db.withClient(async (c) => {
        await insertRunningClassificationRun(c, run);
      });
      const stored = await isolated.db.withClient((c) => getClassificationRun(c, run.id));
      expect(stored?.status).toBe('running');
      expect(stored?.completedAt).toBeNull();
      expect(stored?.classifiedRowCount).toBe(0);
      // A running run contributes nothing to the queue.
      expect(await isolated.db.withClient((c) => countReviewQueue(c, run.id))).toBe(0);
      await isolated.db.withClient(async (c) => {
        await c.query('DELETE FROM classification_runs WHERE id = $1', [run.id]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Re-audit finding 2: the classified source set is frozen, so a completed
  // run stays reconciled no matter what happens to the batch afterwards.

  describe('source-set freeze (migration 0005)', () => {
    let frozenBatch: Seeded;

    beforeAll(async () => {
      frozenBatch = await seedBatch(isolated.db, 'CS20');
      await completeRun(isolated.db, frozenBatch);
    });

    const frozenAt = async (batchId: string): Promise<string | null> => {
      const record = await isolated.db.withClient((c) => getImportBatch(c, batchId));
      return record?.sourceSetFrozenAt ?? null;
    };

    it('marks the batch frozen when a run completes, and keeps the first timestamp', async () => {
      const first = await frozenAt(frozenBatch.batchId);
      expect(first).not.toBeNull();
      // A second run over the same batch must not move the marker.
      await completeRun(isolated.db, frozenBatch, {
        rulesetHash: hash('9'),
        idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      });
      expect(await frozenAt(frozenBatch.batchId)).toBe(first);
    });

    /** An import batch with no source rows, so a reassignment cannot collide. */
    async function emptyBatch(label: string): Promise<string> {
      const batchId = randomUUID();
      await isolated.db.withClient(async (c) => {
        await c.query(
          `INSERT INTO import_batches (
             id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
             header_cells, importer_version, idempotency_key, status, parsed_row_count,
             accepted_row_count, quarantined_row_count, started_at, completed_at
           ) VALUES ($1, 'replay', 'weekly', $2, 'seed.csv', $3, 10, '["ch"]'::jsonb,
                     'editorial-csv-import@1', $4, 'completed', 0, 0, 0, now(), now())`,
          [batchId, label, hash('a'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
        );
      });
      return batchId;
    }

    it('refuses every source-row mutation of a frozen batch', async () => {
      const rowId = frozenBatch.rowIds[0] ?? '';
      const destination = await emptyBatch('CS23');
      const cases: [name: string, sql: string, values: readonly unknown[]][] = [
        [
          'insert',
          `INSERT INTO source_rows (
             id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
             normalized_title, text_transform, row_hash
           ) VALUES ($1, $2, 99, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                     'late arrival', 'html-to-text@1', $3)`,
          [randomUUID(), frozenBatch.batchId, hash('5')],
        ],
        ['delete', 'DELETE FROM source_rows WHERE id = $1', [rowId]],
        ['row hash', 'UPDATE source_rows SET row_hash = $2 WHERE id = $1', [rowId, hash('6')]],
        [
          'normalized title',
          'UPDATE source_rows SET normalized_title = $2 WHERE id = $1',
          [rowId, 'rewritten'],
        ],
        [
          'derived summary',
          'UPDATE source_rows SET derived_summary_text = $2 WHERE id = $1',
          [rowId, 'rewritten'],
        ],
        [
          'derived description',
          'UPDATE source_rows SET derived_description_text = $2 WHERE id = $1',
          [rowId, 'rewritten'],
        ],
        [
          'ingestion status',
          `UPDATE source_rows SET status = 'quarantined' WHERE id = $1`,
          [rowId],
        ],
        [
          'batch reassignment',
          'UPDATE source_rows SET batch_id = $2 WHERE id = $1',
          [rowId, destination],
        ],
        [
          'origin reassignment',
          `UPDATE source_rows SET data_origin = 'live' WHERE id = $1`,
          [rowId],
        ],
      ];
      for (const [name, sql, values] of cases) {
        const code = await expectRejected(isolated.db, (tx) => tx.query(sql, values));
        // Some of these are refused by the immediate foreign key that binds a
        // stored result to its source row before the freeze trigger runs at
        // the end of the statement. Either way the mutation is refused; the
        // freeze is what covers the cases the key does not reach.
        expect(['P0001', '23503'], name).toContain(code);
      }
      // Nothing moved.
      expect(
        await isolated.db.withClient((c) => countBatchSourceRows(c, frozenBatch.batchId)),
      ).toBe(3);
    });

    it('refuses bulk removal that would empty a frozen batch', async () => {
      for (const sql of ['TRUNCATE source_rows', 'TRUNCATE import_batches CASCADE']) {
        const code = await expectRejected(isolated.db, (tx) => tx.query(sql));
        // PostgreSQL refuses to truncate a table another table references at
        // all (0A000); where it would proceed, the freeze trigger refuses it.
        expect(['P0001', '0A000'], sql).toContain(code);
      }
      const code = await expectRejected(isolated.db, (tx) =>
        tx.query('DELETE FROM import_batches WHERE id = $1', [frozenBatch.batchId]),
      );
      expect(code).toBe('P0001');
    });

    it('protects the freeze marker itself', async () => {
      for (const sql of [
        'UPDATE import_batches SET source_set_frozen_at = NULL WHERE id = $1',
        'UPDATE import_batches SET source_set_frozen_at = now() WHERE id = $1',
        `UPDATE import_batches SET data_origin = 'live' WHERE id = $1`,
      ]) {
        const code = await expectRejected(isolated.db, (tx) =>
          tx.query(sql, [frozenBatch.batchId]),
        );
        expect(code, sql).toBe('P0001');
      }
      expect(await frozenAt(frozenBatch.batchId)).not.toBeNull();
    });

    it('leaves an unfrozen batch fully mutable', async () => {
      const open = await seedBatch(isolated.db, 'CS21');
      expect(await frozenAt(open.batchId)).toBeNull();
      await isolated.db.withTransaction(async (tx) => {
        await tx.query('UPDATE source_rows SET normalized_title = $2 WHERE id = $1', [
          open.rowIds[0],
          'still editable',
        ]);
        // The human review entry references the row, so it goes first; that
        // ordering is ingestion's business and is unaffected by the freeze.
        await tx.query('DELETE FROM review_entries WHERE source_row_id = $1', [open.rowIds[2]]);
        await tx.query('DELETE FROM source_rows WHERE id = $1', [open.rowIds[2]]);
      });
      expect(await isolated.db.withClient((c) => countBatchSourceRows(c, open.batchId))).toBe(2);
      // Every mutation bumps the parent batch, which is what makes a
      // concurrent classifier fail rather than miss the change.
      const version = await isolated.db.withClient((c) =>
        c.query<{ v: number }>('SELECT source_set_version AS v FROM import_batches WHERE id = $1', [
          open.batchId,
        ]),
      );
      expect(version.rows[0]?.v).toBeGreaterThan(0);
    });

    it('refuses to complete a run whose batch was never frozen', async () => {
      const open = await seedBatch(isolated.db, 'CS22');
      const run = newRun(open.batchId);
      const code = await expectRejected(isolated.db, async (tx) => {
        await insertRunningClassificationRun(tx, run);
        await insertClassificationResults(tx, allResults(run, open));
        await completeClassificationRun(
          tx,
          run.id,
          await deriveRunDecisionCounts(tx, run.id),
          new Date().toISOString(),
        );
      });
      expect(code).toBe('P0001');
    });
  });
});
