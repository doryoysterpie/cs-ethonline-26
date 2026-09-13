import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import {
  ensureUrlGroups,
  insertImportBatch,
  insertReviewEntries,
  insertReviewSnapshot,
  insertRowIssues,
  insertSourceRows,
  type NewSourceRow,
} from './ingestion.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * Relational provenance integrity (migration 0002). Every test below writes a
 * consistent batch through the ordinary operations, then attempts one
 * contradictory relationship directly in SQL and proves PostgreSQL rejects it.
 */

interface Fixture {
  readonly batchId: string;
  readonly snapshotId: string;
  readonly acceptedRowId: string;
  readonly quarantinedRowId: string;
  readonly groupId: string;
  readonly canonicalUrl: string;
}

function sourceRow(
  batchId: string,
  rowNumber: number,
  overrides: Partial<NewSourceRow> = {},
): NewSourceRow {
  return {
    id: randomUUID(),
    batchId,
    rowNumber,
    dataOrigin: 'replay',
    status: 'accepted',
    rawCells: ['TRUE'],
    rawFields: { ch: 'TRUE' },
    rawCh: 'TRUE',
    rawDatePosted: null,
    rawDateUpdated: null,
    rawTitle: 'Seed title',
    rawAuthor: null,
    rawDescription: null,
    rawSummary: null,
    rawUrl: 'https://seed.example/one',
    rawCategory: null,
    postedAt: null,
    updatedAt: null,
    normalizedTitle: 'Seed title',
    derivedSummaryText: null,
    derivedDescriptionText: null,
    textTransform: 'html-to-text@1',
    canonicalUrl: null,
    urlGroupId: null,
    rowHash: String(rowNumber).repeat(64).slice(0, 64),
    ...overrides,
  };
}

/** One weekly batch: two rows sharing a URL group, one issue, a snapshot and two entries. */
async function seed(
  db: Database,
  options: { readonly origin?: 'replay' | 'fixture'; readonly label?: string } = {},
): Promise<Fixture> {
  const origin = options.origin ?? 'replay';
  const label = options.label ?? 'CS79';
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const canonicalUrl = `https://seed.example/${randomUUID()}`;
  let groupId = '';
  const acceptedRowId = randomUUID();
  const quarantinedRowId = randomUUID();
  await db.withTransaction(async (tx) => {
    await insertImportBatch(tx, {
      id: batchId,
      dataOrigin: origin,
      sourceKind: 'weekly',
      reviewLabel: label,
      sourceBasename: 'seed.csv',
      fileSha256: 'a'.repeat(64),
      byteLength: 10,
      headerCells: ['ch'],
      importerVersion: 'editorial-csv-import@1',
      idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      startedAt: new Date().toISOString(),
    });
    await insertReviewSnapshot(tx, {
      id: snapshotId,
      batchId,
      reviewLabel: label,
      dataOrigin: origin,
      createdAt: new Date().toISOString(),
    });
    const groups = await ensureUrlGroups(tx, [canonicalUrl], randomUUID);
    groupId = groups.get(canonicalUrl) ?? '';
    await insertSourceRows(tx, [
      sourceRow(batchId, 1, {
        id: acceptedRowId,
        dataOrigin: origin,
        canonicalUrl,
        urlGroupId: groupId,
      }),
      sourceRow(batchId, 2, {
        id: quarantinedRowId,
        dataOrigin: origin,
        status: 'quarantined',
        canonicalUrl,
        urlGroupId: groupId,
      }),
    ]);
    await insertRowIssues(tx, [
      {
        id: randomUUID(),
        batchId,
        sourceRowId: quarantinedRowId,
        issueCode: 'url_invalid',
        field: 'URL',
        severity: 'error',
        message: 'URL cannot be parsed',
      },
    ]);
    await insertReviewEntries(tx, [
      {
        id: randomUUID(),
        snapshotId,
        sourceRowId: acceptedRowId,
        batchId,
        rawValue: 'TRUE',
        reviewState: 'selected',
      },
      {
        id: randomUUID(),
        snapshotId,
        sourceRowId: quarantinedRowId,
        batchId,
        rawValue: 'TRUE',
        reviewState: 'selected',
      },
    ]);
    await tx.query(
      `UPDATE import_batches SET status = 'completed_with_issues', parsed_row_count = 2,
              accepted_row_count = 1, quarantined_row_count = 1, completed_at = now()
        WHERE id = $1`,
      [batchId],
    );
  });
  return { batchId, snapshotId, acceptedRowId, quarantinedRowId, groupId, canonicalUrl };
}

async function expectRejected(
  db: Database,
  attempt: (tx: Queryable) => Promise<unknown>,
): Promise<string> {
  let caught: unknown;
  try {
    await db.withTransaction(async (tx) => {
      await attempt(tx);
    });
  } catch (error) {
    caught = error;
  }
  expect(isDatabaseError(caught), 'PostgreSQL must reject the contradiction').toBe(true);
  if (!isDatabaseError(caught)) throw new Error('unreachable');
  expect(caught.kind).toBe('query');
  return caught.code ?? '';
}

describe('relational provenance integrity after migration 0002', () => {
  let isolated: IsolatedSchema;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('accepts a normal weekly batch and keeps a review entry on a quarantined row', async () => {
    const f = await seed(isolated.db);
    const entries = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM review_entries e
           JOIN source_rows r ON r.id = e.source_row_id
          WHERE e.batch_id = $1 AND r.status = 'quarantined'`,
        [f.batchId],
      ),
    );
    expect(entries.rows[0]?.count).toBe('1');
  });

  it('accepts a normal master batch with no snapshot', async () => {
    const batchId = randomUUID();
    await isolated.db.withTransaction(async (tx) => {
      await insertImportBatch(tx, {
        id: batchId,
        dataOrigin: 'replay',
        sourceKind: 'master',
        reviewLabel: null,
        sourceBasename: 'master.csv',
        fileSha256: 'c'.repeat(64),
        byteLength: 10,
        headerCells: ['ch'],
        importerVersion: 'editorial-csv-import@1',
        idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        startedAt: new Date().toISOString(),
      });
      await insertSourceRows(tx, [sourceRow(batchId, 1)]);
      await tx.query(
        `UPDATE import_batches SET parsed_row_count = 1, accepted_row_count = 1 WHERE id = $1`,
        [batchId],
      );
    });
    const rows = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM source_rows WHERE batch_id = $1',
        [batchId],
      ),
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('rejects a source row whose origin differs from its batch', async () => {
    const f = await seed(isolated.db);
    const code = await expectRejected(isolated.db, (tx) =>
      tx.query("UPDATE source_rows SET data_origin = 'live' WHERE id = $1", [f.acceptedRowId]),
    );
    expect(code).toBe('23503');
    await expectRejected(isolated.db, (tx) =>
      insertSourceRows(tx, [sourceRow(f.batchId, 99, { dataOrigin: 'fixture' })]),
    );
  });

  it('rejects an issue whose batch is not the batch of its source row', async () => {
    const a = await seed(isolated.db);
    const b = await seed(isolated.db);
    const code = await expectRejected(isolated.db, (tx) =>
      insertRowIssues(tx, [
        {
          id: randomUUID(),
          batchId: b.batchId,
          sourceRowId: a.acceptedRowId,
          issueCode: 'title_missing',
          field: 'Title',
          severity: 'error',
          message: 'Title is empty',
        },
      ]),
    );
    expect(code).toBe('23503');
    await expectRejected(isolated.db, (tx) =>
      tx.query('UPDATE row_issues SET batch_id = $1 WHERE batch_id = $2', [b.batchId, a.batchId]),
    );
  });

  it('rejects a snapshot whose label or origin differs from its batch', async () => {
    const f = await seed(isolated.db);
    const labelCode = await expectRejected(isolated.db, (tx) =>
      tx.query("UPDATE review_snapshots SET review_label = 'CS99' WHERE id = $1", [f.snapshotId]),
    );
    expect(labelCode).toBe('23503');
    await expectRejected(isolated.db, (tx) =>
      tx.query("UPDATE review_snapshots SET data_origin = 'fixture' WHERE id = $1", [f.snapshotId]),
    );
    const other = await seed(isolated.db, { label: 'CS80' });
    await expectRejected(isolated.db, (tx) =>
      insertReviewSnapshot(tx, {
        id: randomUUID(),
        batchId: other.batchId,
        reviewLabel: 'CS79',
        dataOrigin: 'replay',
        createdAt: new Date().toISOString(),
      }),
    );
  });

  it('rejects a review entry joining one batch snapshot to another batch source row', async () => {
    const a = await seed(isolated.db);
    const b = await seed(isolated.db);
    // Clear batch B's own entries so the rejection below is the composite
    // foreign key, not the one-entry-per-row uniqueness of migration 0001.
    await isolated.db.withClient((c) =>
      c.query('DELETE FROM review_entries WHERE batch_id = $1', [b.batchId]),
    );
    const code = await expectRejected(isolated.db, (tx) =>
      insertReviewEntries(tx, [
        {
          id: randomUUID(),
          snapshotId: a.snapshotId,
          sourceRowId: b.acceptedRowId,
          batchId: a.batchId,
          rawValue: 'TRUE',
          reviewState: 'selected',
        },
      ]),
    );
    expect(code).toBe('23503');
    // Naming the row's batch instead fails on the snapshot side.
    await expectRejected(isolated.db, (tx) =>
      insertReviewEntries(tx, [
        {
          id: randomUUID(),
          snapshotId: a.snapshotId,
          sourceRowId: b.quarantinedRowId,
          batchId: b.batchId,
          rawValue: 'TRUE',
          reviewState: 'selected',
        },
      ]),
    );
    await expectRejected(isolated.db, (tx) =>
      tx.query('UPDATE review_entries SET batch_id = $1 WHERE batch_id = $2', [
        b.batchId,
        a.batchId,
      ]),
    );
  });

  it('rejects a source row whose canonical URL disagrees with its URL group', async () => {
    const f = await seed(isolated.db);
    const code = await expectRejected(isolated.db, (tx) =>
      tx.query('UPDATE source_rows SET canonical_url = $1 WHERE id = $2', [
        'https://other.example/x',
        f.acceptedRowId,
      ]),
    );
    expect(code).toBe('23503');
    const otherGroup = await isolated.db.withTransaction((tx) =>
      ensureUrlGroups(tx, ['https://other.example/group'], randomUUID),
    );
    await expectRejected(isolated.db, (tx) =>
      tx.query('UPDATE source_rows SET url_group_id = $1 WHERE id = $2', [
        otherGroup.get('https://other.example/group'),
        f.acceptedRowId,
      ]),
    );
  });

  it('rejects a batch whose basename or review label carries a control character or is too long', async () => {
    const hostile = [
      { basename: 'a.csv\nbatch=forged', label: 'CS79' },
      { basename: `a${String.fromCharCode(0x1b)}.csv`, label: 'CS79' },
      { basename: `a${String.fromCharCode(0x2028)}.csv`, label: 'CS79' },
      { basename: `${'n'.repeat(256)}.csv`, label: 'CS79' },
      { basename: 'a.csv', label: 'CS79\nrows: parsed=0' },
      { basename: 'a.csv', label: `CS${String.fromCharCode(0x9b)}` },
      { basename: 'a.csv', label: 'C'.repeat(65) },
    ];
    for (const { basename, label } of hostile) {
      let caught: unknown;
      try {
        await isolated.db.withTransaction((tx) =>
          insertImportBatch(tx, {
            id: randomUUID(),
            dataOrigin: 'replay',
            sourceKind: 'weekly',
            reviewLabel: label,
            sourceBasename: basename,
            fileSha256: 'd'.repeat(64),
            byteLength: 10,
            headerCells: ['ch'],
            importerVersion: 'editorial-csv-import@1',
            idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
            startedAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(isDatabaseError(caught), JSON.stringify({ basename, label })).toBe(true);
      if (isDatabaseError(caught)) expect(caught.code).toBe('23514');
    }
  });

  it('still accepts an ordinary basename containing spaces and punctuation', async () => {
    const batchId = randomUUID();
    await isolated.db.withTransaction((tx) =>
      insertImportBatch(tx, {
        id: batchId,
        dataOrigin: 'replay',
        sourceKind: 'weekly',
        reviewLabel: 'CS86',
        sourceBasename: 'Content @latestincyber - CS86.csv',
        fileSha256: 'e'.repeat(64),
        byteLength: 10,
        headerCells: ['ch'],
        importerVersion: 'editorial-csv-import@1',
        idempotencyKey: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
        startedAt: new Date().toISOString(),
      }),
    );
    const stored = await isolated.db.withClient((c) =>
      c.query<{ source_basename: string }>(
        'SELECT source_basename FROM import_batches WHERE id = $1',
        [batchId],
      ),
    );
    expect(stored.rows[0]?.source_basename).toBe('Content @latestincyber - CS86.csv');
  });

  it('leaves raw editorial fields free of the metadata restrictions', async () => {
    const f = await seed(isolated.db);
    await isolated.db.withClient((c) =>
      c.query(`UPDATE source_rows SET raw_title = $1, raw_summary = $2 WHERE id = $3`, [
        `title\nwith\r\nnewlines${String.fromCharCode(0x1b)}[31m`,
        'x'.repeat(50_000),
        f.acceptedRowId,
      ]),
    );
    const stored = await isolated.db.withClient((c) =>
      c.query<{ raw_title: string; len: number }>(
        'SELECT raw_title, length(raw_summary) AS len FROM source_rows WHERE id = $1',
        [f.acceptedRowId],
      ),
    );
    expect(stored.rows[0]?.raw_title).toContain('\n');
    expect(stored.rows[0]?.len).toBe(50_000);
  });
});
