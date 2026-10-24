import { describe, expect, it } from 'vitest';

import {
  assertRestoreDrillSafety,
  compareTableRowCounts,
  parseRestoreDrillTimeout,
} from './restore.js';

describe('restore drill safety', () => {
  it('allows a remote source only when the target is a distinctly named local database', () => {
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://source:secret-marker@db.internal:5432/app',
        'postgresql://localhost:5432/cas_restore_20261023',
      ),
    ).not.toThrow();
  });

  it('refuses a remote restore target without echoing either connection string', () => {
    let caught: unknown;
    const source = 'postgresql://source:source-secret@db.internal/app';
    const target = 'postgresql://restore:target-secret@restore.internal/cas_restore_test';
    try {
      assertRestoreDrillSafety(source, target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(source);
    expect(String(caught)).not.toContain(target);
    expect(String(caught)).not.toContain('source-secret');
    expect(String(caught)).not.toContain('target-secret');
  });

  it('refuses an unsafe target name and the source database itself', () => {
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://localhost:5432/application',
        'postgresql://localhost:5432/scratch',
      ),
    ).toThrow(/must begin with cas_restore_/);
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://127.0.0.1:5432/cas_restore_same',
        'postgresql://localhost:5432/cas_restore_same',
      ),
    ).toThrow(/same database/);
  });
});

describe('restore verification', () => {
  it('reports missing, additional and changed table counts in table order', () => {
    expect(
      compareTableRowCounts(
        [
          { table: 'beta', rows: '2' },
          { table: 'alpha', rows: '1' },
        ],
        [
          { table: 'alpha', rows: '9' },
          { table: 'gamma', rows: '3' },
        ],
      ),
    ).toEqual([
      { table: 'alpha', source: '1', restored: '9' },
      { table: 'beta', source: '2', restored: null },
      { table: 'gamma', source: null, restored: '3' },
    ]);
  });

  it('bounds the external-tool timeout', () => {
    expect(parseRestoreDrillTimeout(undefined)).toBe(300_000);
    expect(parseRestoreDrillTimeout('30')).toBe(30_000);
    expect(parseRestoreDrillTimeout('3600')).toBe(3_600_000);
    for (const value of ['0', '29', '3601', '1.5', 'word']) {
      expect(() => parseRestoreDrillTimeout(value), value).toThrow(/30 to 3600/);
    }
  });
});
