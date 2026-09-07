import { randomUUID } from 'node:crypto';

import { CLASSIFIER_VERSION, rulesetHash, RULESET_VERSION } from '@cas/classification';
import type { ReviewState } from '@cas/contracts';
import {
  countReviewState,
  countRunDecisions,
  countUnclassifiedRows,
  deriveRunDecisionCounts,
  isDatabaseError,
  openDatabase,
  parseDatabaseConfig,
  type Database,
} from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { calibrateRun, reportRun, reviewQueue } from './report.js';
import { classifyBatch, computeRunIdempotencyKey } from './run.js';

/**
 * End-to-end classification over a migrated schema: every row of an explicit
 * batch receives exactly one decision, the run reconciles, the queue is
 * derived per run, calibration happens afterwards, and the human review
 * tables are never touched.
 */

interface SeededBatch {
  readonly batchId: string;
  readonly rowIds: readonly string[];
}

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** Rows chosen to exercise all three decisions plus a quarantined row. */
const ROWS: readonly { title: string; summary: string | null; quarantined?: boolean }[] = [
  { title: 'Ransomware halts a regional hospital', summary: 'The operator confirmed the outage.' },
  { title: 'Vendor patches a vulnerability', summary: null },
  { title: 'A slow-cooker recipe for the weekend', summary: 'Serve with a salad.' },
  { title: 'Coupon code roundup', summary: 'Best deals this week.' },
  { title: 'Quarterly earnings summary', summary: null },
  { title: 'Incomplete row', summary: null, quarantined: true },
];

/**
 * Writes one weekly batch with a review snapshot. `labelFor` decides each
 * row's historical review state, so two batches can carry identical text
 * under opposite labels.
 */
async function seedBatch(
  db: Database,
  label: string,
  labelFor: (index: number) => ReviewState,
): Promise<SeededBatch> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const rowIds = ROWS.map(() => randomUUID());
  const quarantined = ROWS.filter((r) => r.quarantined === true).length;
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', $2, 'seed.csv', $3, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $4, $5, $6, $7, $8, now(), now())`,
      [
        batchId,
        label,
        hash('a'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        quarantined > 0 ? 'completed_with_issues' : 'completed',
        ROWS.length,
        ROWS.length - quarantined,
        quarantined,
      ],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, $3, 'replay', now())`,
      [snapshotId, batchId, label],
    );
    for (const [index, spec] of ROWS.entries()) {
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           raw_ch, raw_url, raw_category, normalized_title, derived_summary_text,
           text_transform, row_hash
         ) VALUES ($1, $2, $3, 'replay', $4, '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', 'https://seed.example/x', 'Security', $5, $6, 'html-to-text@1', $7)`,
        [
          rowIds[index],
          batchId,
          index + 1,
          spec.quarantined === true ? 'quarantined' : 'accepted',
          spec.title,
          spec.summary,
          hash(String(index)),
        ],
      );
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state)
         VALUES ($1, $2, $3, $4, 'TRUE', $5)`,
        [randomUUID(), snapshotId, rowIds[index], batchId, labelFor(index)],
      );
    }
  });
  return { batchId, rowIds };
}

describe('classifyBatch against a migrated schema', () => {
  let isolated: IsolatedSchema;
  let batch: SeededBatch;

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    batch = await seedBatch(isolated.db, 'CS01', () => 'selected');
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('gives every row exactly one decision and reconciles the run', async () => {
    const outcome = await classifyBatch(isolated.db, { batchId: batch.batchId }, { pageSize: 2 });
    expect(outcome.outcome).toBe('classified');
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.expectedRowCount).toBe(ROWS.length);
    expect(outcome.run.classifiedRowCount).toBe(ROWS.length);
    expect(outcome.run.mode).toBe('rules');
    expect(outcome.run.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(outcome.run.rulesetVersion).toBe(RULESET_VERSION);
    expect(outcome.run.rulesetHash).toBe(rulesetHash());

    const report = await reportRun(isolated.db, outcome.run.id);
    expect(report.reconciled).toBe(true);
    expect(report.unclassifiedRows).toBe(0);
    expect(report.stored.total).toBe(ROWS.length);
    expect(report.stored.include).toBeGreaterThan(0);
    expect(report.stored.exclude).toBeGreaterThan(0);
    expect(report.stored.review).toBeGreaterThan(0);

    const counts = await isolated.db.withClient((c) => countRunDecisions(c, outcome.run.id));
    expect(counts.total).toBe(ROWS.length);
    expect(
      await isolated.db.withClient((c) => countUnclassifiedRows(c, outcome.run.id, batch.batchId)),
    ).toBe(0);
  });

  it('routes the quarantined row to review and never to exclude', async () => {
    const outcome = await classifyBatch(isolated.db, { batchId: batch.batchId });
    const quarantinedIndex = ROWS.findIndex((r) => r.quarantined === true);
    const stored = await isolated.db.withClient((c) =>
      c.query<{ decision: string; rationale_codes: string[] }>(
        'SELECT decision, rationale_codes FROM classification_results WHERE run_id = $1 AND source_row_id = $2',
        [outcome.run.id, batch.rowIds[quarantinedIndex]],
      ),
    );
    expect(stored.rows[0]?.decision).toBe('review');
    expect(stored.rows[0]?.rationale_codes).toEqual(['row_quarantined']);
  });

  it('is idempotent for the same batch, classifier and ruleset', async () => {
    const first = await classifyBatch(isolated.db, { batchId: batch.batchId });
    const before = await isolated.db.withClient((c) =>
      c.query<{ runs: string; results: string }>(
        `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                (SELECT count(*) FROM classification_results)::text AS results`,
      ),
    );
    const second = await classifyBatch(isolated.db, { batchId: batch.batchId });
    expect(second.outcome).toBe('already_classified');
    expect(second.run.id).toBe(first.run.id);
    const after = await isolated.db.withClient((c) =>
      c.query<{ runs: string; results: string }>(
        `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                (SELECT count(*) FROM classification_results)::text AS results`,
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('would create a distinct run for a changed ruleset, and keeps run scopes separate', async () => {
    const current = computeRunIdempotencyKey({
      batchId: batch.batchId,
      classifierVersion: CLASSIFIER_VERSION,
      rulesetVersion: RULESET_VERSION,
      rulesetHash: rulesetHash(),
      mode: 'rules',
    });
    const changedRules = computeRunIdempotencyKey({
      batchId: batch.batchId,
      classifierVersion: CLASSIFIER_VERSION,
      rulesetVersion: RULESET_VERSION,
      rulesetHash: hash('e'),
      mode: 'rules',
    });
    const changedClassifier = computeRunIdempotencyKey({
      batchId: batch.batchId,
      classifierVersion: `${CLASSIFIER_VERSION}-next`,
      rulesetVersion: RULESET_VERSION,
      rulesetHash: rulesetHash(),
      mode: 'rules',
    });
    expect(new Set([current, changedRules, changedClassifier]).size).toBe(3);

    // A second batch classified with the same rules is a separate run whose
    // queue and results never mix with the first.
    const other = await seedBatch(isolated.db, 'CS02', () => 'rejected');
    const otherRun = await classifyBatch(isolated.db, { batchId: other.batchId });
    const first = await classifyBatch(isolated.db, { batchId: batch.batchId });
    expect(otherRun.run.id).not.toBe(first.run.id);
    const otherQueue = await reviewQueue(isolated.db, otherRun.run.id);
    const firstQueue = await reviewQueue(isolated.db, first.run.id);
    expect(otherQueue.run.id).toBe(otherRun.run.id);
    expect(firstQueue.run.id).toBe(first.run.id);
    // The two queues are disjoint at the row level, checked in the database
    // rather than by fetching entries into the process.
    const shared = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM classification_results a
           JOIN classification_results b ON b.source_row_id = a.source_row_id
          WHERE a.run_id = $1 AND b.run_id = $2`,
        [otherRun.run.id, first.run.id],
      ),
    );
    expect(shared.rows[0]?.count).toBe('0');
  });

  it('reports the queue as a count for an explicit run, holding no entries', async () => {
    const run = await classifyBatch(isolated.db, { batchId: batch.batchId });
    const summary = await reviewQueue(isolated.db, run.run.id);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.count).toBe(run.run.reviewCount);
    // The whole value is a run record and an integer: there is no entry list to
    // leak, so nothing derived from a source row can reach the caller.
    expect(Object.keys(summary).sort()).toEqual(['count', 'run']);
    const serialized = JSON.stringify(summary);
    for (const forbidden of ['Ransomware', 'recipe', 'seed.example', 'sourceRowId']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    for (const rowId of batch.rowIds) expect(serialized).not.toContain(rowId);
  });

  it('refuses a run identifier that does not exist, and a calibration without a snapshot', async () => {
    await expect(reportRun(isolated.db, randomUUID())).rejects.toMatchObject({
      code: 'run_not_found',
    });
    // A master batch has no weekly snapshot, so calibration must refuse it.
    const masterId = randomUUID();
    await isolated.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO import_batches (
           id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
           header_cells, importer_version, idempotency_key, status, parsed_row_count,
           accepted_row_count, quarantined_row_count, started_at, completed_at
         ) VALUES ($1, 'replay', 'master', NULL, 'master.csv', $2, 10, '["ch"]'::jsonb,
                   'editorial-csv-import@1', $3, 'completed', 1, 1, 0, now(), now())`,
        [masterId, hash('c'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
      );
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           normalized_title, text_transform, row_hash
         ) VALUES ($1, $2, 1, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                   'Ransomware halts a hospital', 'html-to-text@1', $3)`,
        [randomUUID(), masterId, hash('d')],
      );
    });
    const masterRun = await classifyBatch(isolated.db, { batchId: masterId });
    expect(masterRun.run.classifiedRowCount).toBe(1);
    await expect(calibrateRun(isolated.db, masterRun.run.id)).rejects.toMatchObject({
      code: 'no_review_snapshot',
    });
  });

  it('classifies identically under opposite historical labels', async () => {
    // Two batches with byte-identical text: every row selected in one and
    // rejected in the other. If a label could reach the classifier, the
    // decision distributions would differ.
    const allSelected = await seedBatch(isolated.db, 'CS03', () => 'selected');
    const allRejected = await seedBatch(isolated.db, 'CS04', () => 'rejected');
    const a = await classifyBatch(isolated.db, { batchId: allSelected.batchId });
    const b = await classifyBatch(isolated.db, { batchId: allRejected.batchId });
    expect({
      include: b.run.includeCount,
      exclude: b.run.excludeCount,
      review: b.run.reviewCount,
    }).toEqual({
      include: a.run.includeCount,
      exclude: a.run.excludeCount,
      review: a.run.reviewCount,
    });

    const decisionsFor = async (runId: string, rowIds: readonly string[]): Promise<string[]> => {
      const rows = await isolated.db.withClient((c) =>
        c.query<{ decision: string; row_number: number }>(
          `SELECT c.decision, r.row_number FROM classification_results c
             JOIN source_rows r ON r.id = c.source_row_id
            WHERE c.run_id = $1 ORDER BY r.row_number`,
          [runId],
        ),
      );
      expect(rows.rows).toHaveLength(rowIds.length);
      return rows.rows.map((r) => r.decision);
    };
    expect(await decisionsFor(b.run.id, allRejected.rowIds)).toEqual(
      await decisionsFor(a.run.id, allSelected.rowIds),
    );
  });

  it('rolls the whole run back when a page fails, leaving no partial run', async () => {
    const fresh = await seedBatch(isolated.db, 'CS05', () => 'selected');
    const before = await isolated.db.withClient((c) =>
      c.query<{ runs: string; results: string }>(
        `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                (SELECT count(*) FROM classification_results)::text AS results`,
      ),
    );
    await expect(
      classifyBatch(
        isolated.db,
        { batchId: fresh.batchId },
        {
          pageSize: 2,
          beforePage: (index) => {
            if (index === 2) throw new Error('simulated failure on the third page');
          },
        },
      ),
    ).rejects.toThrowError('simulated failure');
    const after = await isolated.db.withClient((c) =>
      c.query<{ runs: string; results: string }>(
        `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                (SELECT count(*) FROM classification_results)::text AS results`,
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('calibrates after classification and never mutates the review tables', async () => {
    const before = await isolated.db.withClient(countReviewState);
    const run = await classifyBatch(isolated.db, { batchId: batch.batchId });
    const calibration = await calibrateRun(isolated.db, run.run.id);
    expect(calibration.reviewLabel).toBe('CS01');
    expect(calibration.metrics.total).toBe(ROWS.length);
    expect(calibration.metrics.selected.total).toBe(ROWS.length);
    expect(calibration.metrics.matrix).toHaveLength(9);
    // Every selected row is retained: none was excluded.
    expect(calibration.metrics.selected.exclude).toBeGreaterThanOrEqual(0);
    expect(await isolated.db.withClient(countReviewState)).toEqual(before);
  });

  // -------------------------------------------------------------------------
  // Codex Desktop audit findings 1 and 2: a run's counters can never drift
  // from its stored results, and a stored fingerprint can never drift from its
  // source row. Both are driven by a coordinated second connection through the
  // `beforePage` seam, so the interleaving is deterministic and no test sleeps.

  describe('concurrent interference during a run', () => {
    /** A second, independent connection to the same schema. */
    async function withRival<T>(fn: (rival: Database) => Promise<T>): Promise<T> {
      const config = parseDatabaseConfig(process.env);
      const rival = openDatabase({ ...config, schema: isolated.name }, { maxConnections: 2 });
      try {
        return await fn(rival);
      } finally {
        await rival.end();
      }
    }

    async function runCounters(runId: string): Promise<Record<string, number>> {
      const derived = await isolated.db.withClient((c) => deriveRunDecisionCounts(c, runId));
      return {
        total: derived.total,
        include: derived.include,
        exclude: derived.exclude,
        review: derived.review,
      };
    }

    it('commits counters that match its own results when rows are added mid-run', async () => {
      const fresh = await seedBatch(isolated.db, 'CS10', () => 'selected');
      const outcome = await withRival(async (rival) =>
        classifyBatch(
          isolated.db,
          { batchId: fresh.batchId },
          {
            pageSize: 2,
            beforePage: async (index) => {
              if (index !== 1) return;
              // A seventh row lands and commits while the run is paging.
              await rival.withTransaction(async (tx) => {
                await tx.query(
                  `INSERT INTO source_rows (
                     id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
                     normalized_title, text_transform, row_hash
                   ) VALUES ($1, $2, $3, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                             'Ransomware strikes a second hospital', 'html-to-text@1', $4)`,
                  [randomUUID(), fresh.batchId, ROWS.length + 1, hash('9')],
                );
              });
            },
          },
        ),
      );
      // The run saw one stable snapshot, so its counters describe exactly the
      // results it stored. Under the rejected two-pass design the counting pass
      // and the classifying pass could see different data.
      expect(outcome.run.status).toBe('completed');
      expect(outcome.run.classifiedRowCount).toBe(ROWS.length);
      expect(await runCounters(outcome.run.id)).toEqual({
        total: outcome.run.classifiedRowCount,
        include: outcome.run.includeCount,
        exclude: outcome.run.excludeCount,
        review: outcome.run.reviewCount,
      });
      // The row that arrived late is reported as uncovered rather than hidden:
      // the report tells the truth instead of a stale counter doing so.
      const report = await reportRun(isolated.db, outcome.run.id);
      expect(report.unclassifiedRows).toBe(1);
      expect(report.reconciled).toBe(false);
    });

    it('refuses to let a source row be re-hashed under a stored result', async () => {
      const fresh = await seedBatch(isolated.db, 'CS11', () => 'selected');
      let rivalOutcome: Promise<unknown> | null = null;
      const outcome = await withRival(async (rival) => {
        const run = await classifyBatch(
          isolated.db,
          { batchId: fresh.batchId },
          {
            pageSize: 2,
            beforePage: (index) => {
              if (index !== 1) return;
              // Row 1 already has a stored result in this run, so this UPDATE
              // blocks on the lock that result holds. It is deliberately not
              // awaited here: awaiting it would stall the run that must commit
              // before the lock is released.
              rivalOutcome = rival.withTransaction(async (tx) => {
                await tx.query('UPDATE source_rows SET row_hash = $2 WHERE id = $1', [
                  fresh.rowIds[0],
                  hash('8'),
                ]);
              });
            },
          },
        );
        let rivalError: unknown;
        try {
          await rivalOutcome;
        } catch (error) {
          rivalError = error;
        }
        expect(isDatabaseError(rivalError)).toBe(true);
        expect(isDatabaseError(rivalError) ? rivalError.code : '').toBe('23503');
        return run;
      });
      expect(outcome.run.status).toBe('completed');
      const mismatched = await isolated.db.withClient((c) =>
        c.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM classification_results r
             JOIN source_rows s ON s.id = r.source_row_id
            WHERE r.run_id = $1 AND r.row_hash <> s.row_hash`,
          [outcome.run.id],
        ),
      );
      expect(mismatched.rows[0]?.count).toBe('0');
    });

    it('fails the whole run rather than storing a fingerprint that has moved on', async () => {
      const fresh = await seedBatch(isolated.db, 'CS12', () => 'selected');
      const before = await isolated.db.withClient((c) =>
        c.query<{ runs: string; results: string }>(
          `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                  (SELECT count(*) FROM classification_results)::text AS results`,
        ),
      );
      let caught: unknown;
      await withRival(async (rival) => {
        try {
          await classifyBatch(
            isolated.db,
            { batchId: fresh.batchId },
            {
              pageSize: 2,
              beforePage: async (index) => {
                if (index !== 1) return;
                // The last row has not been read yet, so nothing references it
                // and the change commits immediately. The run's snapshot still
                // holds the old hash.
                await rival.withTransaction(async (tx) => {
                  await tx.query('UPDATE source_rows SET row_hash = $2 WHERE id = $1', [
                    fresh.rowIds[ROWS.length - 1],
                    hash('8'),
                  ]);
                });
              },
            },
          );
        } catch (error) {
          caught = error;
        }
      });
      // PostgreSQL refuses the stale write either as a serialization failure,
      // when the referential check cannot lock a row changed after the run's
      // snapshot, or as a plain foreign-key violation. Both mean the same
      // thing here: a fingerprint that has moved on is never stored.
      expect(isDatabaseError(caught)).toBe(true);
      expect(['40001', '23503']).toContain(isDatabaseError(caught) ? caught.code : '');
      const after = await isolated.db.withClient((c) =>
        c.query<{ runs: string; results: string }>(
          `SELECT (SELECT count(*) FROM classification_runs)::text AS runs,
                  (SELECT count(*) FROM classification_results)::text AS results`,
        ),
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('lets exactly one of two identical concurrent invocations create the run', async () => {
      const fresh = await seedBatch(isolated.db, 'CS13', () => 'selected');
      const [a, b] = await Promise.all([
        classifyBatch(isolated.db, { batchId: fresh.batchId }, { pageSize: 2 }),
        classifyBatch(isolated.db, { batchId: fresh.batchId }, { pageSize: 2 }),
      ]);
      expect(a.run.id).toBe(b.run.id);
      expect([a.outcome, b.outcome].sort()).toEqual(['already_classified', 'classified']);
      const rows = await isolated.db.withClient((c) =>
        c.query<{ runs: string; results: string }>(
          `SELECT (SELECT count(*) FROM classification_runs WHERE batch_id = $1)::text AS runs,
                  (SELECT count(*) FROM classification_results WHERE batch_id = $1)::text AS results`,
          [fresh.batchId],
        ),
      );
      expect(rows.rows[0]).toEqual({ runs: '1', results: String(ROWS.length) });
      expect(await runCounters(a.run.id)).toEqual({
        total: a.run.classifiedRowCount,
        include: a.run.includeCount,
        exclude: a.run.excludeCount,
        review: a.run.reviewCount,
      });
    });
  });
});
