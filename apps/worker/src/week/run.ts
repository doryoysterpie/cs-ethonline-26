import { createHash, randomUUID } from 'node:crypto';

import { categories, isCategory, type Category } from '@cas/classification';
import {
  completeWeekRun,
  findCompletedWeekRunByKey,
  getImportBatch,
  getWeekRun,
  insertRunningWeekRun,
  insertWeekRunChild,
  isDatabaseError,
  listWeekRunChildren,
  type Database,
  type ImportBatchRecord,
  type NewWeekRunChild,
  type WeekRunChildRecord,
  type WeekRunRecord,
} from '@cas/database';

import { classifyBatch, type ClassifyBatchOutcome } from '../classification/run.js';
import { clusterClassificationRun, type ClusterRunOutcome } from '../clustering/run.js';
import { IngestionError, isIngestionError } from '../editorial/errors.js';
import type { ImportOutcome } from '../editorial/import.js';
import { resolveWeekWindow, type WeekWindow } from './window.js';

/**
 * The editorial week (CAS-003): import, then one classification run per
 * category, then one clustering run per classification run, recorded as a
 * manifest with every child and its outcome. Every child is idempotent on
 * its own identity, so a second execution over the same window and batch
 * reuses each child and reports the manifest already written. A child that
 * fails ends the run: the children so far stay recorded, the manifest is
 * marked failed with the child's code, and the error is rethrown with the
 * manifest's identifier, so the command exits with the child's own code and
 * nothing claims completion.
 */

export interface WeekRunRequest {
  readonly window: { readonly startsAt: string; readonly endsAt: string } | undefined;
  /** Registered categories to run; absent means every registered category. */
  readonly categories?: readonly string[] | undefined;
  /** An already-imported batch to run the week over; absent means import the feed. */
  readonly batchId?: string | undefined;
}

export interface WeekRunDependencies {
  /** Imports the living feed; required when no batch is provided. */
  readonly importFeed?: (() => Promise<ImportOutcome>) | undefined;
  /** Test seams, defaulting to the production runners; they cannot change what is written. */
  readonly classify?: typeof classifyBatch | undefined;
  readonly cluster?: typeof clusterClassificationRun | undefined;
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
}

export interface WeekRunOutcome {
  readonly outcome: 'ran' | 'already_ran';
  readonly week: WeekRunRecord;
  readonly children: readonly WeekRunChildRecord[];
  readonly durationMs: number;
}

export const WEEK_RUN_KEY_LABEL = 'cas.week.run.v1';

export function computeWeekRunKey(input: {
  readonly window: WeekWindow;
  readonly batchId: string;
  readonly categories: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        label: WEEK_RUN_KEY_LABEL,
        timeZone: input.window.timeZone,
        windowStart: input.window.windowStart,
        windowEnd: input.window.windowEnd,
        batchId: input.batchId,
        categories: [...input.categories].sort(),
      }),
    )
    .digest('hex');
}

function resolveCategories(requested: readonly string[] | undefined): readonly Category[] {
  const names = requested === undefined ? categories() : requested;
  if (names.length === 0) {
    throw new IngestionError(
      'configuration',
      'category_required',
      'at least one category is needed',
    );
  }
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!isCategory(name)) {
      throw new IngestionError(
        'configuration',
        'category_invalid',
        `--categories must name registered categories: ${categories().join(', ')}`,
      );
    }
  }
  return unique;
}

async function loadProvidedBatch(db: Database, batchId: string): Promise<ImportBatchRecord> {
  const batch = await db.withClient((client) => getImportBatch(client, batchId));
  if (batch === null) {
    throw new IngestionError('configuration', 'batch_not_found', 'no import batch with that id');
  }
  return batch;
}

function failureCodeOf(error: unknown): string {
  if (isIngestionError(error)) return error.code;
  if (isDatabaseError(error)) return 'database_error';
  return 'unexpected';
}

export async function runWeek(
  db: Database,
  request: WeekRunRequest,
  deps: WeekRunDependencies = {},
): Promise<WeekRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const makeId = deps.makeId ?? randomUUID;
  const classify = deps.classify ?? classifyBatch;
  const cluster = deps.cluster ?? clusterClassificationRun;
  const startedAt = now();
  const elapsed = (): number => now().getTime() - startedAt.getTime();

  // Everything that can be refused is refused before any child runs.
  const window = resolveWeekWindow(request.window);
  const selected = resolveCategories(request.categories);

  // The import runs before the manifest exists: a manifest names its batch,
  // and an import that fails leaves nothing to name (report, section 1.3).
  let batch: ImportBatchRecord;
  let importOutcome: NewWeekRunChild['outcome'];
  if (request.batchId !== undefined) {
    batch = await loadProvidedBatch(db, request.batchId);
    importOutcome = 'provided';
  } else {
    if (deps.importFeed === undefined) {
      throw new IngestionError(
        'configuration',
        'import_unavailable',
        'no feed import is configured and no --batch was given',
      );
    }
    const imported = await deps.importFeed();
    batch = imported.batch;
    importOutcome = imported.outcome === 'imported' ? 'created' : 'reused';
  }

  const key = computeWeekRunKey({ window, batchId: batch.id, categories: selected });
  const alreadyRan = async (): Promise<WeekRunOutcome | null> => {
    const found = await db.withClient((client) => findCompletedWeekRunByKey(client, key));
    if (found === null) return null;
    const children = await db.withClient((client) => listWeekRunChildren(client, found.id));
    return { outcome: 'already_ran', week: found, children, durationMs: elapsed() };
  };
  const existing = await alreadyRan();
  if (existing !== null) return existing;

  const weekRunId = makeId();
  await db.withTransaction((tx) =>
    insertRunningWeekRun(tx, {
      id: weekRunId,
      dataOrigin: batch.dataOrigin,
      batchId: batch.id,
      timeZone: window.timeZone,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      publicationCutoffAt: window.publicationCutoffAt,
      categories: [...selected].sort(),
      idempotencyKey: key,
      startedAt: startedAt.toISOString(),
    }),
  );
  let position = 0;
  const record = async (
    child: Omit<NewWeekRunChild, 'id' | 'weekRunId' | 'position' | 'createdAt'>,
  ): Promise<void> => {
    position += 1;
    const row: NewWeekRunChild = {
      id: makeId(),
      weekRunId,
      position,
      createdAt: now().toISOString(),
      ...child,
    };
    await db.withTransaction((tx) => insertWeekRunChild(tx, row));
  };
  const fail = async (
    child: Omit<
      NewWeekRunChild,
      | 'id'
      | 'weekRunId'
      | 'position'
      | 'createdAt'
      | 'outcome'
      | 'errorCode'
      | 'batchId'
      | 'classificationRunId'
      | 'clusteringRunId'
    >,
    error: unknown,
  ): Promise<never> => {
    const code = failureCodeOf(error);
    await record({
      ...child,
      batchId: null,
      classificationRunId: null,
      clusteringRunId: null,
      outcome: 'failed',
      errorCode: code,
    });
    await db.withTransaction((tx) =>
      completeWeekRun(tx, weekRunId, 'failed', now().toISOString(), code),
    );
    if (isIngestionError(error)) {
      throw new IngestionError(error.kind, error.code, error.message, {
        ...error.details,
        weekRunId,
      });
    }
    throw error;
  };

  await record({
    kind: 'import',
    category: null,
    batchId: batch.id,
    classificationRunId: null,
    clusteringRunId: null,
    outcome: importOutcome,
    errorCode: null,
  });

  const classified: { category: Category; outcome: ClassifyBatchOutcome }[] = [];
  for (const category of selected) {
    let outcome: ClassifyBatchOutcome;
    try {
      outcome = await classify(db, { batchId: batch.id, category });
    } catch (error) {
      return fail({ kind: 'classification', category }, error);
    }
    classified.push({ category, outcome });
    await record({
      kind: 'classification',
      category,
      batchId: null,
      classificationRunId: outcome.run.id,
      clusteringRunId: null,
      outcome: outcome.outcome === 'classified' ? 'created' : 'reused',
      errorCode: null,
    });
  }
  for (const { category, outcome } of classified) {
    let clustered: ClusterRunOutcome;
    try {
      clustered = await cluster(db, { classificationRunId: outcome.run.id });
    } catch (error) {
      return fail({ kind: 'clustering', category }, error);
    }
    await record({
      kind: 'clustering',
      category,
      batchId: null,
      classificationRunId: null,
      clusteringRunId: clustered.run.id,
      outcome: clustered.outcome === 'clustered' ? 'created' : 'reused',
      errorCode: null,
    });
  }

  try {
    await db.withTransaction((tx) =>
      completeWeekRun(tx, weekRunId, 'completed', now().toISOString(), null),
    );
  } catch (error) {
    // Another invocation completed the same window and batch first; the
    // partial unique index refused this completion. Report the winner.
    if (isDatabaseError(error) && error.code === '23505') {
      await db.withTransaction((tx) =>
        completeWeekRun(tx, weekRunId, 'failed', now().toISOString(), 'superseded'),
      );
      const winner = await alreadyRan();
      if (winner !== null) return winner;
    }
    throw error;
  }
  const week = await db.withClient((client) => getWeekRun(client, weekRunId));
  if (week === null)
    throw new IngestionError('database', 'week_run_missing', 'the week run vanished');
  const children = await db.withClient((client) => listWeekRunChildren(client, weekRunId));
  return { outcome: 'ran', week, children, durationMs: elapsed() };
}
