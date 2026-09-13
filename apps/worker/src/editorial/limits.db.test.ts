import { countAllRows } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture, openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { isIngestionError } from './errors.js';
import { importCsvFile } from './import.js';

/**
 * A crossed import limit leaves no partial write.
 *
 * The structural pass refuses the file before a transaction is opened, so
 * the proof is direct: after the refusal every table is as empty as it was.
 * The same file then imports whole under the versioned defaults, which shows
 * the limit, and nothing else, was the cause.
 */
describe('import limits against an isolated migrated schema', () => {
  let isolated: IsolatedSchema;

  beforeAll(async () => {
    isolated = await openMigratedSchema();
  });

  afterAll(async () => {
    await isolated.close();
  });

  const request = {
    filePath: fixture('master-synthetic.csv'),
    sourceKind: 'master',
    origin: 'fixture',
    reviewLabel: null,
  } as const;

  it('refuses the master fixture under a lowered row limit before any row is written', async () => {
    const before = await isolated.db.withClient((client) => countAllRows(client));
    expect(before).toEqual({
      batches: 0,
      sourceRows: 0,
      rowIssues: 0,
      urlGroups: 0,
      reviewSnapshots: 0,
      reviewEntries: 0,
    });
    let caught: unknown;
    try {
      await importCsvFile(isolated.db, request, { limits: { rowCount: 5 } });
    } catch (error) {
      caught = error;
    }
    if (!isIngestionError(caught)) throw new Error('expected a refusal');
    expect(caught.kind).toBe('structural');
    expect(caught.code).toBe('limit_row_count');
    expect(caught.details).toEqual({ limit: 5 });
    const after = await isolated.db.withClient((client) => countAllRows(client));
    expect(after).toEqual(before);
  });

  it('refuses the same fixture under a lowered cell limit, again without a write', async () => {
    let caught: unknown;
    try {
      await importCsvFile(isolated.db, request, { limits: { cellBytes: 1024 } });
    } catch (error) {
      caught = error;
    }
    if (!isIngestionError(caught)) throw new Error('expected a refusal');
    expect(caught.code).toBe('limit_cell_bytes');
    const after = await isolated.db.withClient((client) => countAllRows(client));
    expect(after.batches).toBe(0);
    expect(after.sourceRows).toBe(0);
  });

  it('imports the same fixture whole under the versioned defaults', async () => {
    const outcome = await importCsvFile(isolated.db, request);
    expect(outcome.outcome).toBe('imported');
    expect(outcome.storedRows.total).toBe(12);
    const after = await isolated.db.withClient((client) => countAllRows(client));
    expect(after.batches).toBe(1);
    expect(after.sourceRows).toBe(12);
  });
});
