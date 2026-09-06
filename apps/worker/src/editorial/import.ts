import { createHash, randomUUID } from 'node:crypto';

import type { DataOrigin, EditorialSourceKind, ImportBatchStatus } from '@cas/contracts';
import {
  countRowIssues,
  countSourceRows,
  ensureUrlGroups,
  finalizeImportBatch,
  findImportBatchByIdempotencyKey,
  getImportBatch,
  insertImportBatch,
  insertReviewEntries,
  insertReviewSnapshot,
  insertRowIssues,
  insertSourceRows,
  MAX_ROWS_PER_INSERT,
  summarizeReviewSnapshot,
  summarizeUrlGroups,
  type Database,
  type ImportBatchRecord,
  type IssueCodeCount,
  type NewReviewEntry,
  type NewRowIssue,
  type NewSourceRow,
  type Queryable,
  type ReviewSnapshotSummary,
  type UrlGroupStats,
} from '@cas/database';

import { DEFAULT_CHUNK_SIZE, IMPORTER_VERSION } from './constants.js';
import { readCsv } from './csv-stream.js';
import { IngestionError } from './errors.js';
import { TEXT_TRANSFORM } from './html-text.js';
import { evaluateRow, type RowEvaluation } from './rows.js';
import { inspectCsvFile, type StructuralSummary } from './validate.js';

/**
 * Manual, on-demand import of one CSV export (decision D20).
 *
 * Pass 1 (`inspectCsvFile`) reads the whole file without writing anything:
 * a structural fault rejects the file here, before any database write. The
 * idempotency key, computed from the file hash and every behaviour-changing
 * configuration value, is then looked up; a match returns the original batch
 * and writes nothing. Pass 2 streams the file again inside one transaction,
 * evaluating rows and flushing them in chunks; any error, including an
 * interrupt, rolls the whole batch back. The header and hash observed in
 * pass 2 must equal pass 1, so a file edited between passes is rejected.
 */

export interface ImportRequest {
  readonly filePath: string;
  readonly sourceKind: EditorialSourceKind;
  /** Explicit; there is no default. */
  readonly origin: DataOrigin;
  /** Required for weekly files, forbidden for master files. */
  readonly reviewLabel: string | null;
}

export interface ImportOptions {
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly chunkSize?: number | undefined;
  /** Test hook invoked before each chunk flush; throwing here must roll the batch back. */
  readonly beforeChunk?: ((chunkIndex: number) => void | Promise<void>) | undefined;
}

export interface ImportOutcome {
  readonly outcome: 'imported' | 'already_imported';
  readonly batch: ImportBatchRecord;
  readonly issues: readonly IssueCodeCount[];
  readonly review: ReviewSnapshotSummary | null;
  readonly urlGroups: UrlGroupStats;
  readonly storedRows: {
    readonly total: number;
    readonly accepted: number;
    readonly quarantined: number;
  };
  readonly durationMs: number;
}

export function assertImportRequest(request: ImportRequest): void {
  if (request.sourceKind !== 'master' && request.sourceKind !== 'weekly') {
    throw new IngestionError(
      'configuration',
      'source_kind_invalid',
      'source kind must be master or weekly',
    );
  }
  if (request.origin !== 'live' && request.origin !== 'fixture' && request.origin !== 'replay') {
    throw new IngestionError(
      'configuration',
      'origin_required',
      'data origin must be given explicitly as live, fixture or replay; there is no default',
    );
  }
  const label = request.reviewLabel;
  if (request.sourceKind === 'weekly' && (label === null || label.trim().length === 0)) {
    throw new IngestionError(
      'configuration',
      'review_label_required',
      'a weekly import requires a review label naming the snapshot week',
    );
  }
  if (request.sourceKind === 'master' && label !== null) {
    throw new IngestionError(
      'configuration',
      'review_label_forbidden',
      'a master import must not carry a review label; the master ch column is working state',
    );
  }
}

export interface IdempotencyInputs {
  readonly fileSha256: string;
  readonly sourceKind: EditorialSourceKind;
  readonly origin: DataOrigin;
  readonly reviewLabel: string | null;
  readonly importerVersion: string;
  readonly textTransform: string;
}

/** SHA-256 over the canonical JSON of every behaviour-changing input. The basename is provenance, not behaviour. */
export function computeIdempotencyKey(inputs: IdempotencyInputs): string {
  const canonical = JSON.stringify({
    fileSha256: inputs.fileSha256,
    sourceKind: inputs.sourceKind,
    origin: inputs.origin,
    reviewLabel: inputs.reviewLabel === null ? null : inputs.reviewLabel.trim(),
    importerVersion: inputs.importerVersion,
    textTransform: inputs.textTransform,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface FlushContext {
  readonly tx: Queryable;
  readonly batchId: string;
  readonly snapshotId: string | null;
  readonly origin: DataOrigin;
  readonly makeId: () => string;
}

async function flushChunk(
  context: FlushContext,
  evaluations: readonly RowEvaluation[],
): Promise<{ accepted: number; quarantined: number }> {
  const canonicals = evaluations.map((e) => e.canonicalUrl).filter((c): c is string => c !== null);
  const groups = await ensureUrlGroups(context.tx, canonicals, context.makeId);
  const rows: NewSourceRow[] = [];
  const issues: NewRowIssue[] = [];
  const entries: NewReviewEntry[] = [];
  let accepted = 0;
  let quarantined = 0;
  for (const e of evaluations) {
    const id = context.makeId();
    const groupId = e.canonicalUrl === null ? null : (groups.get(e.canonicalUrl) ?? null);
    if (e.canonicalUrl !== null && groupId === null) {
      throw new IngestionError(
        'unexpected',
        'url_group_unresolved',
        'url group id missing after upsert',
        {
          rowNumber: e.rowNumber,
        },
      );
    }
    rows.push({
      id,
      batchId: context.batchId,
      rowNumber: e.rowNumber,
      dataOrigin: context.origin,
      status: e.status,
      rawCells: e.rawCells,
      rawFields: e.rawFields,
      rawCh: e.raw.ch,
      rawDatePosted: e.raw.datePosted,
      rawDateUpdated: e.raw.dateUpdated,
      rawTitle: e.raw.title,
      rawAuthor: e.raw.author,
      rawDescription: e.raw.description,
      rawSummary: e.raw.summary,
      rawUrl: e.raw.url,
      rawCategory: e.raw.category,
      postedAt: e.postedAt,
      updatedAt: e.updatedAt,
      normalizedTitle: e.normalizedTitle,
      derivedSummaryText: e.derivedSummaryText,
      derivedDescriptionText: e.derivedDescriptionText,
      textTransform: e.textTransform,
      canonicalUrl: e.canonicalUrl,
      urlGroupId: groupId,
      rowHash: e.rowHash,
    });
    if (e.status === 'accepted') accepted += 1;
    else quarantined += 1;
    for (const item of e.issues) {
      issues.push({
        id: context.makeId(),
        batchId: context.batchId,
        sourceRowId: id,
        issueCode: item.code,
        field: item.field,
        severity: item.severity,
        message: item.message,
      });
    }
    if (context.snapshotId !== null && e.review !== null) {
      entries.push({
        id: context.makeId(),
        snapshotId: context.snapshotId,
        sourceRowId: id,
        rawValue: e.review.rawValue,
        reviewState: e.review.state,
      });
    }
  }
  for (const part of chunked(rows, MAX_ROWS_PER_INSERT)) await insertSourceRows(context.tx, part);
  for (const part of chunked(issues, MAX_ROWS_PER_INSERT)) await insertRowIssues(context.tx, part);
  for (const part of chunked(entries, MAX_ROWS_PER_INSERT)) {
    await insertReviewEntries(context.tx, part);
  }
  return { accepted, quarantined };
}

async function describeBatch(
  db: Database,
  batchId: string,
): Promise<Omit<ImportOutcome, 'outcome' | 'durationMs'>> {
  return db.withClient(async (client) => {
    const batch = await getImportBatch(client, batchId);
    if (batch === null) {
      throw new IngestionError('database', 'batch_missing', 'batch not found after import', {
        batchId,
      });
    }
    return {
      batch,
      issues: await countRowIssues(client, batchId),
      review: await summarizeReviewSnapshot(client, batchId),
      urlGroups: await summarizeUrlGroups(client, batchId),
      storedRows: await countSourceRows(client, batchId),
    };
  });
}

export async function importCsvFile(
  db: Database,
  request: ImportRequest,
  options: ImportOptions = {},
): Promise<ImportOutcome> {
  assertImportRequest(request);
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const chunkSize = Math.max(
    1,
    Math.min(options.chunkSize ?? DEFAULT_CHUNK_SIZE, MAX_ROWS_PER_INSERT),
  );
  const startedAt = now();
  const reviewLabel = request.reviewLabel === null ? null : request.reviewLabel.trim();

  const structure: StructuralSummary = await inspectCsvFile(request.filePath, {
    signal: options.signal,
  });
  const idempotencyKey = computeIdempotencyKey({
    fileSha256: structure.sha256,
    sourceKind: request.sourceKind,
    origin: request.origin,
    reviewLabel,
    importerVersion: IMPORTER_VERSION,
    textTransform: TEXT_TRANSFORM,
  });

  const existing = await db.withClient((client) =>
    findImportBatchByIdempotencyKey(client, idempotencyKey),
  );
  if (existing !== null) {
    const described = await describeBatch(db, existing.id);
    return {
      outcome: 'already_imported',
      ...described,
      durationMs: now().getTime() - startedAt.getTime(),
    };
  }

  const batchId = makeId();
  await db.withTransaction(async (tx) => {
    await insertImportBatch(tx, {
      id: batchId,
      dataOrigin: request.origin,
      sourceKind: request.sourceKind,
      reviewLabel,
      sourceBasename: structure.basename,
      fileSha256: structure.sha256,
      byteLength: structure.byteLength,
      headerCells: structure.headerCells,
      importerVersion: IMPORTER_VERSION,
      idempotencyKey,
      startedAt: startedAt.toISOString(),
    });
    let snapshotId: string | null = null;
    if (request.sourceKind === 'weekly' && reviewLabel !== null) {
      snapshotId = makeId();
      await insertReviewSnapshot(tx, {
        id: snapshotId,
        batchId,
        reviewLabel,
        dataOrigin: request.origin,
        createdAt: startedAt.toISOString(),
      });
    }
    const context: FlushContext = { tx, batchId, snapshotId, origin: request.origin, makeId };
    let buffer: RowEvaluation[] = [];
    let chunkIndex = 0;
    let accepted = 0;
    let quarantined = 0;
    let parsed = 0;
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      if (options.signal?.aborted === true) {
        throw new IngestionError('aborted', 'interrupted', 'import interrupted; batch rolled back');
      }
      if (options.beforeChunk !== undefined) await options.beforeChunk(chunkIndex);
      const counts = await flushChunk(context, buffer);
      accepted += counts.accepted;
      quarantined += counts.quarantined;
      buffer = [];
      chunkIndex += 1;
    };
    const stats = await readCsv(
      request.filePath,
      {
        onHeader(cells) {
          if (JSON.stringify(cells) !== JSON.stringify(structure.headerCells)) {
            throw new IngestionError(
              'structural',
              'file_changed',
              'file rejected: header changed between validation and import',
            );
          }
        },
        async onRecord(rowNumber, cells) {
          parsed += 1;
          buffer.push(evaluateRow(rowNumber, cells, structure.layout, request.sourceKind));
          if (buffer.length >= chunkSize) await flush();
        },
      },
      { signal: options.signal },
    );
    await flush();
    if (stats.sha256 !== structure.sha256 || parsed !== structure.rowCount) {
      throw new IngestionError(
        'structural',
        'file_changed',
        'file rejected: content changed between validation and import',
        { expectedRows: structure.rowCount, parsedRows: parsed },
      );
    }
    const status: ImportBatchStatus = quarantined > 0 ? 'completed_with_issues' : 'completed';
    await finalizeImportBatch(tx, {
      id: batchId,
      status,
      parsedRowCount: parsed,
      acceptedRowCount: accepted,
      quarantinedRowCount: quarantined,
      completedAt: now().toISOString(),
    });
  });

  const described = await describeBatch(db, batchId);
  return { outcome: 'imported', ...described, durationMs: now().getTime() - startedAt.getTime() };
}
