import type { Queryable } from './database.js';
import { MAX_ROWS_PER_INSERT } from './ingestion.js';

/**
 * Parameterized operations over the Sheets import provenance tables of
 * migration 0012. Every value travels as a bound parameter. Nothing here
 * reads a cell: the tables hold digests, a title, a zone, counts, instants
 * and the serial text of converted timestamp cells.
 */

export interface NewSheetsImportRead {
  readonly batchId: string;
  readonly dataOrigin: 'live';
  readonly workbookDigest: string;
  readonly tabDigest: string;
  readonly tabTitle: string;
  readonly sheetTimeZone: string | null;
  readonly serialTransform: string;
  readonly rowsRead: number;
  readonly pages: number;
  readonly readStartedAt: string;
  readonly readCompletedAt: string;
}

export type SheetsImportReadRecord = NewSheetsImportRead;

export interface NewSheetsImportTimestamp {
  readonly id: string;
  readonly batchId: string;
  readonly dataOrigin: 'live';
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly columnIndex: number;
  readonly serialText: string;
  readonly instant: string | null;
}

export interface SourceRowIdentity {
  readonly id: string;
  readonly rowNumber: number;
  readonly rowHash: string;
}

export async function insertSheetsImportRead(
  client: Queryable,
  read: NewSheetsImportRead,
): Promise<void> {
  await client.query(
    `INSERT INTO sheets_import_reads (
       batch_id, data_origin, workbook_digest, tab_digest, tab_title, sheet_time_zone,
       serial_transform, rows_read, pages, read_started_at, read_completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)`,
    [
      read.batchId,
      read.dataOrigin,
      read.workbookDigest,
      read.tabDigest,
      read.tabTitle,
      read.sheetTimeZone,
      read.serialTransform,
      read.rowsRead,
      read.pages,
      read.readStartedAt,
      read.readCompletedAt,
    ],
  );
}

export async function getSheetsImportRead(
  client: Queryable,
  batchId: string,
): Promise<SheetsImportReadRecord | null> {
  const result = await client.query<{
    batch_id: string;
    data_origin: 'live';
    workbook_digest: string;
    tab_digest: string;
    tab_title: string;
    sheet_time_zone: string | null;
    serial_transform: string;
    rows_read: number;
    pages: number;
    read_started_at: string;
    read_completed_at: string;
  }>(
    `SELECT batch_id, data_origin, workbook_digest, tab_digest, tab_title, sheet_time_zone,
            serial_transform, rows_read, pages,
            to_json(read_started_at) #>> '{}' AS read_started_at,
            to_json(read_completed_at) #>> '{}' AS read_completed_at
       FROM sheets_import_reads WHERE batch_id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    workbookDigest: row.workbook_digest,
    tabDigest: row.tab_digest,
    tabTitle: row.tab_title,
    sheetTimeZone: row.sheet_time_zone,
    serialTransform: row.serial_transform,
    rowsRead: row.rows_read,
    pages: row.pages,
    readStartedAt: row.read_started_at,
    readCompletedAt: row.read_completed_at,
  };
}

const TIMESTAMP_COLUMNS = [
  'id',
  'batch_id',
  'data_origin',
  'source_row_id',
  'row_hash',
  'column_index',
  'serial_text',
  'instant',
] as const;

/** Inserts up to `MAX_ROWS_PER_INSERT` converted serials in one statement. */
export async function insertSheetsImportTimestamps(
  client: Queryable,
  rows: readonly NewSheetsImportTimestamp[],
): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > MAX_ROWS_PER_INSERT) {
    throw new RangeError(`at most ${MAX_ROWS_PER_INSERT} sheets timestamps per insert`);
  }
  const values: unknown[] = [];
  const tuples: string[] = [];
  rows.forEach((row, index) => {
    const base = index * TIMESTAMP_COLUMNS.length;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::timestamptz)`,
    );
    values.push(
      row.id,
      row.batchId,
      row.dataOrigin,
      row.sourceRowId,
      row.rowHash,
      row.columnIndex,
      row.serialText,
      row.instant,
    );
  });
  await client.query(
    `INSERT INTO sheets_import_timestamps (${TIMESTAMP_COLUMNS.join(', ')}) VALUES\n${tuples.join(',\n')}`,
    values,
  );
}

export async function countSheetsImportTimestamps(
  client: Queryable,
  batchId: string,
): Promise<{ readonly total: number; readonly converted: number }> {
  const result = await client.query<{ total: string; converted: string }>(
    `SELECT count(*)::text AS total, count(instant)::text AS converted
       FROM sheets_import_timestamps WHERE batch_id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  return { total: Number(row?.total ?? 0), converted: Number(row?.converted ?? 0) };
}

/** The stored identity of every row of a batch: id, position and hash, nothing else. */
export async function listSourceRowIdentities(
  client: Queryable,
  batchId: string,
): Promise<SourceRowIdentity[]> {
  const result = await client.query<{ id: string; row_number: number; row_hash: string }>(
    `SELECT id, row_number, row_hash FROM source_rows WHERE batch_id = $1 ORDER BY row_number`,
    [batchId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    rowNumber: row.row_number,
    rowHash: row.row_hash,
  }));
}
