import type {
  DataOrigin,
  EditorialSourceKind,
  ImportBatchStatus,
  ReviewState,
  RowIssueSeverity,
  SourceRowStatus,
} from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * Parameterized operations over the editorial ingestion tables. Every value
 * travels as a bound parameter, so SQL-looking source content is inert data.
 * Multi-row inserts build a VALUES list whose length is the only thing that
 * varies; no value is ever interpolated into SQL text.
 */

export interface NewImportBatch {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly sourceKind: EditorialSourceKind;
  readonly reviewLabel: string | null;
  readonly sourceBasename: string;
  readonly fileSha256: string;
  readonly byteLength: number;
  readonly headerCells: readonly string[];
  readonly importerVersion: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

export interface ImportBatchRecord extends NewImportBatch {
  readonly status: ImportBatchStatus;
  readonly parsedRowCount: number;
  readonly acceptedRowCount: number;
  readonly quarantinedRowCount: number;
  readonly completedAt: string | null;
}

export interface NewSourceRow {
  readonly id: string;
  readonly batchId: string;
  readonly rowNumber: number;
  readonly dataOrigin: DataOrigin;
  readonly status: SourceRowStatus;
  readonly rawCells: readonly string[];
  readonly rawFields: Readonly<Record<string, string>>;
  readonly rawCh: string | null;
  readonly rawDatePosted: string | null;
  readonly rawDateUpdated: string | null;
  readonly rawTitle: string | null;
  readonly rawAuthor: string | null;
  readonly rawDescription: string | null;
  readonly rawSummary: string | null;
  readonly rawUrl: string | null;
  readonly rawCategory: string | null;
  readonly postedAt: string | null;
  readonly updatedAt: string | null;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
  readonly textTransform: string;
  readonly canonicalUrl: string | null;
  readonly urlGroupId: string | null;
  readonly rowHash: string;
}

export interface NewRowIssue {
  readonly id: string;
  readonly batchId: string;
  readonly sourceRowId: string;
  readonly issueCode: string;
  readonly field: string | null;
  readonly severity: RowIssueSeverity;
  readonly message: string;
}

export interface NewReviewSnapshot {
  readonly id: string;
  readonly batchId: string;
  readonly reviewLabel: string;
  readonly dataOrigin: DataOrigin;
  readonly createdAt: string;
}

export interface NewReviewEntry {
  readonly id: string;
  readonly snapshotId: string;
  readonly sourceRowId: string;
  /** The batch both the snapshot and the source row must belong to; enforced relationally by migration 0002. */
  readonly batchId: string;
  readonly rawValue: string | null;
  readonly reviewState: ReviewState;
}

/** Upper bound on rows per multi-row INSERT so the parameter count stays far below the protocol limit. */
export const MAX_ROWS_PER_INSERT = 200;

function valuesList(rowCount: number, columnCount: number, casts: readonly string[] = []): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const params: string[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const cast = casts[c] ?? '';
      params.push(`$${r * columnCount + c + 1}${cast === '' ? '' : `::${cast}`}`);
    }
    rows.push(`(${params.join(', ')})`);
  }
  return rows.join(',\n');
}

function assertChunk(count: number, what: string): void {
  if (count === 0) throw new DatabaseError('query', `refusing to insert zero ${what}`);
  if (count > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError('query', `refusing to insert more than ${MAX_ROWS_PER_INSERT} ${what}`);
  }
}

interface BatchRow {
  id: string;
  data_origin: DataOrigin;
  source_kind: EditorialSourceKind;
  review_label: string | null;
  source_basename: string;
  file_sha256: string;
  byte_length: string;
  header_cells: string[];
  importer_version: string;
  idempotency_key: string;
  status: ImportBatchStatus;
  parsed_row_count: number;
  accepted_row_count: number;
  quarantined_row_count: number;
  started_at: string;
  completed_at: string | null;
}

const BATCH_COLUMNS = `id, data_origin, source_kind, review_label, source_basename, file_sha256,
  byte_length::text AS byte_length, header_cells, importer_version, idempotency_key, status,
  parsed_row_count, accepted_row_count, quarantined_row_count,
  to_json(started_at) #>> '{}' AS started_at, to_json(completed_at) #>> '{}' AS completed_at`;

function toBatchRecord(row: BatchRow): ImportBatchRecord {
  return {
    id: row.id,
    dataOrigin: row.data_origin,
    sourceKind: row.source_kind,
    reviewLabel: row.review_label,
    sourceBasename: row.source_basename,
    fileSha256: row.file_sha256,
    byteLength: Number(row.byte_length),
    headerCells: row.header_cells,
    importerVersion: row.importer_version,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    parsedRowCount: row.parsed_row_count,
    acceptedRowCount: row.accepted_row_count,
    quarantinedRowCount: row.quarantined_row_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function findImportBatchByIdempotencyKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<ImportBatchRecord | null> {
  const result = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM import_batches WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toBatchRecord(row);
}

export async function getImportBatch(
  client: Queryable,
  id: string,
): Promise<ImportBatchRecord | null> {
  const result = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toBatchRecord(row);
}

export async function listImportBatches(client: Queryable): Promise<ImportBatchRecord[]> {
  const result = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM import_batches ORDER BY started_at, id`,
  );
  return result.rows.map(toBatchRecord);
}

/** Inserts the batch with zero counts and status `completed`; `finalizeImportBatch` sets the real values in the same transaction. */
export async function insertImportBatch(client: Queryable, batch: NewImportBatch): Promise<void> {
  await client.query(
    `INSERT INTO import_batches (
       id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
       header_cells, importer_version, idempotency_key, status, parsed_row_count,
       accepted_row_count, quarantined_row_count, started_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'completed', 0, 0, 0, $11::timestamptz, NULL)`,
    [
      batch.id,
      batch.dataOrigin,
      batch.sourceKind,
      batch.reviewLabel,
      batch.sourceBasename,
      batch.fileSha256,
      batch.byteLength,
      JSON.stringify(batch.headerCells),
      batch.importerVersion,
      batch.idempotencyKey,
      batch.startedAt,
    ],
  );
}

export interface BatchCompletion {
  readonly id: string;
  readonly status: ImportBatchStatus;
  readonly parsedRowCount: number;
  readonly acceptedRowCount: number;
  readonly quarantinedRowCount: number;
  readonly completedAt: string;
}

export async function finalizeImportBatch(
  client: Queryable,
  completion: BatchCompletion,
): Promise<void> {
  const result = await client.query(
    `UPDATE import_batches
        SET status = $2, parsed_row_count = $3, accepted_row_count = $4,
            quarantined_row_count = $5, completed_at = $6::timestamptz
      WHERE id = $1`,
    [
      completion.id,
      completion.status,
      completion.parsedRowCount,
      completion.acceptedRowCount,
      completion.quarantinedRowCount,
      completion.completedAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new DatabaseError('query', 'batch to finalize was not found', {
      details: { batchId: completion.id },
    });
  }
}

/**
 * Ensures one url_groups row per distinct canonical URL and returns the id
 * for each. Existing groups are reused; the no-op ON CONFLICT update makes
 * RETURNING yield them. Input is de-duplicated first because a single
 * statement may not touch the same conflict row twice.
 */
export async function ensureUrlGroups(
  client: Queryable,
  canonicalUrls: readonly string[],
  makeId: () => string,
): Promise<Map<string, string>> {
  const distinct = [...new Set(canonicalUrls)];
  const map = new Map<string, string>();
  if (distinct.length === 0) return map;
  const ids = distinct.map(() => makeId());
  const result = await client.query<{ id: string; canonical_url: string }>(
    `INSERT INTO url_groups (id, canonical_url)
       SELECT * FROM unnest($1::uuid[], $2::text[])
       ON CONFLICT (canonical_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url
       RETURNING id, canonical_url`,
    [ids, distinct],
  );
  for (const row of result.rows) map.set(row.canonical_url, row.id);
  if (map.size !== distinct.length) {
    throw new DatabaseError('query', 'url group upsert returned an unexpected row count', {
      details: { expected: distinct.length, received: map.size },
    });
  }
  return map;
}

const SOURCE_ROW_COLUMNS = [
  'id',
  'batch_id',
  'row_number',
  'data_origin',
  'status',
  'raw_cells',
  'raw_fields',
  'raw_ch',
  'raw_date_posted',
  'raw_date_updated',
  'raw_title',
  'raw_author',
  'raw_description',
  'raw_summary',
  'raw_url',
  'raw_category',
  'posted_at',
  'updated_at',
  'normalized_title',
  'derived_summary_text',
  'derived_description_text',
  'text_transform',
  'canonical_url',
  'url_group_id',
  'row_hash',
] as const;

/** Explicit casts for the JSON and timestamp columns; an empty string means no cast. */
const SOURCE_ROW_CASTS: readonly string[] = SOURCE_ROW_COLUMNS.map((column) => {
  if (column === 'raw_cells' || column === 'raw_fields') return 'jsonb';
  if (column === 'posted_at' || column === 'updated_at') return 'timestamptz';
  return '';
});

export async function insertSourceRows(
  client: Queryable,
  rows: readonly NewSourceRow[],
): Promise<void> {
  assertChunk(rows.length, 'source rows');
  const values: unknown[] = [];
  for (const row of rows) {
    values.push(
      row.id,
      row.batchId,
      row.rowNumber,
      row.dataOrigin,
      row.status,
      JSON.stringify(row.rawCells),
      JSON.stringify(row.rawFields),
      row.rawCh,
      row.rawDatePosted,
      row.rawDateUpdated,
      row.rawTitle,
      row.rawAuthor,
      row.rawDescription,
      row.rawSummary,
      row.rawUrl,
      row.rawCategory,
      row.postedAt,
      row.updatedAt,
      row.normalizedTitle,
      row.derivedSummaryText,
      row.derivedDescriptionText,
      row.textTransform,
      row.canonicalUrl,
      row.urlGroupId,
      row.rowHash,
    );
  }
  await client.query(
    `INSERT INTO source_rows (${SOURCE_ROW_COLUMNS.join(', ')}) VALUES\n${valuesList(
      rows.length,
      SOURCE_ROW_COLUMNS.length,
      SOURCE_ROW_CASTS,
    )}`,
    values,
  );
}

export async function insertRowIssues(
  client: Queryable,
  issues: readonly NewRowIssue[],
): Promise<void> {
  if (issues.length === 0) return;
  assertChunk(issues.length, 'row issues');
  const values: unknown[] = [];
  for (const issue of issues) {
    values.push(
      issue.id,
      issue.batchId,
      issue.sourceRowId,
      issue.issueCode,
      issue.field,
      issue.severity,
      issue.message,
    );
  }
  await client.query(
    `INSERT INTO row_issues (id, batch_id, source_row_id, issue_code, field, severity, message) VALUES\n${valuesList(
      issues.length,
      7,
    )}`,
    values,
  );
}

export async function insertReviewSnapshot(
  client: Queryable,
  snapshot: NewReviewSnapshot,
): Promise<void> {
  await client.query(
    `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)`,
    [snapshot.id, snapshot.batchId, snapshot.reviewLabel, snapshot.dataOrigin, snapshot.createdAt],
  );
}

export async function insertReviewEntries(
  client: Queryable,
  entries: readonly NewReviewEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  assertChunk(entries.length, 'review entries');
  const values: unknown[] = [];
  for (const entry of entries) {
    values.push(
      entry.id,
      entry.snapshotId,
      entry.sourceRowId,
      entry.batchId,
      entry.rawValue,
      entry.reviewState,
    );
  }
  await client.query(
    `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state) VALUES\n${valuesList(
      entries.length,
      6,
    )}`,
    values,
  );
}

// ---------------------------------------------------------------------------
// Count-only reads for reconciliation, reports and tests.

export interface SourceRowCounts {
  readonly total: number;
  readonly accepted: number;
  readonly quarantined: number;
}

export async function countSourceRows(
  client: Queryable,
  batchId: string,
): Promise<SourceRowCounts> {
  const result = await client.query<{ status: SourceRowStatus; count: string }>(
    'SELECT status, count(*)::text AS count FROM source_rows WHERE batch_id = $1 GROUP BY status',
    [batchId],
  );
  let accepted = 0;
  let quarantined = 0;
  for (const row of result.rows) {
    if (row.status === 'accepted') accepted = Number(row.count);
    else quarantined = Number(row.count);
  }
  return { total: accepted + quarantined, accepted, quarantined };
}

export interface IssueCodeCount {
  readonly issueCode: string;
  readonly field: string | null;
  readonly severity: RowIssueSeverity;
  readonly count: number;
}

export async function countRowIssues(
  client: Queryable,
  batchId: string,
): Promise<IssueCodeCount[]> {
  const result = await client.query<{
    issue_code: string;
    field: string | null;
    severity: RowIssueSeverity;
    count: string;
  }>(
    `SELECT issue_code, field, severity, count(*)::text AS count
       FROM row_issues WHERE batch_id = $1
       GROUP BY issue_code, field, severity ORDER BY issue_code, field, severity`,
    [batchId],
  );
  return result.rows.map((row) => ({
    issueCode: row.issue_code,
    field: row.field,
    severity: row.severity,
    count: Number(row.count),
  }));
}

export interface ReviewStateCount {
  readonly reviewState: ReviewState;
  readonly count: number;
}

export interface ReviewSnapshotSummary {
  readonly snapshotId: string;
  readonly reviewLabel: string;
  readonly entries: readonly ReviewStateCount[];
  readonly entriesOnQuarantinedRows: number;
}

export async function summarizeReviewSnapshot(
  client: Queryable,
  batchId: string,
): Promise<ReviewSnapshotSummary | null> {
  const snapshot = await client.query<{ id: string; review_label: string }>(
    'SELECT id, review_label FROM review_snapshots WHERE batch_id = $1',
    [batchId],
  );
  const row = snapshot.rows[0];
  if (row === undefined) return null;
  const counts = await client.query<{ review_state: ReviewState; count: string }>(
    `SELECT review_state, count(*)::text AS count FROM review_entries
      WHERE snapshot_id = $1 GROUP BY review_state ORDER BY review_state`,
    [row.id],
  );
  const quarantined = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM review_entries e
       JOIN source_rows r ON r.id = e.source_row_id
      WHERE e.snapshot_id = $1 AND r.status = 'quarantined'`,
    [row.id],
  );
  return {
    snapshotId: row.id,
    reviewLabel: row.review_label,
    entries: counts.rows.map((c) => ({ reviewState: c.review_state, count: Number(c.count) })),
    entriesOnQuarantinedRows: Number(quarantined.rows[0]?.count ?? '0'),
  };
}

export interface UrlGroupStats {
  readonly rowsWithGroup: number;
  readonly distinctGroups: number;
  /** Rows beyond the first in each group, within the batch: the duplicate excess. */
  readonly duplicateExcess: number;
}

export async function summarizeUrlGroups(
  client: Queryable,
  batchId: string,
): Promise<UrlGroupStats> {
  const result = await client.query<{ rows_with_group: string; distinct_groups: string }>(
    `SELECT count(url_group_id)::text AS rows_with_group,
            count(DISTINCT url_group_id)::text AS distinct_groups
       FROM source_rows WHERE batch_id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  const rowsWithGroup = Number(row?.rows_with_group ?? '0');
  const distinctGroups = Number(row?.distinct_groups ?? '0');
  return { rowsWithGroup, distinctGroups, duplicateExcess: rowsWithGroup - distinctGroups };
}

export interface StoredSourceRow extends NewSourceRow {
  readonly reviewState: ReviewState | null;
  readonly reviewRawValue: string | null;
}

/** Full rows of one batch in row order. Used by tests to prove exact round trips. */
export async function getSourceRows(
  client: Queryable,
  batchId: string,
): Promise<StoredSourceRow[]> {
  const result = await client.query<{
    id: string;
    batch_id: string;
    row_number: number;
    data_origin: DataOrigin;
    status: SourceRowStatus;
    raw_cells: string[];
    raw_fields: Record<string, string>;
    raw_ch: string | null;
    raw_date_posted: string | null;
    raw_date_updated: string | null;
    raw_title: string | null;
    raw_author: string | null;
    raw_description: string | null;
    raw_summary: string | null;
    raw_url: string | null;
    raw_category: string | null;
    posted_at: string | null;
    updated_at: string | null;
    normalized_title: string | null;
    derived_summary_text: string | null;
    derived_description_text: string | null;
    text_transform: string;
    canonical_url: string | null;
    url_group_id: string | null;
    row_hash: string;
    review_state: ReviewState | null;
    review_raw_value: string | null;
  }>(
    `SELECT r.id, r.batch_id, r.row_number, r.data_origin, r.status, r.raw_cells, r.raw_fields,
            r.raw_ch, r.raw_date_posted, r.raw_date_updated, r.raw_title, r.raw_author,
            r.raw_description, r.raw_summary, r.raw_url, r.raw_category,
            to_json(r.posted_at) #>> '{}' AS posted_at, to_json(r.updated_at) #>> '{}' AS updated_at,
            r.normalized_title, r.derived_summary_text, r.derived_description_text,
            r.text_transform, r.canonical_url, r.url_group_id, r.row_hash,
            e.review_state, e.raw_value AS review_raw_value
       FROM source_rows r
       LEFT JOIN review_entries e ON e.source_row_id = r.id
      WHERE r.batch_id = $1 ORDER BY r.row_number`,
    [batchId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    rowNumber: row.row_number,
    dataOrigin: row.data_origin,
    status: row.status,
    rawCells: row.raw_cells,
    rawFields: row.raw_fields,
    rawCh: row.raw_ch,
    rawDatePosted: row.raw_date_posted,
    rawDateUpdated: row.raw_date_updated,
    rawTitle: row.raw_title,
    rawAuthor: row.raw_author,
    rawDescription: row.raw_description,
    rawSummary: row.raw_summary,
    rawUrl: row.raw_url,
    rawCategory: row.raw_category,
    postedAt: row.posted_at,
    updatedAt: row.updated_at,
    normalizedTitle: row.normalized_title,
    derivedSummaryText: row.derived_summary_text,
    derivedDescriptionText: row.derived_description_text,
    textTransform: row.text_transform,
    canonicalUrl: row.canonical_url,
    urlGroupId: row.url_group_id,
    rowHash: row.row_hash,
    reviewState: row.review_state,
    reviewRawValue: row.review_raw_value,
  }));
}

export async function countAllRows(client: Queryable): Promise<{
  readonly batches: number;
  readonly sourceRows: number;
  readonly rowIssues: number;
  readonly urlGroups: number;
  readonly reviewSnapshots: number;
  readonly reviewEntries: number;
}> {
  const result = await client.query<{
    batches: string;
    source_rows: string;
    row_issues: string;
    url_groups: string;
    review_snapshots: string;
    review_entries: string;
  }>(
    `SELECT (SELECT count(*) FROM import_batches)::text AS batches,
            (SELECT count(*) FROM source_rows)::text AS source_rows,
            (SELECT count(*) FROM row_issues)::text AS row_issues,
            (SELECT count(*) FROM url_groups)::text AS url_groups,
            (SELECT count(*) FROM review_snapshots)::text AS review_snapshots,
            (SELECT count(*) FROM review_entries)::text AS review_entries`,
  );
  const row = result.rows[0];
  return {
    batches: Number(row?.batches ?? '0'),
    sourceRows: Number(row?.source_rows ?? '0'),
    rowIssues: Number(row?.row_issues ?? '0'),
    urlGroups: Number(row?.url_groups ?? '0'),
    reviewSnapshots: Number(row?.review_snapshots ?? '0'),
    reviewEntries: Number(row?.review_entries ?? '0'),
  };
}
