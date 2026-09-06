import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHAINS,
  CLASSIFICATION_DECISIONS,
  DATA_ORIGINS,
  EDITORIAL_SOURCE_KINDS,
  IMPORT_BATCH_STATUSES,
  REVIEW_STATES,
  ROW_ISSUE_SEVERITIES,
  SOURCE_ROW_STATUSES,
  type ChainId,
  type ClassificationDecision,
  type DataOrigin,
  type EditorialSourceKind,
  type ReviewState,
  type SourceRowStatus,
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

  it('fixes the chain set from decision D11 with Ethereum first', () => {
    expect([...CHAINS]).toEqual(['ethereum', 'base']);
    expectTypeOf<ChainId>().not.toEqualTypeOf<DataOrigin>();
  });

  it('fixes the editorial source kinds and import statuses from decision D20', () => {
    expect([...EDITORIAL_SOURCE_KINDS]).toEqual(['master', 'weekly']);
    expect([...IMPORT_BATCH_STATUSES]).toEqual(['completed', 'completed_with_issues']);
    expect([...SOURCE_ROW_STATUSES]).toEqual(['accepted', 'quarantined']);
    expect([...ROW_ISSUE_SEVERITIES]).toEqual(['error', 'warning']);
    expectTypeOf<EditorialSourceKind>().not.toEqualTypeOf<DataOrigin>();
  });

  it('keeps row status apart from human review state so quarantine never reads as a decision', () => {
    const overlap = SOURCE_ROW_STATUSES.filter((value) =>
      (REVIEW_STATES as readonly string[]).includes(value),
    );
    expect(overlap).toEqual([]);
    expectTypeOf<SourceRowStatus>().not.toEqualTypeOf<ReviewState>();
  });
});
