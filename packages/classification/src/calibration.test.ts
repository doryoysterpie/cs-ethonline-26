import { describe, expect, it } from 'vitest';

import {
  evaluateCalibration,
  meetsRetentionTarget,
  ratio,
  RETENTION_RECALL_TARGET,
  type CalibrationCell,
} from './calibration.js';

const cell = (
  decision: CalibrationCell['decision'],
  reviewState: CalibrationCell['reviewState'],
  count: number,
): CalibrationCell => ({ decision, reviewState, count });

describe('evaluateCalibration', () => {
  it('computes retention recall as include plus review over all selected rows', () => {
    const metrics = evaluateCalibration([
      cell('include', 'selected', 120),
      cell('review', 'selected', 10),
      cell('exclude', 'rejected', 5),
      cell('include', 'rejected', 20),
      cell('review', 'rejected', 2),
    ]);
    expect(metrics.total).toBe(157);
    expect(metrics.selected.total).toBe(130);
    expect(metrics.selected.retentionRecall).toBe(1);
    expect(metrics.selected.strictIncludeRecall).toBe(ratio(120, 130));
    expect(meetsRetentionTarget(metrics)).toBe(true);
  });

  it('counts a selected row classified exclude against retention', () => {
    const metrics = evaluateCalibration([
      cell('include', 'selected', 90),
      cell('review', 'selected', 5),
      cell('exclude', 'selected', 5),
    ]);
    expect(metrics.selected.exclude).toBe(5);
    expect(metrics.selected.retentionRecall).toBe(0.95);
    expect(meetsRetentionTarget(metrics)).toBe(false);
  });

  it('reports the full matrix in a stable order, including empty combinations', () => {
    const metrics = evaluateCalibration([cell('include', 'selected', 1)]);
    expect(metrics.matrix).toHaveLength(9);
    expect(metrics.matrix.map((c) => `${c.decision}/${c.reviewState}`)).toEqual([
      'include/selected',
      'include/rejected',
      'include/unreviewed',
      'exclude/selected',
      'exclude/rejected',
      'exclude/unreviewed',
      'review/selected',
      'review/rejected',
      'review/unreviewed',
    ]);
    expect(metrics.matrix.filter((c) => c.count === 0)).toHaveLength(8);
  });

  it('reports precision, queue size, queue rate and automation rate', () => {
    const metrics = evaluateCalibration([
      cell('include', 'selected', 60),
      cell('include', 'rejected', 20),
      cell('review', 'selected', 10),
      cell('review', 'rejected', 5),
      cell('exclude', 'rejected', 5),
    ]);
    expect(metrics.includePrecisionAgainstSelected).toBe(ratio(60, 80));
    expect(metrics.needsReviewCount).toBe(15);
    expect(metrics.needsReviewRate).toBe(0.15);
    expect(metrics.automationRate).toBe(0.85);
    expect(metrics.byDecision).toEqual({ include: 80, exclude: 5, review: 15 });
    expect(metrics.byReviewState).toEqual({ selected: 70, rejected: 30, unreviewed: 0 });
  });

  it('sums duplicate cells and tolerates any input order', () => {
    const a = evaluateCalibration([cell('include', 'selected', 3), cell('include', 'selected', 4)]);
    const b = evaluateCalibration([cell('include', 'selected', 7)]);
    expect(a).toEqual(b);
  });

  it('is safe on an empty matrix and never reports a target as met', () => {
    const metrics = evaluateCalibration([]);
    expect(metrics.total).toBe(0);
    expect(metrics.selected.retentionRecall).toBe(0);
    expect(metrics.automationRate).toBe(0);
    expect(meetsRetentionTarget(metrics)).toBe(false);
  });

  it('truncates ratios to six places rather than rounding them up', () => {
    expect(ratio(2, 3)).toBe(0.666666);
    expect(ratio(1, 3)).toBe(0.333333);
    expect(ratio(1, 0)).toBe(0);
    expect(RETENTION_RECALL_TARGET).toBe(0.98);
    // 0.9799... must not round to the target.
    const metrics = evaluateCalibration([
      cell('include', 'selected', 979),
      cell('exclude', 'selected', 21),
    ]);
    expect(metrics.selected.retentionRecall).toBe(0.979);
    expect(meetsRetentionTarget(metrics)).toBe(false);
  });
});
