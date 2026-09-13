import { CLASSIFICATION_DECISIONS, REVIEW_STATES } from '@cas/contracts';
import type { ClassificationDecision, ReviewState } from '@cas/contracts';

/**
 * Post-hoc calibration (decision D21).
 *
 * Calibration runs strictly **after** classification and never influences it.
 * The classifier never sees a review state; this evaluator never sees source
 * text. Its only input is a count-only confusion matrix that the database
 * produced by joining completed results to a weekly review snapshot, so a
 * historical label cannot travel backwards into a decision.
 *
 * CS79 and CS86 are calibration datasets, not holdouts.
 */

/** One cell: how many rows carry this decision and this historical review state. */
export interface CalibrationCell {
  readonly decision: ClassificationDecision;
  readonly reviewState: ReviewState;
  readonly count: number;
}

export interface CalibrationMetrics {
  readonly total: number;
  /** Rows per historical review state. */
  readonly byReviewState: Readonly<Record<ReviewState, number>>;
  /** Rows per machine decision. */
  readonly byDecision: Readonly<Record<ClassificationDecision, number>>;
  /** Full matrix, decision by review state, in a stable order. */
  readonly matrix: readonly CalibrationCell[];
  readonly selected: {
    readonly total: number;
    readonly include: number;
    readonly review: number;
    readonly exclude: number;
    /** (include + review) / selected. The Sprint 3 acceptance metric. */
    readonly retentionRecall: number;
    /** include / selected. Reported, not the acceptance metric. */
    readonly strictIncludeRecall: number;
  };
  readonly includePrecisionAgainstSelected: number;
  readonly needsReviewCount: number;
  readonly needsReviewRate: number;
  /** (include + exclude) / total: the share the machine decided without a queue entry. */
  readonly automationRate: number;
}

/** Six decimal places, truncated rather than rounded, so a metric never reads higher than it is. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.trunc((numerator / denominator) * 1_000_000) / 1_000_000;
}

function emptyDecisionCounts(): Record<ClassificationDecision, number> {
  return { include: 0, exclude: 0, review: 0 };
}

function emptyReviewCounts(): Record<ReviewState, number> {
  return { selected: 0, rejected: 0, unreviewed: 0 };
}

/**
 * Computes the calibration metrics from a count-only matrix. Cells may arrive
 * in any order and may omit empty combinations; the output always carries the
 * full matrix in a stable order.
 */
export function evaluateCalibration(cells: readonly CalibrationCell[]): CalibrationMetrics {
  const counts = new Map<string, number>();
  const byDecision = emptyDecisionCounts();
  const byReviewState = emptyReviewCounts();
  let total = 0;
  for (const cell of cells) {
    const key = `${cell.decision}|${cell.reviewState}`;
    counts.set(key, (counts.get(key) ?? 0) + cell.count);
    byDecision[cell.decision] += cell.count;
    byReviewState[cell.reviewState] += cell.count;
    total += cell.count;
  }
  const matrix: CalibrationCell[] = [];
  for (const decision of CLASSIFICATION_DECISIONS) {
    for (const reviewState of REVIEW_STATES) {
      matrix.push({
        decision,
        reviewState,
        count: counts.get(`${decision}|${reviewState}`) ?? 0,
      });
    }
  }
  const cell = (decision: ClassificationDecision, reviewState: ReviewState): number =>
    counts.get(`${decision}|${reviewState}`) ?? 0;

  const selectedTotal = byReviewState.selected;
  const selectedInclude = cell('include', 'selected');
  const selectedReview = cell('review', 'selected');
  const selectedExclude = cell('exclude', 'selected');
  const needsReviewCount = byDecision.review;

  return {
    total,
    byReviewState,
    byDecision,
    matrix,
    selected: {
      total: selectedTotal,
      include: selectedInclude,
      review: selectedReview,
      exclude: selectedExclude,
      retentionRecall: ratio(selectedInclude + selectedReview, selectedTotal),
      strictIncludeRecall: ratio(selectedInclude, selectedTotal),
    },
    includePrecisionAgainstSelected: ratio(selectedInclude, byDecision.include),
    needsReviewCount,
    needsReviewRate: ratio(needsReviewCount, total),
    automationRate: ratio(byDecision.include + byDecision.exclude, total),
  };
}

/** The Sprint 3 acceptance threshold for selected-retention recall. */
export const RETENTION_RECALL_TARGET = 0.98;

export function meetsRetentionTarget(metrics: CalibrationMetrics): boolean {
  return metrics.selected.total > 0 && metrics.selected.retentionRecall >= RETENTION_RECALL_TARGET;
}
