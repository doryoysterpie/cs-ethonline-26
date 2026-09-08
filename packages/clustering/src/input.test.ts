import { describe, expect, it } from 'vitest';

import { ALLOWED_INPUT_KEYS, CLUSTERING_CONTRACT } from './contract.js';
import {
  assertClusteringInput,
  assertClusteringInputs,
  CLUSTERING_INPUT_REJECTIONS,
  ClusteringInputError,
  type ClusteringInput,
} from './input.js';

/**
 * The clustering input boundary is an exact allowlist, not a denylist. The
 * Sprint 3 audit passed unknown field names straight through a denylist, so
 * this boundary admits a closed set and refuses everything else whatever it is
 * called.
 */

function valid(overrides: Partial<ClusteringInput> = {}): ClusteringInput {
  return {
    sourceRowId: '11111111-1111-4111-8111-111111111111',
    rowHash: 'a'.repeat(64),
    classificationResultId: '22222222-2222-4222-8222-222222222222',
    classificationRunId: '33333333-3333-4333-8333-333333333333',
    batchId: '44444444-4444-4444-8444-444444444444',
    dataOrigin: 'replay',
    decision: 'include',
    urlGroupId: '55555555-5555-4555-8555-555555555555',
    postedAt: '2026-06-01T00:00:00.000Z',
    normalizedTitle: 'A title',
    derivedSummaryText: null,
    derivedDescriptionText: null,
    ...overrides,
  };
}

function reasonFor(value: unknown): string {
  try {
    assertClusteringInput(value as ClusteringInput);
    return 'accepted';
  } catch (error) {
    if (error instanceof ClusteringInputError) return error.reason;
    throw error;
  }
}

describe('closed clustering input allowlist', () => {
  it('admits exactly the declared fields with their declared shapes', () => {
    expect(ALLOWED_INPUT_KEYS.map((field) => field.key).sort()).toEqual([
      'batchId',
      'classificationResultId',
      'classificationRunId',
      'dataOrigin',
      'decision',
      'derivedDescriptionText',
      'derivedSummaryText',
      'normalizedTitle',
      'postedAt',
      'rowHash',
      'sourceRowId',
      'urlGroupId',
    ]);
    expect(reasonFor(valid())).toBe('accepted');
    expect(reasonFor(valid({ decision: 'review' }))).toBe('accepted');
    expect(reasonFor(valid({ decision: 'exclude' }))).toBe('accepted');
    expect(reasonFor(valid({ urlGroupId: null, postedAt: null }))).toBe('accepted');
    expect(
      reasonFor(
        valid({ normalizedTitle: null, derivedSummaryText: null, derivedDescriptionText: null }),
      ),
    ).toBe('accepted');
  });

  it('refuses every field the editorial record must never lend the engine', () => {
    for (const key of [
      'reviewState',
      'review_state',
      'weeklyLabel',
      'reviewLabel',
      'batchLabel',
      'publicationStatus',
      'published',
      'substackUrl',
      'publisherCategory',
      'rawCategory',
      'ch',
      'rawCh',
      'rawCells',
      'rawFields',
      'canonicalUrl',
      'url',
      'editorialWeek',
      'weekNumber',
      'DATABASE_URL',
      'analystDisposition',
      'hiddenSnapshotToken',
    ]) {
      expect(reasonFor({ ...valid(), [key]: 'x' }), key).toBe(
        CLUSTERING_INPUT_REJECTIONS.unexpectedKey,
      );
    }
  });

  it('refuses a missing field, a symbol key, an accessor and a foreign prototype', () => {
    for (const field of ALLOWED_INPUT_KEYS) {
      const partial: Record<string, unknown> = { ...valid() };
      delete partial[field.key];
      expect(reasonFor(partial), field.key).toBe(CLUSTERING_INPUT_REJECTIONS.missingKey);
    }
    const withSymbol: Record<string | symbol, unknown> = { ...valid() };
    withSymbol[Symbol('hidden')] = 'x';
    expect(reasonFor(withSymbol)).toBe(CLUSTERING_INPUT_REJECTIONS.symbolKey);

    let read = 0;
    const withGetter = { ...valid() };
    Object.defineProperty(withGetter, 'normalizedTitle', {
      get: () => {
        read += 1;
        return 'x';
      },
      enumerable: true,
      configurable: true,
    });
    expect(reasonFor(withGetter)).toBe(CLUSTERING_INPUT_REJECTIONS.accessorProperty);
    // The descriptor was inspected; the accessor was never invoked.
    expect(read).toBe(0);

    expect(reasonFor(Object.assign(Object.create({ inherited: 1 }), valid()))).toBe(
      CLUSTERING_INPUT_REJECTIONS.prototypeNotPlain,
    );
    expect(reasonFor(Object.assign(Object.create(null), valid()))).toBe('accepted');
  });

  it('refuses a value that is not an object at all', () => {
    for (const value of [null, undefined, 1, 'text', true, [], () => valid()]) {
      expect([
        CLUSTERING_INPUT_REJECTIONS.notPlainObject,
        CLUSTERING_INPUT_REJECTIONS.prototypeNotPlain,
      ]).toContain(reasonFor(value));
    }
  });

  it('checks the runtime shape of every declared field', () => {
    expect(reasonFor(valid({ sourceRowId: '' }))).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidIdentifier,
    );
    expect(reasonFor({ ...valid(), rowHash: 7 })).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidIdentifier,
    );
    expect(reasonFor({ ...valid(), urlGroupId: 7 })).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidIdentifier,
    );
    expect(reasonFor(valid({ decision: 'maybe' }))).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidDecision,
    );
    expect(reasonFor({ ...valid(), normalizedTitle: 7 })).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidTextField,
    );
    expect(reasonFor(valid({ postedAt: 'not a date' }))).toBe(
      CLUSTERING_INPUT_REJECTIONS.invalidTimestamp,
    );
  });

  it('never echoes a rejected key or value in the error it raises', () => {
    const secret = 'Kestrelvale-Water-district-secret-value';
    for (const value of [
      { ...valid(), publisherCategory: secret },
      { ...valid(), normalizedTitle: 7, derivedSummaryText: secret },
      { ...valid(), decision: secret },
    ]) {
      let message = '';
      try {
        assertClusteringInput(value as ClusteringInput);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(secret);
      expect(message).not.toContain('publisherCategory');
      expect(message.startsWith('clustering input rejected: ')).toBe(true);
    }
  });

  it('admits nothing at all when the contract admits no keys', () => {
    const closed = { ...CLUSTERING_CONTRACT, allowedInputKeys: [] };
    let reason = 'accepted';
    try {
      assertClusteringInput(valid(), closed);
    } catch (error) {
      reason = error instanceof ClusteringInputError ? error.reason : 'other';
    }
    expect(reason).toBe(CLUSTERING_INPUT_REJECTIONS.unexpectedKey);
  });
});

describe('page-level validation', () => {
  it('refuses a repeated source row, a mixed batch and a mixed classification run', () => {
    expect(() => assertClusteringInputs([valid(), valid()])).toThrowError(ClusteringInputError);
    expect(() =>
      assertClusteringInputs([valid(), valid({ sourceRowId: 'other', batchId: 'another-batch' })]),
    ).toThrowError(ClusteringInputError);
    expect(() =>
      assertClusteringInputs([
        valid(),
        valid({ sourceRowId: 'other', classificationRunId: 'another-run' }),
      ]),
    ).toThrowError(ClusteringInputError);
  });

  it('refuses more inputs than the contract permits', () => {
    const contract = {
      ...CLUSTERING_CONTRACT,
      bounds: { ...CLUSTERING_CONTRACT.bounds, maximumInputs: 1 },
    };
    let reason = 'accepted';
    try {
      assertClusteringInputs([valid(), valid({ sourceRowId: 'other' })], contract);
    } catch (error) {
      reason = error instanceof ClusteringInputError ? error.reason : 'other';
    }
    expect(reason).toBe(CLUSTERING_INPUT_REJECTIONS.inputBoundExceeded);
  });

  it('accepts an empty page', () => {
    expect(() => assertClusteringInputs([])).not.toThrow();
  });
});
