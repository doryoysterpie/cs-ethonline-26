import {
  countRowIssues,
  countSourceRows,
  getImportBatch,
  listImportBatches,
  summarizeReviewSnapshot,
  summarizeUrlGroups,
  type Database,
  type ImportBatchRecord,
  type IssueCodeCount,
  type ReviewSnapshotSummary,
  type SourceRowCounts,
  type UrlGroupStats,
} from '@cas/database';

import { IngestionError } from './errors.js';

/**
 * Count-only reconciliation of stored batches: the batch's recorded counts
 * against the rows actually stored, issue-code counts, review-state counts
 * and URL-group statistics. Nothing here reads a title, URL or body.
 */

export interface BatchReport {
  readonly batch: ImportBatchRecord;
  readonly stored: SourceRowCounts;
  readonly reconciled: boolean;
  readonly issues: readonly IssueCodeCount[];
  readonly review: ReviewSnapshotSummary | null;
  readonly urlGroups: UrlGroupStats;
}

export async function reportBatches(db: Database, batchId: string | null): Promise<BatchReport[]> {
  return db.withClient(async (client) => {
    let batches: ImportBatchRecord[];
    if (batchId === null) {
      batches = await listImportBatches(client);
    } else {
      const one = await getImportBatch(client, batchId);
      if (one === null) {
        throw new IngestionError('configuration', 'batch_not_found', 'no batch with that id');
      }
      batches = [one];
    }
    const reports: BatchReport[] = [];
    for (const batch of batches) {
      const stored = await countSourceRows(client, batch.id);
      reports.push({
        batch,
        stored,
        reconciled:
          stored.total === batch.parsedRowCount &&
          stored.accepted === batch.acceptedRowCount &&
          stored.quarantined === batch.quarantinedRowCount,
        issues: await countRowIssues(client, batch.id),
        review: await summarizeReviewSnapshot(client, batch.id),
        urlGroups: await summarizeUrlGroups(client, batch.id),
      });
    }
    return reports;
  });
}
