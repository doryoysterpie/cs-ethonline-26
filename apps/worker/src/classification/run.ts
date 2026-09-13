import { createHash, randomUUID } from 'node:crypto';

import {
  classify,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  rulesetHash,
  RULESET_VERSION,
  type ClassificationInput,
} from '@cas/classification';
import {
  completeClassificationRun,
  countBatchSourceRows,
  countUnclassifiedRows,
  deriveRunDecisionCounts,
  fetchClassificationInputs,
  findClassificationRunByIdempotencyKey,
  freezeBatchSourceSet,
  getClassificationRun,
  getImportBatch,
  insertClassificationResults,
  insertRunningClassificationRun,
  isDatabaseError,
  MAX_ROWS_PER_INSERT,
  type ClassificationRunRecord,
  type Database,
  type ImportBatchRecord,
  type NewClassificationResult,
  type Queryable,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/**
 * Classification orchestration (decision D21), corrected after the Codex
 * Desktop audit.
 *
 * The audit demonstrated that the previous two-pass design ran under plain
 * `BEGIN`, so PostgreSQL used statement-level READ COMMITTED snapshots: a
 * concurrent update between the passes let a run commit counters that did not
 * match its own stored results. The lifecycle below fixes that:
 *
 *   1. Begin a REPEATABLE READ transaction and freeze the batch's source set
 *      as the very first statement. The re-audit showed why a snapshot alone
 *      is not enough: a source row committed after the snapshot left a run
 *      marked completed that did not cover its batch. The freeze closes that
 *      by making the source set immutable rather than merely unobserved.
 *   2. Insert the run as `running`. The unique idempotency key is the
 *      concurrency gate: a second identical invocation blocks here and then
 *      finds the first run.
 *   3. Page the batch deterministically by row number and write results.
 *   4. Derive the counters from the stored results, not from a counting pass.
 *   5. Reconcile the stored results against the batch inside the same
 *      transaction.
 *   6. Transition to `completed` as the last operation; migration 0004's
 *      trigger independently re-derives every counter and refuses a run that
 *      does not cover its batch exactly.
 *
 * `@cas/worker` composes the pure classifier with the database operations and
 * holds no classification logic of its own. Nothing here reads a review
 * snapshot, a review entry, a `ch` value, a category or a URL.
 */

/** Rows read and written per page. Bounds memory over a 23,910-row batch. */
export const DEFAULT_PAGE_SIZE = 200;

export interface ClassifyBatchRequest {
  readonly batchId: string;
}

export interface ClassifyBatchOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly pageSize?: number | undefined;
  /**
   * Test seam, invoked before each page is fetched. Integration tests use it
   * to drive a second connection deterministically between pages; production
   * callers never pass it, and it cannot change what is written.
   */
  readonly beforePage?: ((pageIndex: number) => void | Promise<void>) | undefined;
  /**
   * Test seam, invoked inside the transaction immediately before the source
   * set is frozen and therefore before the snapshot is established. Used to
   * prove the pre-freeze race; production callers never pass it.
   */
  readonly beforeFreeze?: (() => void | Promise<void>) | undefined;
}

export interface ClassifyBatchOutcome {
  readonly outcome: 'classified' | 'already_classified';
  readonly run: ClassificationRunRecord;
  readonly batch: ImportBatchRecord;
  /** When this batch's source set became immutable. Never null after a run. */
  readonly sourceSetFrozenAt: string;
  readonly durationMs: number;
}

export interface IdempotencyInputs {
  readonly batchId: string;
  readonly classifierVersion: string;
  readonly rulesetVersion: string;
  readonly rulesetHash: string;
  readonly mode: string;
}

/**
 * SHA-256 over the canonical JSON of everything that changes the outcome: the
 * batch, the classifier version, the ruleset version and the ruleset hash. A
 * changed behaviour contract changes the hash and so produces a distinct run
 * rather than silently reusing the old one.
 */
export function computeRunIdempotencyKey(inputs: IdempotencyInputs): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        batchId: inputs.batchId,
        classifierVersion: inputs.classifierVersion,
        rulesetVersion: inputs.rulesetVersion,
        rulesetHash: inputs.rulesetHash,
        mode: inputs.mode,
      }),
    )
    .digest('hex');
}

async function loadBatch(db: Database, batchId: string): Promise<ImportBatchRecord> {
  const batch = await db.withClient((client) => getImportBatch(client, batchId));
  if (batch === null) {
    throw new IngestionError('configuration', 'batch_not_found', 'no import batch with that id');
  }
  return batch;
}

async function loadCompletedRun(db: Database, runId: string): Promise<ClassificationRunRecord> {
  const run = await db.withClient((client) => getClassificationRun(client, runId));
  if (run === null || run.status !== 'completed') {
    throw new IngestionError(
      'database',
      'run_not_completed',
      'classification run is missing or not completed after the transaction committed',
    );
  }
  return run;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A duplicate idempotency key means another invocation already owns this run. */
function isDuplicateRun(error: unknown): boolean {
  return isDatabaseError(error) && error.code === '23505';
}

/**
 * The batch changed under this transaction's snapshot, so PostgreSQL refused
 * the freeze. Another invocation may have completed the same run meanwhile.
 */
function isSerializationFailure(error: unknown): boolean {
  return isDatabaseError(error) && error.code === '40001';
}

/**
 * Classifies every row of one explicit batch.
 *
 * A completed run with the same batch, classifier version, ruleset version and
 * ruleset hash is returned unchanged and writes nothing.
 */
export async function classifyBatch(
  db: Database,
  request: ClassifyBatchRequest,
  options: ClassifyBatchOptions = {},
): Promise<ClassifyBatchOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_ROWS_PER_INSERT),
  );
  const startedAt = now();

  const batch = await loadBatch(db, request.batchId);
  const hash = rulesetHash();
  const idempotencyKey = computeRunIdempotencyKey({
    batchId: batch.id,
    classifierVersion: CLASSIFIER_VERSION,
    rulesetVersion: RULESET_VERSION,
    rulesetHash: hash,
    mode: CLASSIFIER_MODE,
  });
  const elapsed = (): number => now().getTime() - startedAt.getTime();

  const alreadyDone = async (): Promise<ClassifyBatchOutcome | null> => {
    const found = await db.withClient((client) =>
      findClassificationRunByIdempotencyKey(client, idempotencyKey),
    );
    if (found === null || found.status !== 'completed') return null;
    const stored = await loadBatch(db, batch.id);
    return {
      outcome: 'already_classified',
      run: found,
      batch: stored,
      sourceSetFrozenAt: stored.sourceSetFrozenAt ?? '',
      durationMs: elapsed(),
    };
  };

  const existing = await alreadyDone();
  if (existing !== null) return existing;

  const runId = makeId();
  let frozenAt = '';
  try {
    await db.withTransaction(
      async (tx: Queryable) => {
        if (options.beforeFreeze !== undefined) await options.beforeFreeze();

        // Step 1. Freeze the batch's source set before reading a single row.
        // This statement establishes the snapshot, so nothing can commit into
        // the batch behind it: a later mutation is refused by migration 0005,
        // and a mutation that commits while this waits makes it fail.
        frozenAt = (await freezeBatchSourceSet(tx, batch.id)).frozenAt;

        // Step 2. The unique idempotency key serializes concurrent callers: the
        // loser blocks here until the winner commits, then fails with 23505.
        await insertRunningClassificationRun(tx, {
          id: runId,
          batchId: batch.id,
          dataOrigin: batch.dataOrigin,
          classifierVersion: CLASSIFIER_VERSION,
          rulesetVersion: RULESET_VERSION,
          rulesetHash: hash,
          mode: CLASSIFIER_MODE,
          idempotencyKey,
          expectedRowCount: await countBatchSourceRows(tx, batch.id),
          startedAt: startedAt.toISOString(),
        });

        // Step 3. One repeatable-read snapshot, paged deterministically by the
        // row's stable logical number.
        let afterRowNumber = 0;
        let pageIndex = 0;
        let buffer: NewClassificationResult[] = [];
        const flush = async (): Promise<void> => {
          for (const part of chunk(buffer, MAX_ROWS_PER_INSERT)) {
            await insertClassificationResults(tx, part);
          }
          buffer = [];
        };
        for (;;) {
          if (options.beforePage !== undefined) await options.beforePage(pageIndex);
          const page = await fetchClassificationInputs(tx, batch.id, {
            afterRowNumber,
            limit: pageSize,
          });
          if (page.length === 0) break;
          for (const row of page) {
            // Only the permitted fields cross into the classifier.
            const input: ClassificationInput = {
              sourceRowId: row.sourceRowId,
              rowHash: row.rowHash,
              status: row.status,
              normalizedTitle: row.normalizedTitle,
              derivedSummaryText: row.derivedSummaryText,
              derivedDescriptionText: row.derivedDescriptionText,
            };
            const decided = classify(input);
            buffer.push({
              id: makeId(),
              runId,
              batchId: batch.id,
              sourceRowId: decided.sourceRowId,
              decision: decided.decision,
              rationaleCodes: decided.rationaleCodes,
              matchedSignals: decided.matchedSignals,
              signalScore: decided.signalScore,
              rowHash: decided.rowHash,
              createdAt: startedAt.toISOString(),
            });
            afterRowNumber = row.rowNumber;
          }
          await flush();
          pageIndex += 1;
        }
        await flush();

        // Steps 4 and 5. Counters come from the persisted results, and the run
        // must cover its batch exactly, all inside the same snapshot.
        const derived = await deriveRunDecisionCounts(tx, runId);
        const expected = await countBatchSourceRows(tx, batch.id);
        const uncovered = await countUnclassifiedRows(tx, runId, batch.id);
        if (derived.total !== expected || uncovered !== 0) {
          throw new IngestionError(
            'database',
            'run_not_reconciled',
            'classification results do not cover every row of the batch',
            { expected, stored: derived.total, uncovered },
          );
        }

        // Step 6. The trigger re-derives every counter before allowing this.
        await completeClassificationRun(tx, runId, derived, now().toISOString());
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (isDuplicateRun(error) || isSerializationFailure(error)) {
      // Either another invocation owns this idempotency key, or the batch
      // changed under this snapshot. Both leave nothing of this attempt
      // behind. If the equivalent run was completed by the winner, report it.
      const winner = await alreadyDone();
      if (winner !== null) return winner;
      throw new IngestionError(
        'database',
        isDuplicateRun(error) ? 'run_in_progress' : 'batch_source_set_changed',
        isDuplicateRun(error)
          ? 'another classification run for this batch and ruleset is in progress'
          : 'the batch source set changed during classification; nothing was written',
      );
    }
    throw error;
  }

  return {
    outcome: 'classified',
    run: await loadCompletedRun(db, runId),
    batch: await loadBatch(db, batch.id),
    sourceSetFrozenAt: frozenAt,
    durationMs: elapsed(),
  };
}
