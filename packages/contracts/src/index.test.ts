import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CLASSIFICATION_DECISIONS,
  DATA_ORIGINS,
  REVIEW_STATES,
  type ClassificationDecision,
  type DataOrigin,
  type ReviewState,
} from './index.js';

describe('@cas/contracts', () => {
  it('fixes the human review-state enum required by the editorial charter', () => {
    expect([...REVIEW_STATES]).toEqual(['selected', 'rejected', 'unreviewed']);
  });

  it('fixes the machine classification-decision enum', () => {
    expect([...CLASSIFICATION_DECISIONS]).toEqual(['include', 'exclude', 'review']);
  });

  it('keeps human review state and machine classification decision as separate concepts', () => {
    const overlap = REVIEW_STATES.filter((value) =>
      (CLASSIFICATION_DECISIONS as readonly string[]).includes(value),
    );
    expect(overlap).toEqual([]);
    expectTypeOf<ReviewState>().not.toEqualTypeOf<ClassificationDecision>();
    expectTypeOf<ClassificationDecision>().not.toEqualTypeOf<ReviewState>();
  });

  it('fixes the data-origin enum as execution context, not source system', () => {
    expect([...DATA_ORIGINS]).toEqual(['live', 'fixture', 'replay']);
    expectTypeOf<DataOrigin>().not.toEqualTypeOf<ReviewState>();
    expectTypeOf<DataOrigin>().not.toEqualTypeOf<ClassificationDecision>();
  });
});
