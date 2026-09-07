import {
  evaluateCalibration,
  meetsRetentionTarget,
  type CalibrationMetrics,
} from '@cas/classification';
import {
  countRunDecisions,
  countRunRationaleCodes,
  countUnclassifiedRows,
  fetchCalibrationMatrix,
  fetchReviewQueue,
  findBatchReviewSnapshot,
  getClassificationRun,
  type ClassificationRunRecord,
  type Database,
  type DecisionCounts,
  type QueueEntry,
  type RationaleCodeCount,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/**
 * Count-only reads over a completed classification run, and the post-hoc
 * calibration composition. Every function here takes an explicit run
 * identifier: there is no "latest run" behaviour anywhere.
 */

export interface RunReport {
  readonly run: ClassificationRunRecord;
  readonly stored: DecisionCounts;
  readonly reconciled: boolean;
  readonly unclassifiedRows: number;
  readonly rationaleCodes: readonly RationaleCodeCount[];
}

async function requireRun(db: Database, runId: string): Promise<ClassificationRunRecord> {
  const run = await db.withClient((client) => getClassificationRun(client, runId));
  if (run === null) {
    throw new IngestionError(
      'configuration',
      'run_not_found',
      'no classification run with that id',
    );
  }
  return run;
}

export async function reportRun(db: Database, runId: string): Promise<RunReport> {
  const run = await requireRun(db, runId);
  return db.withClient(async (client) => {
    const stored = await countRunDecisions(client, run.id);
    const unclassifiedRows = await countUnclassifiedRows(client, run.id, run.batchId);
    return {
      run,
      stored,
      reconciled:
        stored.total === run.classifiedRowCount &&
        stored.total === run.expectedRowCount &&
        stored.include === run.includeCount &&
        stored.exclude === run.excludeCount &&
        stored.review === run.reviewCount &&
        unclassifiedRows === 0,
      unclassifiedRows,
      rationaleCodes: await countRunRationaleCodes(client, run.id),
    };
  });
}

export interface QueuePage {
  readonly run: ClassificationRunRecord;
  readonly total: number;
  readonly entries: readonly QueueEntry[];
  readonly truncated: boolean;
}

/** The needs-review queue derived from one explicit run. */
export async function reviewQueue(db: Database, runId: string, limit: number): Promise<QueuePage> {
  const run = await requireRun(db, runId);
  return db.withClient(async (client) => {
    const entries = await fetchReviewQueue(client, run.id, { afterRowNumber: 0, limit });
    return { run, total: run.reviewCount, entries, truncated: run.reviewCount > entries.length };
  });
}

export interface CalibrationReport {
  readonly run: ClassificationRunRecord;
  readonly reviewLabel: string;
  readonly metrics: CalibrationMetrics;
  readonly meetsTarget: boolean;
}

/**
 * Calibration for one completed run. Refuses a batch with no weekly review
 * snapshot, because there is nothing to calibrate against. Runs strictly
 * after classification and cannot influence it (decision D21).
 */
export async function calibrateRun(db: Database, runId: string): Promise<CalibrationReport> {
  const run = await requireRun(db, runId);
  return db.withClient(async (client) => {
    const snapshot = await findBatchReviewSnapshot(client, run.batchId);
    if (snapshot === null) {
      throw new IngestionError(
        'configuration',
        'no_review_snapshot',
        'calibration needs a weekly review snapshot; this batch has none',
      );
    }
    const metrics = evaluateCalibration(await fetchCalibrationMatrix(client, run.id));
    return {
      run,
      reviewLabel: snapshot.reviewLabel,
      metrics,
      meetsTarget: meetsRetentionTarget(metrics),
    };
  });
}
