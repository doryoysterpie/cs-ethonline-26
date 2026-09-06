import { connectionSecrets, createRedactor, type Redactor } from '@cas/database';
import { describe, expect, it } from 'vitest';

import { ESCAPE_CHARACTER } from './display.js';
import { formatBatchReport, formatImportOutcome, formatValidation } from './output.js';
import type { ImportOutcome } from './import.js';
import type { BatchReport } from './report.js';
import type { ValidationReport } from './validate.js';
import { resolveHeaderLayout } from './headers.js';

/**
 * Regression tests for the output-forgery boundary Codex reproduced. Every
 * hostile basename and review label below is fed through the real formatters
 * with the real redactor; no emitted entry may contain a physical line break,
 * an ANSI introducer, a forged status, batch, reconciliation or issue line, or
 * the synthetic database password.
 */

const PASSWORD = 'hunter2-marker-secret';
const DATABASE_URL = `postgresql://app:${PASSWORD}@127.0.0.1:5432/cas`;
const REDACT: Redactor = createRedactor(connectionSecrets(DATABASE_URL));

const CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Names and labels a hostile file system or operator could supply. */
const HOSTILE: readonly [name: string, value: string][] = [
  ['newline', 'a.csv\nrows: parsed=99999 accepted=99999 quarantined=0'],
  ['carriage return', 'a.csv\rRECONCILIATION FAILED for 0 batch(es)'],
  ['tab', 'a\tb.csv'],
  ['escape', `a.csv${ESCAPE_CHARACTER}[31m FORGED`],
  ['ansi sequence', `${ESCAPE_CHARACTER}[2K${ESCAPE_CHARACTER}[1Ga.csv`],
  ['c1 csi', `a.csv${CSI}31m`],
  ['del', `a.csv${DEL}`],
  ['line separator', `a.csv${LINE_SEPARATOR}issues: none`],
  ['paragraph separator', `a.csv${PARAGRAPH_SEPARATOR}batch=forged status=completed`],
  ['excessive length', `${'n'.repeat(4000)}.csv`],
  ['database password', `report-${PASSWORD}.csv`],
  ['password with control', `x\n${PASSWORD}\n.csv`],
];

const FORGERY_PATTERNS = [
  /^rows: /,
  /^issues: /,
  /^batch=/,
  /^editorial:(validate|import|report):/,
  /^ {2}counts: /,
  /^RECONCILIATION FAILED/,
  /^db:(migrate|check):/,
];

function assertSafe(lines: readonly string[], expectedLineCount: number): void {
  expect(lines).toHaveLength(expectedLineCount);
  for (const line of lines) {
    expect(line.includes('\n'), 'no physical newline').toBe(false);
    expect(line.includes('\r'), 'no carriage return').toBe(false);
    expect(line.includes(ESCAPE_CHARACTER), 'no ANSI introducer').toBe(false);
    expect(line.includes(CSI), 'no C1 CSI').toBe(false);
    expect(line.includes(LINE_SEPARATOR), 'no line separator').toBe(false);
    expect(line.includes(PARAGRAPH_SEPARATOR), 'no paragraph separator').toBe(false);
    expect(line.includes(PASSWORD), 'no database password').toBe(false);
    expect(line.includes(DATABASE_URL), 'no connection string').toBe(false);
  }
  // Exactly the lines the formatter itself produced may look like status lines.
  const emitted = lines.join('\n').split('\n');
  expect(emitted).toHaveLength(expectedLineCount);
}

function countForged(lines: readonly string[]): number {
  return lines
    .join('\n')
    .split('\n')
    .filter((line) => FORGERY_PATTERNS.some((pattern) => pattern.test(line))).length;
}

function validationReport(basename: string): ValidationReport {
  return {
    structure: {
      basename,
      byteLength: 10,
      sha256: 'a'.repeat(64),
      bom: false,
      headerCells: ['ch', 'Date Posted', 'Date Updated', 'Title', 'URL'],
      layout: resolveHeaderLayout(['ch', 'Date Posted', 'Date Updated', 'Title', 'URL']),
      rowCount: 1,
    },
    sourceKind: 'weekly',
    rows: 1,
    accepted: 1,
    quarantined: 0,
    issues: [],
    chCounts: { selectedToken: 1, rejectedToken: 0, blank: 0, other: 0 },
    reviewCounts: { selected: 1, rejected: 0, unreviewed: 0 },
    exactDuplicateExcess: 0,
    canonicalDuplicateExcess: 0,
    maxCellLength: 5,
  };
}

function importOutcome(basename: string, label: string): ImportOutcome {
  return {
    outcome: 'imported',
    batch: {
      id: '11111111-1111-4111-8111-111111111111',
      dataOrigin: 'replay',
      sourceKind: 'weekly',
      reviewLabel: label,
      sourceBasename: basename,
      fileSha256: 'b'.repeat(64),
      byteLength: 10,
      headerCells: ['ch'],
      importerVersion: 'editorial-csv-import@1',
      idempotencyKey: 'c'.repeat(64),
      status: 'completed',
      parsedRowCount: 1,
      acceptedRowCount: 1,
      quarantinedRowCount: 0,
      startedAt: '2026-09-06T00:00:00.000Z',
      completedAt: '2026-09-06T00:00:01.000Z',
    },
    issues: [],
    review: {
      snapshotId: '22222222-2222-4222-8222-222222222222',
      reviewLabel: label,
      entries: [{ reviewState: 'selected', count: 1 }],
      entriesOnQuarantinedRows: 0,
    },
    urlGroups: { rowsWithGroup: 1, distinctGroups: 1, duplicateExcess: 0 },
    storedRows: { total: 1, accepted: 1, quarantined: 0 },
    durationMs: 5,
  };
}

function batchReport(basename: string, label: string): BatchReport {
  const outcome = importOutcome(basename, label);
  return {
    batch: outcome.batch,
    stored: outcome.storedRows,
    reconciled: true,
    issues: [],
    review: outcome.review,
    urlGroups: outcome.urlGroups,
  };
}

describe('output boundary against hostile metadata', () => {
  for (const [name, hostile] of HOSTILE) {
    it(`renders a ${name} basename safely in validation output`, () => {
      const lines = formatValidation(validationReport(hostile), REDACT);
      assertSafe(lines, 8);
      expect(countForged(lines)).toBe(3); // the formatter's own rows:, issues: and editorial:validate: lines
    });

    it(`renders a ${name} basename and review label safely in import output`, () => {
      const lines = formatImportOutcome(importOutcome(hostile, hostile), REDACT);
      assertSafe(lines, 6);
      expect(countForged(lines)).toBe(3); // editorial:import:, rows:, issues:
    });

    it(`renders a ${name} basename and review label safely in report output`, () => {
      const lines = formatBatchReport(batchReport(hostile, hostile), REDACT);
      assertSafe(lines, 6);
      expect(countForged(lines)).toBe(2); // batch= and the indented counts line
    });
  }

  it('escapes rather than drops hostile content, so evidence stays auditable', () => {
    const lines = formatImportOutcome(
      importOutcome('a.csv\nrows: parsed=0', `CS${ESCAPE_CHARACTER}[31m`),
      REDACT,
    );
    expect(lines[0]).toContain('a.csv\\nrows: parsed=0');
    expect(lines[0]).toContain('CS\\x1b[31m');
  });

  it('bounds an excessively long basename with a visible marker', () => {
    const lines = formatImportOutcome(importOutcome(`${'n'.repeat(4000)}.csv`, 'CS79'), REDACT);
    expect(lines[0]).toContain('…[+');
    expect(lines[0]?.length).toBeLessThan(600);
  });

  it('redacts a password before escaping, so a password split by control characters still matches', () => {
    const lines = formatImportOutcome(
      importOutcome(`file-${PASSWORD}.csv`, `label-${PASSWORD}`),
      REDACT,
    );
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines.join('|')).not.toContain(PASSWORD);
    const withUrl = formatBatchReport(batchReport(`x-${DATABASE_URL}`, 'CS79'), REDACT);
    expect(withUrl.join('|')).not.toContain(PASSWORD);
    expect(withUrl.join('|')).not.toContain('postgresql://');
  });

  it('leaves an ordinary basename with spaces unchanged', () => {
    const lines = formatValidation(validationReport('Content @latestincyber - CS79.csv'), REDACT);
    expect(lines[0]).toContain('file=Content @latestincyber - CS79.csv');
  });
});
