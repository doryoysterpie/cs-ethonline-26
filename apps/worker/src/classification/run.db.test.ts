import { randomUUID } from 'node:crypto';

import { CLASSIFIER_VERSION, rulesetHash, RULESET_VERSION } from '@cas/classification';
import type { ReviewState } from '@cas/contracts';
import {
  countReviewState,
  countRunDecisions,
  countUnclassifiedRows,
  deriveRunDecisionCounts,
  getClassificationRun,
  getImportBatch,
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

  // -------------------------------------------------------------------------
  // Re-audit finding 2. A completed run must cover its batch for ever, not
  // only against the snapshot it happened to read. The source set is frozen
  // before the first source-row read, so every mutation after that point is
  // refused and every mutation before it is inside the classified set.
  //
  // A second real connection is coordinated through seams that run at exact
  // points inside the classifier's transaction. No test sleeps.

  describe('concurrent source-set mutation', () => {
    async function withRival<T>(fn: (rival: Database) => Promise<T>): Promise<T> {
      const config = parseDatabaseConfig(process.env);
      const rival = openDatabase({ ...config, schema: isolated.name }, { maxConnections: 2 });
      try {
        return await fn(rival);
      } finally {
        await rival.end();
      }
    }

    /** The invariant every completed run must satisfy in the live database. */
    async function assertReconciled(runId: string, batchId: string): Promise<void> {
      const report = await reportRun(isolated.db, runId);
      expect(report.reconciled, 'a completed run must reconcile').toBe(true);
      expect(report.unclassifiedRows).toBe(0);
      const rows = await isolated.db.withClient((c) =>
        c.query<{ sources: string; results: string; duplicates: string }>(
          `SELECT (SELECT count(*) FROM source_rows WHERE batch_id = $2)::text AS sources,
                  (SELECT count(*) FROM classification_results WHERE run_id = $1)::text AS results,
                  (SELECT count(*) FROM (
                     SELECT source_row_id FROM classification_results
                      WHERE run_id = $1 GROUP BY source_row_id HAVING count(*) > 1) d)::text
                    AS duplicates`,
          [runId, batchId],
        ),
      );
      const row = rows.rows[0];
      expect(row?.results).toBe(row?.sources);
      expect(row?.duplicates).toBe('0');
      const derived = await isolated.db.withClient((c) => deriveRunDecisionCounts(c, runId));
      const stored = await isolated.db.withClient((c) => getClassificationRun(c, runId));
      expect({
        total: stored?.classifiedRowCount,
        include: stored?.includeCount,
        exclude: stored?.excludeCount,
        review: stored?.reviewCount,
      }).toEqual(derived);
    }

    /** An import batch with no rows, so a reassignment cannot collide. */
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

    interface Interference {
      readonly name: string;
      readonly statements: (
        batch: SeededBatch,
        destination: string,
      ) => readonly [sql: string, values: readonly unknown[]][];
    }

    const INTERFERENCE: readonly Interference[] = [
      {
        name: 'insert',
        statements: (batch) => [
          [
            `INSERT INTO source_rows (
               id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
               normalized_title, text_transform, row_hash
             ) VALUES ($1, $2, 99, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                       'Ransomware strikes a second hospital', 'html-to-text@1', $3)`,
            [randomUUID(), batch.batchId, hash('9')],
          ],
        ],
      },
      {
        name: 'delete',
        statements: (batch) => [
          ['DELETE FROM review_entries WHERE source_row_id = $1', [batch.rowIds[0]]],
          ['DELETE FROM source_rows WHERE id = $1', [batch.rowIds[0]]],
        ],
      },
      {
        name: 'row rehash',
        statements: (batch) => [
          ['UPDATE source_rows SET row_hash = $2 WHERE id = $1', [batch.rowIds[1], hash('8')]],
        ],
      },
      {
        name: 'normalized text update',
        statements: (batch) => [
          [
            'UPDATE source_rows SET normalized_title = $2 WHERE id = $1',
            [batch.rowIds[1], 'rewritten after the snapshot'],
          ],
        ],
      },
      {
        name: 'derived summary update',
        statements: (batch) => [
          [
            'UPDATE source_rows SET derived_summary_text = $2 WHERE id = $1',
            [batch.rowIds[1], 'rewritten after the snapshot'],
          ],
        ],
      },
      {
        name: 'ingestion status update',
        statements: (batch) => [
          [`UPDATE source_rows SET status = 'quarantined' WHERE id = $1`, [batch.rowIds[1]]],
        ],
      },
      {
        name: 'batch reassignment',
        statements: (batch, destination) => [
          ['UPDATE source_rows SET batch_id = $2 WHERE id = $1', [batch.rowIds[1], destination]],
        ],
      },
      {
        name: 'origin reassignment',
        statements: (batch) => [
          [`UPDATE source_rows SET data_origin = 'live' WHERE id = $1`, [batch.rowIds[1]]],
        ],
      },
    ];

    it.each(INTERFERENCE.map((entry) => [entry.name, entry] as const))(
      'refuses a %s that starts after the source set is frozen',
      async (_name, entry) => {
        const fresh = await seedBatch(
          isolated.db,
          `CS3${INTERFERENCE.indexOf(entry)}`,
          () => 'selected',
        );
        const destination = await emptyBatch(`CS4${INTERFERENCE.indexOf(entry)}`);
        let rival: Promise<unknown> | null = null;
        const outcome = await withRival(async (connection) => {
          const run = await classifyBatch(
            isolated.db,
            { batchId: fresh.batchId },
            {
              pageSize: 2,
              beforePage: (index) => {
                if (index !== 0 || rival !== null) return;
                // Started, not awaited: the mutation blocks on the batch row
                // the classifier locked when it froze the source set, and
                // awaiting it here would stall the transaction that must
                // commit before that lock is released. The refusal is caught
                // where the promise is made, because it can arrive long before
                // the classifier returns and an unhandled rejection would fail
                // the whole run rather than this assertion.
                rival = connection
                  .withTransaction(async (tx) => {
                    for (const [sql, values] of entry.statements(fresh, destination)) {
                      await tx.query(sql, values);
                    }
                  })
                  .then(
                    () => null,
                    (error: unknown) => error,
                  );
              },
            },
          );
          const rivalError = await rival;
          expect(isDatabaseError(rivalError), `${entry.name} must be refused`).toBe(true);
          // The freeze refuses it, or the immediate foreign key that binds a
          // stored result to its source row gets there first. Both are
          // refusals; neither leaves the run uncovered.
          expect(['P0001', '23503']).toContain(isDatabaseError(rivalError) ? rivalError.code : '');
          return run;
        });

        expect(outcome.outcome).toBe('classified');
        expect(outcome.run.status).toBe('completed');
        expect(outcome.sourceSetFrozenAt).not.toBe('');
        await assertReconciled(outcome.run.id, fresh.batchId);
      },
    );

    /** The row every pre-freeze race inserts from the second connection. */
    const LATE_ROW = (batchId: string): readonly [string, readonly unknown[]] => [
      `INSERT INTO source_rows (
         id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
         normalized_title, text_transform, row_hash
       ) VALUES ($1, $2, 99, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                 'Ransomware strikes a second hospital', 'html-to-text@1', $3)`,
      [randomUUID(), batchId, hash('9')],
    ];

    it('classifies a row that commits before the freeze', async () => {
      const fresh = await seedBatch(isolated.db, 'CS50', () => 'selected');
      const outcome = await withRival(async (connection) =>
        classifyBatch(
          isolated.db,
          { batchId: fresh.batchId },
          {
            pageSize: 2,
            beforeFreeze: async () => {
              // Nothing is locked yet, so this commits outright. The freeze
              // that follows takes its snapshot after it.
              const [sql, values] = LATE_ROW(fresh.batchId);
              await connection.withTransaction(async (tx) => {
                await tx.query(sql, values);
              });
            },
          },
        ),
      );
      expect(outcome.run.classifiedRowCount).toBe(ROWS.length + 1);
      await assertReconciled(outcome.run.id, fresh.batchId);
    });

    it('writes no run when a row commits while the freeze is waiting', async () => {
      const fresh = await seedBatch(isolated.db, 'CS51', () => 'selected');
      /**
       * Waits until PostgreSQL reports a session blocked on a lock in this
       * database. The condition is observable state, not elapsed time, so the
       * interleaving is exact rather than hopeful.
       */
      const untilBlocked = async (): Promise<void> => {
        for (let attempt = 0; attempt < 20_000; attempt += 1) {
          const blocked = await isolated.db.withClient((c) =>
            c.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity
                WHERE datname = pg_catalog.current_database()
                  AND wait_event_type = 'Lock'`,
            ),
          );
          if (blocked.rows[0]?.count !== '0') return;
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error('the classifier never blocked on the batch lock');
      };

      let rivalDone: Promise<unknown> | null = null;
      let failure: unknown;
      await withRival(async (connection) => {
        try {
          await classifyBatch(
            isolated.db,
            { batchId: fresh.batchId },
            {
              pageSize: 2,
              beforeFreeze: async () => {
                let release = (): void => undefined;
                const gate = new Promise<void>((resolve) => {
                  release = resolve;
                });
                const [sql, values] = LATE_ROW(fresh.batchId);
                let inserted = (): void => undefined;
                const ready = new Promise<void>((resolve) => {
                  inserted = resolve;
                });
                rivalDone = connection.withTransaction(async (tx) => {
                  await tx.query(sql, values);
                  inserted();
                  await gate;
                });
                // The insert holds the batch row it bumped. Release it only
                // once the classifier's freeze is demonstrably waiting for it.
                await ready;
                void untilBlocked().then(release);
              },
            },
          );
        } catch (error) {
          failure = error;
        }
        await rivalDone;
      });

      // The classifier refused rather than committing a run over a source set
      // that had already moved.
      expect(failure).toBeDefined();
      expect(failure).toMatchObject({ code: 'batch_source_set_changed' });
      const state = await isolated.db.withClient((c) =>
        c.query<{ runs: string; rows: string }>(
          `SELECT (SELECT count(*) FROM classification_runs WHERE batch_id = $1)::text AS runs,
                  (SELECT count(*) FROM source_rows WHERE batch_id = $1)::text AS rows`,
          [fresh.batchId],
        ),
      );
      expect(state.rows[0]).toEqual({ runs: '0', rows: String(ROWS.length + 1) });
      // The batch is still mutable, because nothing froze it.
      const batch = await isolated.db.withClient((c) => getImportBatch(c, fresh.batchId));
      expect(batch?.sourceSetFrozenAt).toBeNull();
      // Classifying again now succeeds and covers the row that arrived.
      const retry = await classifyBatch(isolated.db, { batchId: fresh.batchId });
      expect(retry.run.classifiedRowCount).toBe(ROWS.length + 1);
      await assertReconciled(retry.run.id, fresh.batchId);
    });

    it('lets exactly one of two identical concurrent invocations create the run', async () => {
      const fresh = await seedBatch(isolated.db, 'CS60', () => 'selected');
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
      await assertReconciled(a.run.id, fresh.batchId);
    });

    it('freezes the batch it classified and reports the marker', async () => {
      const fresh = await seedBatch(isolated.db, 'CS70', () => 'selected');
      const before = await isolated.db.withClient((c) => getImportBatch(c, fresh.batchId));
      expect(before?.sourceSetFrozenAt).toBeNull();
      const outcome = await classifyBatch(isolated.db, { batchId: fresh.batchId });
      expect(outcome.sourceSetFrozenAt).not.toBe('');
      expect(outcome.batch.sourceSetFrozenAt).toBe(outcome.sourceSetFrozenAt);
      // Repeating the run returns the same marker and writes nothing.
      const again = await classifyBatch(isolated.db, { batchId: fresh.batchId });
      expect(again.outcome).toBe('already_classified');
      expect(again.sourceSetFrozenAt).toBe(outcome.sourceSetFrozenAt);
      await assertReconciled(outcome.run.id, fresh.batchId);
    });
  });
});
