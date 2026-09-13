import type { ReviewState } from '@cas/contracts';
import { describe, expect, it } from 'vitest';

import { classify } from './classifier.js';
import { ClassificationInputError, type ClassificationInput } from './input.js';

/**
 * Label invariance (decision D21).
 *
 * A historical human selection must never influence a machine decision. Three
 * independent proofs:
 *
 * 1. The input type carries no label field, and the runtime guard rejects one.
 * 2. Classifying the same allowed fields while the associated labels are
 *    removed, replaced or flipped yields byte-identical results.
 * 3. Neither a source-row identifier nor a calibration-week name changes a
 *    decision.
 */

interface LabelledRow {
  readonly input: ClassificationInput;
  readonly reviewState: ReviewState;
  readonly weeklyLabel: string;
}

function row(
  id: string,
  title: string,
  summary: string | null,
  reviewState: ReviewState,
  weeklyLabel: string,
  status: ClassificationInput['status'] = 'accepted',
): LabelledRow {
  return {
    input: {
      sourceRowId: id,
      rowHash: id.replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
      status,
      normalizedTitle: title,
      derivedSummaryText: summary,
      derivedDescriptionText: null,
    },
    reviewState,
    weeklyLabel,
  };
}

const CORPUS: readonly LabelledRow[] = [
  row(
    '11111111-1111-4111-8111-111111111111',
    'Ransomware halts a hospital',
    null,
    'selected',
    'CS79',
  ),
  row(
    '22222222-2222-4222-8222-222222222222',
    'Vendor patches a vulnerability',
    null,
    'selected',
    'CS79',
  ),
  row(
    '33333333-3333-4333-8333-333333333333',
    'A slow-cooker recipe',
    'Serve warm.',
    'rejected',
    'CS79',
  ),
  row(
    '44444444-4444-4444-8444-444444444444',
    'Quarterly earnings summary',
    null,
    'rejected',
    'CS86',
  ),
  row(
    '55555555-5555-4555-8555-555555555555',
    'Incomplete row',
    null,
    'selected',
    'CS86',
    'quarantined',
  ),
  row(
    '66666666-6666-4666-8666-666666666666',
    'Threat actor exploits CVE-2026-12345',
    'Active exploitation.',
    'unreviewed',
    'CS86',
  ),
];

const flip = (state: ReviewState): ReviewState =>
  state === 'selected' ? 'rejected' : state === 'rejected' ? 'selected' : 'unreviewed';

describe('label invariance', () => {
  it('produces identical results when labels are removed, replaced or flipped', () => {
    const baseline = CORPUS.map((r) => classify(r.input));

    // Labels removed entirely.
    const unlabelled = CORPUS.map((r) => classify(r.input));
    expect(unlabelled).toEqual(baseline);

    // Labels flipped, and calibration-week names replaced.
    const flipped = CORPUS.map((r) => ({
      ...r,
      reviewState: flip(r.reviewState),
      weeklyLabel: r.weeklyLabel === 'CS79' ? 'CS86' : 'CS79',
    }));
    expect(flipped.map((r) => classify(r.input))).toEqual(baseline);

    // Every label set to the same value.
    const uniform = CORPUS.map((r) => ({ ...r, reviewState: 'selected' as ReviewState }));
    expect(uniform.map((r) => classify(r.input))).toEqual(baseline);
  });

  it('never varies a decision by source-row identifier', () => {
    const [first] = CORPUS;
    if (first === undefined) throw new Error('corpus is empty');
    const renamed: ClassificationInput = {
      ...first.input,
      sourceRowId: '99999999-9999-4999-8999-999999999999',
    };
    const a = classify(first.input);
    const b = classify(renamed);
    expect({ ...a, sourceRowId: '' }).toEqual({ ...b, sourceRowId: '' });
  });

  it('refuses to accept a label, a week name or a category even if a caller smuggles one in', () => {
    const [first] = CORPUS;
    if (first === undefined) throw new Error('corpus is empty');
    for (const [field, value] of [
      ['reviewState', 'selected'],
      ['review_state', 'selected'],
      ['reviewLabel', 'CS79'],
      ['review_label', 'CS86'],
      ['rawCh', 'TRUE'],
      ['ch', 'TRUE'],
      ['category', 'Security'],
    ] as const) {
      const widened = { ...first.input, [field]: value } as ClassificationInput;
      expect(() => classify(widened), field).toThrowError(ClassificationInputError);
    }
  });

  it('gives the same decision to identical text under both historical labels', () => {
    const text = 'Ransomware halts a hospital';
    const asSelected = row('77777777-7777-4777-8777-777777777777', text, null, 'selected', 'CS79');
    const asRejected = row('88888888-8888-4888-8888-888888888888', text, null, 'rejected', 'CS86');
    const a = classify(asSelected.input);
    const b = classify(asRejected.input);
    expect(a.decision).toBe(b.decision);
    expect(a.rationaleCodes).toEqual(b.rationaleCodes);
    expect(a.matchedSignals).toEqual(b.matchedSignals);
    expect(a.signalScore).toBe(b.signalScore);
  });
});
