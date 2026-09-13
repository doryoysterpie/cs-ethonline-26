import { describe, expect, it } from 'vitest';

import { classify } from './classifier.js';
import { ALLOWED_INPUT_KEYS } from './contract.js';
import {
  assertClassificationInput,
  CLASSIFICATION_INPUT_REJECTIONS,
  ClassificationInputError,
  type ClassificationInput,
} from './input.js';

/**
 * The closed runtime allowlist. Codex Desktop passed `analystDisposition` and
 * `hiddenSnapshotToken` through the compiled classifier because admission was
 * a denylist; both are now refused, along with every other own key.
 */

function valid(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    sourceRowId: '11111111-1111-4111-8111-111111111111',
    rowHash: 'a'.repeat(64),
    status: 'accepted',
    normalizedTitle: 'Ransomware halts a hospital',
    derivedSummaryText: null,
    derivedDescriptionText: null,
    ...overrides,
  };
}

function reasonFor(input: unknown): string {
  try {
    assertClassificationInput(input as ClassificationInput);
  } catch (error) {
    if (error instanceof ClassificationInputError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('closed input allowlist', () => {
  it('admits exactly the six documented fields', () => {
    // The contract carries each admitted key with the shape it must have, and
    // the boundary reads both from the contract rather than from a constant
    // beside it.
    expect(ALLOWED_INPUT_KEYS.map((field) => field.key).sort()).toEqual([
      'derivedDescriptionText',
      'derivedSummaryText',
      'normalizedTitle',
      'rowHash',
      'sourceRowId',
      'status',
    ]);
    expect(ALLOWED_INPUT_KEYS.map((field) => field.kind).sort()).toEqual([
      'identifier',
      'identifier',
      'status',
      'text',
      'text',
      'text',
    ]);
    expect(reasonFor(valid())).toBe('accepted');
    expect(reasonFor(valid({ status: 'quarantined' }))).toBe('accepted');
    expect(
      reasonFor(
        valid({ normalizedTitle: null, derivedSummaryText: '', derivedDescriptionText: 'x' }),
      ),
    ).toBe('accepted');
  });

  it('rejects the exact fields the audit smuggled through', () => {
    for (const key of ['analystDisposition', 'hiddenSnapshotToken']) {
      expect(reasonFor({ ...valid(), [key]: 'x' }), key).toBe(
        CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey,
      );
      // And through the compiled entry point, not only the validator.
      expect(() => classify({ ...valid(), [key]: 'x' } as ClassificationInput), key).toThrowError(
        ClassificationInputError,
      );
    }
  });

  it('rejects every label, snapshot, batch and provenance alias', () => {
    for (const key of [
      'label',
      'selected',
      'review',
      'reviewState',
      'humanDecision',
      'snapshot',
      'snapshotId',
      'batchLabel',
      'publisherCategory',
      'ch',
      'url',
      'rawFields',
      'reviewLabel',
      'canonicalUrl',
      'rawCells',
      'DATABASE_URL',
    ]) {
      expect(reasonFor({ ...valid(), [key]: 'x' }), key).toBe(
        CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey,
      );
    }
  });

  it('rejects a missing field', () => {
    for (const field of ALLOWED_INPUT_KEYS) {
      const partial: Record<string, unknown> = { ...valid() };
      delete partial[field.key];
      expect(reasonFor(partial), field.key).toBe(CLASSIFICATION_INPUT_REJECTIONS.missingKey);
    }
  });

  it('rejects symbol keys', () => {
    const withSymbol: Record<string | symbol, unknown> = { ...valid() };
    withSymbol[Symbol('hidden')] = 'x';
    expect(reasonFor(withSymbol)).toBe(CLASSIFICATION_INPUT_REJECTIONS.symbolKey);
  });

  it('rejects accessor properties, including ones that hide a label', () => {
    const withGetter = { ...valid() };
    Object.defineProperty(withGetter, 'normalizedTitle', {
      get: () => 'ransomware',
      enumerable: true,
      configurable: true,
    });
    expect(reasonFor(withGetter)).toBe(CLASSIFICATION_INPUT_REJECTIONS.accessorProperty);
    const withSetter = { ...valid() };
    Object.defineProperty(withSetter, 'status', {
      get: () => 'accepted',
      set: () => undefined,
      enumerable: true,
      configurable: true,
    });
    expect(reasonFor(withSetter)).toBe(CLASSIFICATION_INPUT_REJECTIONS.accessorProperty);
  });

  it('rejects non-objects, arrays and functions', () => {
    for (const value of [null, undefined, 42, 'x', true, [], () => undefined]) {
      expect(reasonFor(value), String(value)).toBe(CLASSIFICATION_INPUT_REJECTIONS.notPlainObject);
    }
  });

  it('rejects a custom or polluted prototype and inherited label properties', () => {
    class Widened {
      readonly reviewState = 'selected';
    }
    const instance = Object.assign(new Widened(), valid());
    expect(reasonFor(instance)).toBe(CLASSIFICATION_INPUT_REJECTIONS.prototypeNotPlain);

    const inherited = Object.create({ hiddenSnapshotToken: 'leak' }) as Record<string, unknown>;
    Object.assign(inherited, valid());
    expect(reasonFor(inherited)).toBe(CLASSIFICATION_INPUT_REJECTIONS.prototypeNotPlain);

    // A null-prototype object is plain enough and is admitted.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, valid());
    expect(reasonFor(bare)).toBe('accepted');
  });

  it('rejects prototype-manipulation shapes', () => {
    const viaDefine = { ...valid() };
    Object.defineProperty(viaDefine, '__proto__', {
      value: { reviewState: 'selected' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(reasonFor(viaDefine)).toBe(CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey);
    const withConstructor = { ...valid(), constructor: 'x' };
    expect(reasonFor(withConstructor)).toBe(CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey);
    const parsed = JSON.parse(
      '{"sourceRowId":"a","rowHash":"b","status":"accepted","normalizedTitle":null,"derivedSummaryText":null,"derivedDescriptionText":null,"__proto__":{"reviewState":"selected"}}',
    ) as Record<string, unknown>;
    // JSON.parse creates a plain own "__proto__" property rather than setting
    // the prototype, so the prototype is intact and the extra own key is
    // refused by the allowlist.
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(reasonFor(parsed)).toBe(CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey);
  });

  it('validates the runtime shape of every allowed value', () => {
    expect(reasonFor(valid({ sourceRowId: '' }))).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidIdentifier,
    );
    expect(reasonFor({ ...valid(), rowHash: 42 })).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidIdentifier,
    );
    expect(reasonFor({ ...valid(), status: 'reviewed' })).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidStatus,
    );
    expect(reasonFor({ ...valid(), normalizedTitle: 7 })).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidTextField,
    );
    expect(reasonFor({ ...valid(), derivedSummaryText: {} })).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidTextField,
    );
    expect(reasonFor({ ...valid(), derivedDescriptionText: undefined })).toBe(
      CLASSIFICATION_INPUT_REJECTIONS.invalidTextField,
    );
  });

  it('never echoes a rejected key or value in the error message', () => {
    const secret = 'Zzsecret-marker';
    for (const input of [
      { ...valid(), analystDisposition: secret },
      { ...valid(), [secret]: 'x' },
      { ...valid(), status: secret },
      { ...valid(), normalizedTitle: 7, [`${secret}2`]: 1 },
    ]) {
      let message = '';
      try {
        assertClassificationInput(input as ClassificationInput);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(secret);
      expect(message.startsWith('classification input rejected: ')).toBe(true);
    }
  });

  it('keeps an ordinary database-shaped input working', () => {
    // The shape `fetchClassificationInputs` produces, minus its row number.
    const fromDatabase = {
      sourceRowId: '33333333-3333-4333-8333-333333333333',
      rowHash: 'b'.repeat(64),
      status: 'accepted' as const,
      normalizedTitle: 'A vendor patched a vulnerability',
      derivedSummaryText: 'Details followed.',
      derivedDescriptionText: null,
    };
    expect(reasonFor(fromDatabase)).toBe('accepted');
    expect(classify(fromDatabase).decision).toBe('include');
  });

  it('ignores the row identifier and row hash when deciding', () => {
    const base = valid({ normalizedTitle: 'Ransomware halts a hospital' });
    const renamed = classify({
      ...base,
      sourceRowId: '99999999-9999-4999-8999-999999999999',
      rowHash: 'f'.repeat(64),
    });
    const original = classify(base);
    expect(renamed.decision).toBe(original.decision);
    expect(renamed.rationaleCodes).toEqual(original.rationaleCodes);
    expect(renamed.matchedSignals).toEqual(original.matchedSignals);
    expect(renamed.signalScore).toBe(original.signalScore);
  });
});
