import { describe, expect, it } from 'vitest';

import { fixture } from '../test-support.js';
import { isIngestionError } from './errors.js';
import { inspectCsvFile, validateCsvFile } from './validate.js';

function counts(report: Awaited<ReturnType<typeof validateCsvFile>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const issue of report.issues)
    out[`${issue.code}:${issue.field ?? '-'}:${issue.severity}`] = issue.count;
  return out;
}

describe('validateCsvFile on the synthetic fixtures', () => {
  it('reports the master fixture count for count without writing anything', async () => {
    const report = await validateCsvFile(fixture('master-synthetic.csv'), 'master');
    expect(report.rows).toBe(12);
    expect(report.accepted).toBe(7);
    expect(report.quarantined).toBe(5);
    expect(counts(report)).toEqual({
      'ch_token_unrecognized:ch:warning': 1,
      'timestamp_invalid:Date Posted:error': 2,
      'title_missing:Title:error': 1,
      'url_invalid:URL:error': 1,
      'url_scheme_not_allowed:URL:error': 1,
    });
    expect(report.chCounts).toEqual({ selectedToken: 4, rejectedToken: 6, blank: 1, other: 1 });
    expect(report.reviewCounts).toBeNull();
    expect(report.exactDuplicateExcess).toBe(1);
    expect(report.canonicalDuplicateExcess).toBe(2);
    expect(report.maxCellLength).toBe(48_400);
    expect(report.structure.bom).toBe(true);
    expect(report.structure.layout.unknownNames).toEqual(['Editor Note']);
    expect(report.structure.basename).toBe('master-synthetic.csv');
  });

  it('reports the weekly fixture including the review states it would record', async () => {
    const report = await validateCsvFile(fixture('weekly-synthetic.csv'), 'weekly');
    expect(report.rows).toBe(8);
    expect(report.accepted).toBe(5);
    expect(report.quarantined).toBe(3);
    expect(counts(report)).toEqual({
      'review_value_unknown:ch:error': 1,
      'timestamp_invalid:Date Posted:error': 1,
      'url_invalid:URL:error': 1,
    });
    expect(report.reviewCounts).toEqual({ selected: 4, rejected: 2, unreviewed: 1 });
    expect(report.chCounts).toEqual({ selectedToken: 4, rejectedToken: 2, blank: 1, other: 1 });
    expect(report.exactDuplicateExcess).toBe(1);
    expect(report.canonicalDuplicateExcess).toBe(1);
    expect(report.structure.layout.blankPositions).toEqual([7, 8]);
  });

  it('evaluates the same file under master rules without deriving review state', async () => {
    const report = await validateCsvFile(fixture('weekly-synthetic.csv'), 'master');
    expect(report.reviewCounts).toBeNull();
    expect(report.quarantined).toBe(2);
    expect(counts(report)['ch_token_unrecognized:ch:warning']).toBe(1);
  });

  it('rejects structural fixtures before producing any row result', async () => {
    const expectations: [string, string][] = [
      ['structural-unclosed-quote.csv', 'csv_'],
      ['structural-duplicate-header.csv', 'header_duplicate'],
      ['structural-missing-required-header.csv', 'header_required_missing'],
      ['structural-inconsistent-columns.csv', 'csv_inconsistent_columns'],
      ['structural-empty.csv', 'header_missing'],
    ];
    for (const [name, prefix] of expectations) {
      let caught: unknown;
      try {
        await validateCsvFile(fixture(name), 'weekly');
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught), name).toBe(true);
      if (isIngestionError(caught)) {
        expect(caught.kind, name).toBe('structural');
        expect(caught.code.startsWith(prefix), `${name} ${caught.code}`).toBe(true);
      }
    }
  });

  it('inspects structure only, counting rows and hashing the file', async () => {
    const structure = await inspectCsvFile(fixture('weekly-synthetic.csv'));
    expect(structure.rowCount).toBe(8);
    expect(structure.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(structure.headerCells).toHaveLength(9);
  });
});
