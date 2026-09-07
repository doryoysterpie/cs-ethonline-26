import { createHash, randomUUID } from 'node:crypto';

import {
  classify,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  rulesetHash,
  RULESET_VERSION,
  type ClassificationInput,
} from '@cas/classification';
import type { ClassificationDecision } from '@cas/contracts';
import {
  countBatchSourceRows,
  fetchClassificationInputs,
  findClassificationRunByIdempotencyKey,
  getClassificationRun,
  getImportBatch,
  insertClassificationResults,
  insertClassificationRun,
  MAX_ROWS_PER_INSERT,
  type ClassificationRunRecord,
  type Database,
  type ImportBatchRecord,
  type NewClassificationResult,
  type Queryable,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/**
 * Classification orchestration (decision D21).
 *
 * `@cas/worker` composes the pure classifier with the database operations.
 * The rules live in `@cas/classification` and never see a connection; the
 * queries live in `@cas/database` and never see a rule. This module holds no
 * classification logic of its own: it pages rows in, calls `classify`, and
 * writes what comes back.
 *
 * The whole run is one transaction, so a failure leaves no partial run, and
 * the completed run's counts must equal the batch's stored row count or the
 * database refuses it. Nothing here reads a review snapshot, a review entry,
 * a `ch` value, a category or a URL.
 */

/** Rows read and classified before each flush. Bounds memory over a 23,910-row batch. */
export const DEFAULT_PAGE_SIZE = 200;

export interface ClassifyBatchRequest {
  readonly batchId: string;
}

export interface ClassifyBatchOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly pageSize?: number | undefined;
  /** Test hook run before each page is written; throwing must roll the run back. */
  readonly beforePage?: ((pageIndex: number) => void | Promise<void>) | undefined;
}

export interface ClassifyBatchOutcome {
  readonly outcome: 'classified' | 'already_classified';
  readonly run: ClassificationRunRecord;
  readonly batch: ImportBatchRecord;
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
 * changed rule changes the hash and therefore produces a distinct run rather
 * than silently reusing the old one.
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

async function loadRun(db: Database, runId: string): Promise<ClassificationRunRecord> {
  const run = await db.withClient((client) => getClassificationRun(client, runId));
  if (run === null) {
    throw new IngestionError('database', 'run_missing', 'classification run not found after write');
  }
  return run;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Classifies every row of one explicit batch.
 *
 * A run with the same batch, classifier version and ruleset hash already in
 * the database is returned unchanged and writes nothing.
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

  const existing = await db.withClient((client) =>
    findClassificationRunByIdempotencyKey(client, idempotencyKey),
  );
  if (existing !== null) {
    return {
      outcome: 'already_classified',
      run: existing,
      batch,
      durationMs: now().getTime() - startedAt.getTime(),
    };
  }

  const runId = makeId();
  await db.withTransaction(async (tx: Queryable) => {
    const expected = await countBatchSourceRows(tx, batch.id);

    /**
     * Pages the batch and hands each row to the classifier. Both passes below
     * use it. Memory stays bounded at one page: the large derived text of a
     * page is released before the next is fetched.
     */
    const forEachDecision = async (
      onDecision: (decided: ReturnType<typeof classify>, pageIndex: number) => Promise<void> | void,
      onPage?: (pageIndex: number) => Promise<void> | void,
    ): Promise<number> => {
      let seen = 0;
      let afterRowNumber = 0;
      let pageIndex = 0;
      for (;;) {
        const page = await fetchClassificationInputs(tx, batch.id, {
          afterRowNumber,
          limit: pageSize,
        });
        if (page.length === 0) break;
        if (onPage !== undefined) await onPage(pageIndex);
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
          await onDecision(classify(input), pageIndex);
          seen += 1;
          afterRowNumber = row.rowNumber;
        }
        pageIndex += 1;
      }
      return seen;
    };

    // Pass 1 counts the decisions without keeping any of them, so the run row
    // can be written with true counts before any result references it. The
    // classifier is pure, so pass 2 reproduces exactly these decisions.
    const counts: Record<ClassificationDecision, number> = { include: 0, exclude: 0, review: 0 };
    const classified = await forEachDecision((decided) => {
      counts[decided.decision] += 1;
    }, options.beforePage);
    if (classified !== expected) {
      throw new IngestionError(
        'database',
        'run_incomplete',
        'classification did not cover every row of the batch',
        { expected, classified },
      );
    }

    // The run is written before its results, because a result's composite
    // foreign key names its run and is checked immediately. Its constraints
    // reject any count that does not reconcile with the batch.
    await insertClassificationRun(
      tx,
      {
        id: runId,
        batchId: batch.id,
        dataOrigin: batch.dataOrigin,
        classifierVersion: CLASSIFIER_VERSION,
        rulesetVersion: RULESET_VERSION,
        rulesetHash: hash,
        mode: CLASSIFIER_MODE,
        idempotencyKey,
        expectedRowCount: expected,
        startedAt: startedAt.toISOString(),
      },
      {
        classifiedRowCount: classified,
        includeCount: counts.include,
        excludeCount: counts.exclude,
        reviewCount: counts.review,
        completedAt: now().toISOString(),
      },
    );

    // Pass 2 writes the results in bounded chunks.
    let buffer: NewClassificationResult[] = [];
    const flush = async (): Promise<void> => {
      for (const part of chunk(buffer, MAX_ROWS_PER_INSERT)) {
        await insertClassificationResults(tx, part);
      }
      buffer = [];
    };
    const written = await forEachDecision(async (decided) => {
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
      if (buffer.length >= pageSize) await flush();
    });
    await flush();
    if (written !== classified) {
      throw new IngestionError(
        'database',
        'run_incomplete',
        'classification wrote a different number of results than it counted',
        { counted: classified, written },
      );
    }
  });

  return {
    outcome: 'classified',
    run: await loadRun(db, runId),
    batch,
    durationMs: now().getTime() - startedAt.getTime(),
  };
}
