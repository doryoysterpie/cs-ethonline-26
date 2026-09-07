import { evaluateCalibration } from '@cas/classification';
import { connectionSecrets, createRedactor, type Redactor } from '@cas/database';
import { describe, expect, it } from 'vitest';

import { ESCAPE_CHARACTER } from '../editorial/display.js';
import {
  formatCalibration,
  formatClassificationRun,
  formatQueue,
  formatRunReport,
} from './output.js';
import type { CalibrationReport, QueueSummary, RunReport } from './report.js';
import type { ClassifyBatchOutcome } from './run.js';

/**
 * Output safety for the classification commands: identifiers, versions,
 * hashes, counts and fixed vocabulary only, one physical line per entry, and
 * the same redaction and escaping the ingestion commands use.
 */

const PASSWORD = 'hunter2-marker-secret';
const REDACT: Redactor = createRedactor(
  connectionSecrets(`postgresql://app:${PASSWORD}@127.0.0.1:5432/cas`),
);
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

const run = {
  id: RUN_ID,
  batchId: BATCH_ID,
  dataOrigin: 'replay' as const,
  classifierVersion: 'rules-classifier@1',
  rulesetVersion: 'classification-signal-policy@1',
  rulesetHash: 'a'.repeat(64),
  mode: 'rules' as const,
  idempotencyKey: 'b'.repeat(64),
  status: 'completed' as const,
  expectedRowCount: 157,
  classifiedRowCount: 157,
  includeCount: 120,
  excludeCount: 7,
  reviewCount: 30,
  startedAt: '2026-09-07T12:00:00.000Z',
  completedAt: '2026-09-07T12:00:05.000Z',
};

const outcome: ClassifyBatchOutcome = {
  outcome: 'classified',
  run,
  batch: {
    id: BATCH_ID,
    dataOrigin: 'replay',
    sourceKind: 'weekly',
    reviewLabel: 'CS79',
    sourceBasename: 'weekly.csv',
    fileSha256: 'c'.repeat(64),
    byteLength: 10,
    headerCells: ['ch'],
    importerVersion: 'editorial-csv-import@1',
    idempotencyKey: 'd'.repeat(64),
    status: 'completed_with_issues',
    parsedRowCount: 157,
    acceptedRowCount: 154,
    quarantinedRowCount: 3,
    startedAt: '2026-09-07T11:00:00.000Z',
    completedAt: '2026-09-07T11:00:01.000Z',
  },
  durationMs: 5000,
};

const report: RunReport = {
  run,
  stored: { include: 120, exclude: 7, review: 30, total: 157 },
  reconciled: true,
  unclassifiedRows: 0,
  rationaleCodes: [
    { code: 'decisive_signal', count: 120 },
    { code: 'row_quarantined', count: 3 },
  ],
};

const queue: QueueSummary = { run, count: 30 };

function calibration(label: string): CalibrationReport {
  return {
    run,
    reviewLabel: label,
    metrics: evaluateCalibration([
      { decision: 'include', reviewState: 'selected', count: 120 },
      { decision: 'review', reviewState: 'selected', count: 10 },
      { decision: 'exclude', reviewState: 'rejected', count: 7 },
    ]),
    meetsTarget: true,
  };
}

function assertSafe(lines: readonly string[]): void {
  for (const line of lines) {
    expect(line.includes('\n')).toBe(false);
    expect(line.includes('\r')).toBe(false);
    expect(line.includes(ESCAPE_CHARACTER)).toBe(false);
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain('postgresql://');
  }
}

describe('classification output', () => {
  it('prints the run with its versions, hash and counts', () => {
    const lines = formatClassificationRun(outcome, REDACT);
    assertSafe(lines);
    expect(lines[0]).toContain(`run=${RUN_ID}`);
    expect(lines[0]).toContain('mode=rules');
    expect(lines[1]).toContain('classifier=rules-classifier@1');
    expect(lines[1]).toContain(`rulesetHash=${'a'.repeat(64)}`);
    expect(lines[3]).toBe('decisions: include=120 exclude=7 review=30');
  });

  it('prints an already-classified run without claiming new writes', () => {
    const lines = formatClassificationRun({ ...outcome, outcome: 'already_classified' }, REDACT);
    expect(lines[0]).toContain('already classified');
    expect(lines[0]).toContain('no results written');
  });

  it('prints the reconciliation report and flags a mismatch loudly', () => {
    const good = formatRunReport(report, REDACT);
    assertSafe(good);
    expect(good.join('\n')).toContain('reconciled=yes');
    expect(good.join('\n')).toContain('decisive_signal=120');
    const bad = formatRunReport({ ...report, reconciled: false, unclassifiedRows: 4 }, REDACT);
    expect(bad.join('\n')).toContain('reconciled=NO');
    expect(bad.join('\n')).toContain('unclassifiedRows=4');
  });

  it('prints the queue as one count and nothing else', () => {
    // The Codex Desktop audit rejected per-entry queue output. One line, one
    // integer: no source-row identifier, row number, score or rationale code.
    const lines = formatQueue(queue, REDACT);
    assertSafe(lines);
    expect(lines).toEqual(['classification_queue count=30']);
    expect(formatQueue({ run, count: 0 }, REDACT)).toEqual(['classification_queue count=0']);
    const joined = formatQueue(queue, REDACT).join('\n');
    for (const forbidden of ['row=', 'rowNumber', 'codes=', 'score', run.id, run.batchId]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
  });

  it('prints calibration as counts and ratios, with the target and whether it was met', () => {
    const lines = formatCalibration(calibration('CS79'), REDACT);
    assertSafe(lines);
    expect(lines.join('\n')).toContain('label=CS79');
    expect(lines.join('\n')).toContain('selectedRetention=1');
    expect(lines.join('\n')).toContain('target=0.98 met=yes');
    expect(lines.join('\n')).toContain('include/selected=120');
    const missed = formatCalibration({ ...calibration('CS86'), meetsTarget: false }, REDACT);
    expect(missed.join('\n')).toContain('met=NO');
  });

  it('renders a hostile review label as safe single-line text', () => {
    const hostile = `CS79${ESCAPE_CHARACTER}[31m\nclassification:report: run=forged`;
    const lines = formatCalibration(calibration(hostile), REDACT);
    assertSafe(lines);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain('CS79\\x1b[31m\\nclassification:report: run=forged');
    expect(lines.join('\n').split('\n')).toHaveLength(7);
  });

  it('redacts a database password that appears in a review label', () => {
    const lines = formatCalibration(calibration(`CS-${PASSWORD}`), REDACT);
    assertSafe(lines);
    expect(lines[0]).toContain('[REDACTED]');
  });
});
