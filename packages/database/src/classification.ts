import type { ClassificationDecision, DataOrigin, ReviewState } from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';
import { MAX_ROWS_PER_INSERT } from './ingestion.js';

/**
 * Parameterized operations over the classification tables (migration 0003).
 *
 * Two rules shape this module. First, the classification input query loads
 * only the fields the classifier is allowed to read and never joins the human
 * review tables, so a historical label cannot reach a decision. Second, the
 * calibration query runs only over completed results and returns counts, so a
 * label is compared with a decision after the fact and never influences it.
 */

export interface NewClassificationRun {
  readonly id: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly classifierVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetHash: string;
  readonly mode: 'rules';
  readonly idempotencyKey: string;
  readonly expectedRowCount: number;
  readonly startedAt: string;
}

export type ClassificationRunStatus = 'running' | 'completed';

export interface ClassificationRunRecord extends NewClassificationRun {
  readonly status: ClassificationRunStatus;
  readonly classifiedRowCount: number;
  readonly includeCount: number;
  readonly excludeCount: number;
  readonly reviewCount: number;
  readonly completedAt: string | null;
}

export interface NewClassificationResult {
  readonly id: string;
  readonly runId: string;
  readonly batchId: string;
  readonly sourceRowId: string;
  readonly decision: ClassificationDecision;
  readonly rationaleCodes: readonly string[];
  readonly matchedSignals: readonly string[];
  readonly signalScore: number;
  readonly rowHash: string;
  readonly createdAt: string;
}

export interface DecisionCounts {
  readonly include: number;
  readonly exclude: number;
  readonly review: number;
  readonly total: number;
}

/** Exactly the fields the classifier may read (decision D21). */
export interface ClassificationInputRow {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly status: 'accepted' | 'quarantined';
  readonly rowNumber: number;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
}

const RUN_COLUMNS = `id, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash,
  mode, idempotency_key, status, expected_row_count, classified_row_count, include_count,
  exclude_count, review_count, to_json(started_at) #>> '{}' AS started_at,
  to_json(completed_at) #>> '{}' AS completed_at`;

interface RunRow {
  id: string;
  batch_id: string;
  data_origin: DataOrigin;
  classifier_version: string;
  ruleset_version: string;
  ruleset_hash: string;
  mode: 'rules';
  idempotency_key: string;
  status: ClassificationRunStatus;
  expected_row_count: number;
  classified_row_count: number;
  include_count: number;
  exclude_count: number;
  review_count: number;
  started_at: string;
  completed_at: string | null;
}

function toRunRecord(row: RunRow): ClassificationRunRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    classifierVersion: row.classifier_version,
    rulesetVersion: row.ruleset_version,
    rulesetHash: row.ruleset_hash,
    mode: row.mode,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    expectedRowCount: row.expected_row_count,
    classifiedRowCount: row.classified_row_count,
    includeCount: row.include_count,
    excludeCount: row.exclude_count,
    reviewCount: row.review_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function findClassificationRunByIdempotencyKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<ClassificationRunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM classification_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRunRecord(row);
}

export async function getClassificationRun(
  client: Queryable,
  id: string,
): Promise<ClassificationRunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM classification_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRunRecord(row);
}

export async function listClassificationRuns(
  client: Queryable,
  batchId: string | null,
): Promise<ClassificationRunRecord[]> {
  const result =
    batchId === null
      ? await client.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM classification_runs ORDER BY started_at, id`,
        )
      : await client.query<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM classification_runs WHERE batch_id = $1 ORDER BY started_at, id`,
          [batchId],
        );
  return result.rows.map(toRunRecord);
}

/** The batch's stored row count, which a completed run must match exactly. */
export async function countBatchSourceRows(client: Queryable, batchId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM source_rows WHERE batch_id = $1',
    [batchId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * One bounded page of classification inputs, ordered by the row's stable
 * logical number and continued with a keyset cursor, so the whole batch is
 * never held in memory at once. Selects no raw cell, no URL, no publisher
 * category, no `ch` value and no review state, and joins no review table.
 */
export async function fetchClassificationInputs(
  client: Queryable,
  batchId: string,
  options: { readonly afterRowNumber: number; readonly limit: number },
): Promise<ClassificationInputRow[]> {
  if (options.limit < 1 || options.limit > 1000) {
    throw new DatabaseError('query', 'classification input page size out of range');
  }
  const result = await client.query<{
    id: string;
    row_hash: string;
    status: 'accepted' | 'quarantined';
    row_number: number;
    normalized_title: string | null;
    derived_summary_text: string | null;
    derived_description_text: string | null;
  }>(
    `SELECT id, row_hash, status, row_number, normalized_title,
            derived_summary_text, derived_description_text
       FROM source_rows
      WHERE batch_id = $1 AND row_number > $2
      ORDER BY row_number
      LIMIT $3`,
    [batchId, options.afterRowNumber, options.limit],
  );
  return result.rows.map((row) => ({
    sourceRowId: row.id,
    rowHash: row.row_hash,
    status: row.status,
    rowNumber: row.row_number,
    normalizedTitle: row.normalized_title,
    derivedSummaryText: row.derived_summary_text,
    derivedDescriptionText: row.derived_description_text,
  }));
}

/**
 * Freezes the batch's source set, and returns when it was frozen.
 *
 * This is the classifier's first statement, so it does three things at once:
 * it establishes the transaction's repeatable-read snapshot, it takes the
 * batch row's write lock, and it makes the source set immutable from that
 * point on. Migration 0005 supplies the other half: every source-row mutation
 * updates the same batch row, refusing the mutation when the batch is already
 * frozen. A mutation that committed first is therefore inside this snapshot, a
 * mutation still in flight is refused when it reaches its own update, and a
 * mutation that committed while this statement waited for the lock makes this
 * statement fail with a serialization error rather than silently missing a
 * row. Freezing an already-frozen batch keeps the original timestamp.
 */
export async function freezeBatchSourceSet(
  client: Queryable,
  batchId: string,
): Promise<{ readonly frozenAt: string; readonly sourceSetVersion: number }> {
  const result = await client.query<{ frozen_at: string; source_set_version: number }>(
    `UPDATE import_batches
        SET source_set_frozen_at = COALESCE(source_set_frozen_at, now())
      WHERE id = $1
      RETURNING to_json(source_set_frozen_at) #>> '{}' AS frozen_at, source_set_version`,
    [batchId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DatabaseError('query', 'import batch not found while freezing its source set', {
      details: { batchId },
    });
  }
  return { frozenAt: row.frozen_at, sourceSetVersion: row.source_set_version };
}

/**
 * Inserts the run in the `running` state with zero counters.
 *
 * A run is never inserted as already complete: migration 0004 opens the
 * running state precisely so that completion is a separate, independently
 * validated transition. Inserting first also makes the unique idempotency key
 * the concurrency gate, so two identical invocations cannot both proceed.
 */
export async function insertRunningClassificationRun(
  client: Queryable,
  run: NewClassificationRun,
): Promise<void> {
  await client.query(
    `INSERT INTO classification_runs (
       id, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash, mode,
       idempotency_key, status, expected_row_count, classified_row_count, include_count,
       exclude_count, review_count, started_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, 0, 0, 0, 0,
               $10::timestamptz, NULL)`,
    [
      run.id,
      run.batchId,
      run.dataOrigin,
      run.classifierVersion,
      run.rulesetVersion,
      run.rulesetHash,
      run.mode,
      run.idempotencyKey,
      run.expectedRowCount,
      run.startedAt,
    ],
  );
}

/** Decision counts derived from the results actually stored for a run. */
export async function deriveRunDecisionCounts(
  client: Queryable,
  runId: string,
): Promise<DecisionCounts> {
  const result = await client.query<{
    total: string;
    include: string;
    exclude: string;
    review: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE decision = 'include')::text AS include,
            count(*) FILTER (WHERE decision = 'exclude')::text AS exclude,
            count(*) FILTER (WHERE decision = 'review')::text AS review
       FROM classification_results WHERE run_id = $1`,
    [runId],
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? '0'),
    include: Number(row?.include ?? '0'),
    exclude: Number(row?.exclude ?? '0'),
    review: Number(row?.review ?? '0'),
  };
}

/**
 * Transitions a running run to `completed` with counters derived from its
 * stored results. The database trigger added by migration 0004 re-derives
 * every counter itself and refuses the transition unless the run covers its
 * batch exactly, so a fabricated but internally consistent set of counters
 * cannot complete a run even through a direct UPDATE.
 */
export async function completeClassificationRun(
  client: Queryable,
  runId: string,
  counts: DecisionCounts,
  completedAt: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE classification_runs
        SET status = 'completed', classified_row_count = $2, include_count = $3,
            exclude_count = $4, review_count = $5, completed_at = $6::timestamptz
      WHERE id = $1 AND status = 'running'`,
    [runId, counts.total, counts.include, counts.exclude, counts.review, completedAt],
  );
  if (result.rowCount !== 1) {
    throw new DatabaseError('query', 'classification run was not in a completable state', {
      details: { runId },
    });
  }
}

const RESULT_COLUMNS = [
  'id',
  'run_id',
  'batch_id',
  'source_row_id',
  'decision',
  'rationale_codes',
  'matched_signals',
  'signal_score',
  'row_hash',
  'created_at',
] as const;

const RESULT_CASTS: readonly string[] = RESULT_COLUMNS.map((column) => {
  if (column === 'rationale_codes' || column === 'matched_signals') return 'jsonb';
  if (column === 'created_at') return 'timestamptz';
  return '';
});

function valuesList(rowCount: number, columnCount: number, casts: readonly string[]): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const params: string[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const cast = casts[c] ?? '';
      params.push(`$${r * columnCount + c + 1}${cast === '' ? '' : `::${cast}`}`);
    }
    rows.push(`(${params.join(', ')})`);
  }
  return rows.join(',\n');
}

export async function insertClassificationResults(
  client: Queryable,
  results: readonly NewClassificationResult[],
): Promise<void> {
  if (results.length === 0) return;
  if (results.length > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError(
      'query',
      `refusing to insert more than ${MAX_ROWS_PER_INSERT} classification results`,
    );
  }
  const values: unknown[] = [];
  for (const row of results) {
    values.push(
      row.id,
      row.runId,
      row.batchId,
      row.sourceRowId,
      row.decision,
      JSON.stringify(row.rationaleCodes),
      JSON.stringify(row.matchedSignals),
      row.signalScore,
      row.rowHash,
      row.createdAt,
    );
  }
  await client.query(
    `INSERT INTO classification_results (${RESULT_COLUMNS.join(', ')}) VALUES\n${valuesList(
      results.length,
      RESULT_COLUMNS.length,
      RESULT_CASTS,
    )}`,
    values,
  );
}

// ---------------------------------------------------------------------------
// Count-only reads.

export async function countRunDecisions(client: Queryable, runId: string): Promise<DecisionCounts> {
  const result = await client.query<{ decision: ClassificationDecision; count: string }>(
    `SELECT decision, count(*)::text AS count FROM classification_results
      WHERE run_id = $1 GROUP BY decision`,
    [runId],
  );
  const counts = { include: 0, exclude: 0, review: 0 };
  for (const row of result.rows) counts[row.decision] = Number(row.count);
  return { ...counts, total: counts.include + counts.exclude + counts.review };
}

export interface RationaleCodeCount {
  readonly code: string;
  readonly count: number;
}

export async function countRunRationaleCodes(
  client: Queryable,
  runId: string,
): Promise<RationaleCodeCount[]> {
  const result = await client.query<{ code: string; count: string }>(
    `SELECT code, count(*)::text AS count
       FROM classification_results, jsonb_array_elements_text(rationale_codes) AS code
      WHERE run_id = $1
      GROUP BY code ORDER BY code`,
    [runId],
  );
  return result.rows.map((row) => ({ code: row.code, count: Number(row.count) }));
}

/** Rows whose stored result is missing, which must always be zero after a completed run. */
export async function countUnclassifiedRows(
  client: Queryable,
  runId: string,
  batchId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM source_rows r
      WHERE r.batch_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM classification_results c
           WHERE c.run_id = $1 AND c.source_row_id = r.id)`,
    [runId, batchId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * The size of the needs-review queue for one run, as a single aggregate. The
 * CLI reports this count and nothing else; rows are never fetched to be
 * counted.
 */
export async function countReviewQueue(client: Queryable, runId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM classification_results WHERE run_id = $1 AND decision = 'review'",
    [runId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export interface QueueEntry {
  readonly sourceRowId: string;
  readonly rowNumber: number;
  readonly rationaleCodes: readonly string[];
  readonly signalScore: number;
}

/**
 * The needs-review queue for one explicit run, row by row. Derived, never
 * copied into the human review tables, and never defaulted to a "latest" run.
 * Returns no source text.
 *
 * This is a typed programmatic boundary for the authenticated review
 * interface that Sprint 6 will build. The command-line interface must not use
 * it: its queue command reports `countReviewQueue` only.
 */
export async function fetchReviewQueue(
  client: Queryable,
  runId: string,
  options: { readonly afterRowNumber: number; readonly limit: number },
): Promise<QueueEntry[]> {
  if (options.limit < 1 || options.limit > 1000) {
    throw new DatabaseError('query', 'queue page size out of range');
  }
  const result = await client.query<{
    source_row_id: string;
    row_number: number;
    rationale_codes: string[];
    signal_score: number;
  }>(
    `SELECT c.source_row_id, r.row_number, c.rationale_codes, c.signal_score
       FROM classification_results c
       JOIN source_rows r ON r.id = c.source_row_id
      WHERE c.run_id = $1 AND c.decision = 'review' AND r.row_number > $2
      ORDER BY r.row_number
      LIMIT $3`,
    [runId, options.afterRowNumber, options.limit],
  );
  return result.rows.map((row) => ({
    sourceRowId: row.source_row_id,
    rowNumber: row.row_number,
    rationaleCodes: row.rationale_codes,
    signalScore: row.signal_score,
  }));
}

export interface CalibrationMatrixCell {
  readonly decision: ClassificationDecision;
  readonly reviewState: ReviewState;
  readonly count: number;
}

/**
 * The count-only confusion matrix for one completed run, produced by joining
 * results to the batch's weekly review entries. This is the only query in the
 * package that touches both a machine decision and a human label, and it runs
 * strictly after classification. Returns counts only; no identifier of a row
 * and no source text leaves this query.
 */
export async function fetchCalibrationMatrix(
  client: Queryable,
  runId: string,
): Promise<CalibrationMatrixCell[]> {
  const result = await client.query<{
    decision: ClassificationDecision;
    review_state: ReviewState;
    count: string;
  }>(
    `SELECT c.decision, e.review_state, count(*)::text AS count
       FROM classification_results c
       JOIN review_entries e ON e.source_row_id = c.source_row_id
      WHERE c.run_id = $1
      GROUP BY c.decision, e.review_state
      ORDER BY c.decision, e.review_state`,
    [runId],
  );
  return result.rows.map((row) => ({
    decision: row.decision,
    reviewState: row.review_state,
    count: Number(row.count),
  }));
}

/** Whether the batch has a weekly review snapshot, and its label. */
export async function findBatchReviewSnapshot(
  client: Queryable,
  batchId: string,
): Promise<{ readonly snapshotId: string; readonly reviewLabel: string } | null> {
  const result = await client.query<{ id: string; review_label: string }>(
    'SELECT id, review_label FROM review_snapshots WHERE batch_id = $1',
    [batchId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { snapshotId: row.id, reviewLabel: row.review_label };
}

/** Count-only fingerprint of the human review tables, used to prove classification changed nothing. */
export async function countReviewState(client: Queryable): Promise<{
  readonly snapshots: number;
  readonly entries: number;
  readonly selected: number;
  readonly rejected: number;
  readonly unreviewed: number;
}> {
  const result = await client.query<{
    snapshots: string;
    entries: string;
    selected: string;
    rejected: string;
    unreviewed: string;
  }>(
    `SELECT (SELECT count(*) FROM review_snapshots)::text AS snapshots,
            (SELECT count(*) FROM review_entries)::text AS entries,
            (SELECT count(*) FROM review_entries WHERE review_state = 'selected')::text AS selected,
            (SELECT count(*) FROM review_entries WHERE review_state = 'rejected')::text AS rejected,
            (SELECT count(*) FROM review_entries WHERE review_state = 'unreviewed')::text AS unreviewed`,
  );
  const row = result.rows[0];
  return {
    snapshots: Number(row?.snapshots ?? '0'),
    entries: Number(row?.entries ?? '0'),
    selected: Number(row?.selected ?? '0'),
    rejected: Number(row?.rejected ?? '0'),
    unreviewed: Number(row?.unreviewed ?? '0'),
  };
}
