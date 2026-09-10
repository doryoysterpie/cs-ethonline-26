import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ANOMALY_LABELS,
  ANOMALY_SIGNAL_TYPES,
  ASSOCIATION_RELATIONS,
  ASSOCIATION_STATUSES,
  CHAINS,
  CLASSIFICATION_DECISIONS,
  DRAFT_STATUSES,
  EVIDENCE_STATES,
  NAMING_DECISIONS,
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

  it('fixes the evidence-state vocabulary and keeps it separate from every other enum', () => {
    expect([...EVIDENCE_STATES]).toEqual([
      'reported_only',
      'onchain_observed',
      'corroborated',
      'contradicted',
    ]);
    // An evidence state is not a classification decision, a review state or a
    // data origin, and nothing may be silently interchanged with it.
    for (const other of [CLASSIFICATION_DECISIONS, REVIEW_STATES, DATA_ORIGINS]) {
      const overlap = EVIDENCE_STATES.filter((value) =>
        (other as readonly string[]).includes(value),
      );
      expect(overlap).toEqual([]);
    }
  });

  it('fixes the association, anomaly, naming and draft vocabularies', () => {
    expect([...ASSOCIATION_STATUSES]).toEqual(['suggested', 'accepted', 'rejected']);
    expect([...ASSOCIATION_RELATIONS]).toEqual(['supports', 'conflicts', 'context']);
    expect([...ANOMALY_SIGNAL_TYPES]).toEqual(['chain_tvl', 'reporting_volume']);
    expect([...ANOMALY_LABELS]).toEqual([
      'normal',
      'positive_spike',
      'negative_spike',
      'insufficient_history',
      'stale_observation',
      'missing_observation',
    ]);
    expect([...NAMING_DECISIONS]).toEqual([
      'named_primary_statement',
      'named_two_independent_reports',
      'withheld_insufficient_sourcing',
    ]);
    // There is no published draft status: publishing is a human act outside
    // this system, so the enum offers nothing that could represent it.
    expect([...DRAFT_STATUSES]).toEqual(['unpublished_requires_human_review']);
    expect(DRAFT_STATUSES).toHaveLength(1);
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
