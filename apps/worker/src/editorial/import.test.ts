import { describe, expect, it } from 'vitest';

import { isIngestionError } from './errors.js';
import { assertImportRequest, computeIdempotencyKey, type ImportRequest } from './import.js';

const BASE = {
  fileSha256: 'a'.repeat(64),
  sourceKind: 'weekly' as const,
  origin: 'replay' as const,
  reviewLabel: 'CS79',
  importerVersion: 'editorial-csv-import@1',
  textTransform: 'html-to-text@1',
};

function code(request: ImportRequest): string | null {
  try {
    assertImportRequest(request);
    return null;
  } catch (error) {
    if (isIngestionError(error) && error.kind === 'configuration') return error.code;
    throw error;
  }
}

describe('computeIdempotencyKey', () => {
  it('is deterministic and changes with every behaviour-changing input', () => {
    const key = computeIdempotencyKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(computeIdempotencyKey({ ...BASE })).toBe(key);
    expect(computeIdempotencyKey({ ...BASE, reviewLabel: ' CS79 ' })).toBe(key);
    expect(computeIdempotencyKey({ ...BASE, origin: 'fixture' })).not.toBe(key);
    expect(computeIdempotencyKey({ ...BASE, sourceKind: 'master', reviewLabel: null })).not.toBe(
      key,
    );
    expect(computeIdempotencyKey({ ...BASE, reviewLabel: 'CS80' })).not.toBe(key);
    expect(computeIdempotencyKey({ ...BASE, importerVersion: 'editorial-csv-import@2' })).not.toBe(
      key,
    );
    expect(computeIdempotencyKey({ ...BASE, fileSha256: 'b'.repeat(64) })).not.toBe(key);
  });
});

describe('assertImportRequest', () => {
  it('requires an explicit origin', () => {
    expect(
      code({
        filePath: 'x.csv',
        sourceKind: 'master',
        origin: undefined as unknown as 'live',
        reviewLabel: null,
      }),
    ).toBe('origin_required');
    expect(
      code({
        filePath: 'x.csv',
        sourceKind: 'master',
        origin: 'production' as unknown as 'live',
        reviewLabel: null,
      }),
    ).toBe('origin_required');
  });

  it('rejects a review label carrying control characters or exceeding the fixed length', () => {
    const hostile = [
      'CS79\nrows: parsed=0',
      'CS79\r',
      'CS\tX',
      `CS${String.fromCharCode(0x1b)}[31m`,
      `CS${String.fromCharCode(0x9b)}`,
      `CS${String.fromCharCode(0x2028)}`,
      `CS${String.fromCharCode(0x2029)}`,
      'C'.repeat(65),
    ];
    for (const label of hostile) {
      expect(
        code({ filePath: 'x.csv', sourceKind: 'weekly', origin: 'replay', reviewLabel: label }),
        JSON.stringify(label),
      ).toBe('review_label_invalid');
    }
    expect(
      code({
        filePath: 'x.csv',
        sourceKind: 'weekly',
        origin: 'replay',
        reviewLabel: 'C'.repeat(64),
      }),
    ).toBeNull();
  });

  it('rejects a basename carrying control characters, and accepts ordinary names with spaces', () => {
    for (const name of [
      'a.csv\nbatch=forged',
      'a\r.csv',
      `a${String.fromCharCode(0x1b)}[31m.csv`,
      `a${String.fromCharCode(0x2028)}.csv`,
      `${'n'.repeat(256)}.csv`,
    ]) {
      expect(
        code({
          filePath: `/tmp/${name}`,
          sourceKind: 'master',
          origin: 'replay',
          reviewLabel: null,
        }),
        JSON.stringify(name),
      ).toBe('source_basename_invalid');
    }
    expect(
      code({
        filePath: '/tmp/Content @latestincyber - CS79.csv',
        sourceKind: 'weekly',
        origin: 'replay',
        reviewLabel: 'CS79',
      }),
    ).toBeNull();
  });

  it('requires a review label for weekly files and forbids one for master files', () => {
    expect(
      code({ filePath: 'x.csv', sourceKind: 'weekly', origin: 'replay', reviewLabel: null }),
    ).toBe('review_label_required');
    expect(
      code({ filePath: 'x.csv', sourceKind: 'weekly', origin: 'replay', reviewLabel: '  ' }),
    ).toBe('review_label_required');
    expect(
      code({ filePath: 'x.csv', sourceKind: 'master', origin: 'replay', reviewLabel: 'CS79' }),
    ).toBe('review_label_forbidden');
    expect(
      code({ filePath: 'x.csv', sourceKind: 'master', origin: 'replay', reviewLabel: null }),
    ).toBeNull();
    expect(
      code({ filePath: 'x.csv', sourceKind: 'weekly', origin: 'fixture', reviewLabel: 'CS79' }),
    ).toBeNull();
  });
});
