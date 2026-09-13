import { createHash, randomUUID } from 'node:crypto';

import {
  clusterEligible,
  CLUSTERING_CONTRACT,
  ClusteringBoundError,
  contractHash,
  CONTRACT_VERSION,
  ENGINE_VERSION,
  type ClusteringInput,
} from '@cas/clustering';
import {
  completeClusteringRun,
  countIneligibleMemberships,
  countUncoveredEligibleResults,
  deriveClusteringCounts,
  fetchClusteringInputs,
  findClusteringRunByIdempotencyKey,
  getClassificationRun,
  getClusteringRun,
  insertAmbiguousLinks,
  insertIncidentClusters,
  insertIncidentMemberships,
  insertRunningClusteringRun,
  isDatabaseError,
  MAX_ROWS_PER_INSERT,
  type ClassificationRunRecord,
  type ClusteringRunRecord,
  type Database,
  type NewAmbiguousLink,
  type NewIncidentCluster,
  type NewIncidentMembership,
  type Queryable,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/**
 * Clustering orchestration (decision D22).
 *
 * The same lifecycle Sprint 3 arrived at after two audits: one repeatable-read
 * transaction, the run inserted `running`, deterministic bounded paging, and a
 * completion the database validates by re-deriving every counter from the
 * stored output. The source set is already frozen by migration 0005, and the
 * classification run is already immutable, so the eligible set cannot move
 * under the run.
 *
 * `@cas/worker` composes the pure engine with the database operations and
 * holds no clustering logic of its own.
 */

export const DEFAULT_PAGE_SIZE = 500;

export interface ClusterRunRequest {
  readonly classificationRunId: string;
}

export interface ClusterRunOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly pageSize?: number | undefined;
}

export interface ClusterRunOutcome {
  readonly outcome: 'clustered' | 'already_clustered';
  readonly run: ClusteringRunRecord;
  readonly classificationRun: ClassificationRunRecord;
  readonly durationMs: number;
}

/**
 * SHA-256 over everything that changes the output: the classification run and
 * the engine and contract identity. A changed contract changes the hash and so
 * produces a distinct clustering run rather than silently reusing the old one.
 */
export function computeClusteringIdempotencyKey(inputs: {
  readonly classificationRunId: string;
  readonly engineVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        classificationRunId: inputs.classificationRunId,
        engineVersion: inputs.engineVersion,
        contractVersion: inputs.contractVersion,
        contractHash: inputs.contractHash,
      }),
    )
    .digest('hex');
}

async function loadClassificationRun(db: Database, id: string): Promise<ClassificationRunRecord> {
  const run = await db.withClient((client) => getClassificationRun(client, id));
  if (run === null) {
    throw new IngestionError(
      'configuration',
      'classification_run_not_found',
      'no classification run with that id',
    );
  }
  if (run.status !== 'completed') {
    throw new IngestionError(
      'configuration',
      'classification_run_not_completed',
      'clustering requires a completed classification run',
    );
  }
  return run;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function clusterClassificationRun(
  db: Database,
  request: ClusterRunRequest,
  options: ClusterRunOptions = {},
): Promise<ClusterRunOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_ROWS_PER_INSERT),
  );
  const startedAt = now();
  const elapsed = (): number => now().getTime() - startedAt.getTime();

  const classificationRun = await loadClassificationRun(db, request.classificationRunId);
  const contract = CLUSTERING_CONTRACT;
  const hash = contractHash(contract);
  const idempotencyKey = computeClusteringIdempotencyKey({
    classificationRunId: classificationRun.id,
    engineVersion: ENGINE_VERSION,
    contractVersion: CONTRACT_VERSION,
    contractHash: hash,
  });

  const existing = await db.withClient((client) =>
    findClusteringRunByIdempotencyKey(client, idempotencyKey),
  );
  if (existing !== null && existing.status === 'completed') {
    return {
      outcome: 'already_clustered',
      run: existing,
      classificationRun,
      durationMs: elapsed(),
    };
  }

  const runId = makeId();
  const createdAt = startedAt.toISOString();
  try {
    await db.withTransaction(
      async (tx: Queryable) => {
        await insertRunningClusteringRun(tx, {
          id: runId,
          classificationRunId: classificationRun.id,
          batchId: classificationRun.batchId,
          dataOrigin: classificationRun.dataOrigin,
          engineVersion: ENGINE_VERSION,
          contractVersion: CONTRACT_VERSION,
          contractHash: hash,
          idempotencyKey,
          startedAt: createdAt,
        });

        // Read the eligible set in deterministic bounded pages. Clustering is
        // a whole-corpus decision, so the pages are collected before the
        // engine runs; the database truncates text to the contract's own
        // limit, which bounds what a page can weigh.
        const inputs: ClusteringInput[] = [];
        let afterRowNumber = 0;
        for (;;) {
          const page = await fetchClusteringInputs(tx, classificationRun.id, {
            afterRowNumber,
            limit: pageSize,
            maxTextCharacters: contract.textAssembly.maxInputCharacters ?? 100000,
            eligibleDecisions: contract.eligibleDecisions,
          });
          if (page.length === 0) break;
          for (const row of page) {
            inputs.push({
              sourceRowId: row.sourceRowId,
              rowHash: row.rowHash,
              classificationResultId: row.classificationResultId,
              classificationRunId: row.classificationRunId,
              batchId: row.batchId,
              dataOrigin: row.dataOrigin,
              decision: row.decision,
              urlGroupId: row.urlGroupId,
              postedAt: row.postedAt,
              normalizedTitle: row.normalizedTitle,
              derivedSummaryText: row.derivedSummaryText,
              derivedDescriptionText: row.derivedDescriptionText,
            });
            afterRowNumber = row.rowNumber;
          }
        }

        // A bound the engine cannot satisfy fails the whole transaction: the
        // `running` run row inserted above is rolled back with it, so no
        // partial clusters, memberships or links survive and no completed run
        // is ever written. The message states the fixed condition and the
        // numeric bound only; nothing derived from a URL or from source text
        // reaches the output.
        let outcome;
        try {
          outcome = clusterEligible(inputs, contract);
        } catch (error) {
          if (error instanceof ClusteringBoundError) {
            throw new IngestionError(
              'structural',
              error.reason,
              'clustering refused the run: one exact-URL duplicate group exceeds the cluster bound',
              { bound: error.bound },
            );
          }
          throw error;
        }

        const clusterIds = new Map<string, string>();
        const clusters: NewIncidentCluster[] = outcome.clusters.map((cluster) => {
          const id = makeId();
          clusterIds.set(cluster.fingerprint, id);
          return {
            id,
            clusteringRunId: runId,
            batchId: classificationRun.batchId,
            fingerprint: cluster.fingerprint,
            kind: cluster.kind,
            memberCount: cluster.members.length,
            duplicateGroupCount: cluster.duplicateGroupCount,
            syndicationGroupCount: cluster.syndicationGroupCount,
            reasonCodes: cluster.reasonCodes,
            representativeSourceRowId: cluster.representativeSourceRowId,
            createdAt,
          };
        });
        for (const part of chunk(clusters, MAX_ROWS_PER_INSERT)) {
          await insertIncidentClusters(tx, part);
        }

        const byRow = new Map(inputs.map((input) => [input.sourceRowId, input]));
        const memberships: NewIncidentMembership[] = [];
        for (const cluster of outcome.clusters) {
          const clusterId = clusterIds.get(cluster.fingerprint) ?? '';
          for (const member of cluster.members) {
            const input = byRow.get(member.sourceRowId);
            if (input === undefined) {
              throw new IngestionError(
                'unexpected',
                'membership_without_input',
                'the engine returned a member that was not in its input',
              );
            }
            memberships.push({
              id: makeId(),
              clusteringRunId: runId,
              incidentClusterId: clusterId,
              batchId: classificationRun.batchId,
              dataOrigin: classificationRun.dataOrigin,
              sourceRowId: member.sourceRowId,
              rowHash: member.rowHash,
              classificationResultId: member.classificationResultId,
              classificationRunId: classificationRun.id,
              decision: member.decision,
              duplicateFingerprint: member.duplicateFingerprint,
              syndicationFingerprint: member.syndicationFingerprint,
              createdAt,
            });
          }
        }
        for (const part of chunk(memberships, MAX_ROWS_PER_INSERT)) {
          await insertIncidentMemberships(tx, part);
        }

        const links: NewAmbiguousLink[] = outcome.ambiguousLinks.map((link) => ({
          id: makeId(),
          clusteringRunId: runId,
          batchId: classificationRun.batchId,
          leftFingerprint: link.leftFingerprint,
          rightFingerprint: link.rightFingerprint,
          reasonCodes: link.reasonCodes,
          similarity: link.similarity,
          sharedSignals: link.sharedSignals,
          sharedRareSignals: link.sharedRareSignals,
          createdAt,
        }));
        for (const part of chunk(links, MAX_ROWS_PER_INSERT)) {
          await insertAmbiguousLinks(tx, part);
        }

        // Reconcile against the stored output before completing.
        const counts = await deriveClusteringCounts(
          tx,
          runId,
          classificationRun.id,
          contract.eligibleDecisions,
        );
        const uncovered = await countUncoveredEligibleResults(
          tx,
          runId,
          classificationRun.id,
          contract.eligibleDecisions,
        );
        const ineligible = await countIneligibleMemberships(tx, runId, contract.eligibleDecisions);
        if (uncovered !== 0 || ineligible !== 0 || memberships.length !== counts.eligibleRowCount) {
          throw new IngestionError(
            'database',
            'run_not_reconciled',
            'clustering output does not cover the eligible results exactly',
            { uncovered, ineligible, stored: memberships.length },
          );
        }
        await completeClusteringRun(tx, runId, counts, now().toISOString());
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (isDatabaseError(error) && (error.code === '23505' || error.code === '40001')) {
      const winner = await db.withClient((client) =>
        findClusteringRunByIdempotencyKey(client, idempotencyKey),
      );
      if (winner !== null && winner.status === 'completed') {
        return {
          outcome: 'already_clustered',
          run: winner,
          classificationRun,
          durationMs: elapsed(),
        };
      }
      throw new IngestionError(
        'database',
        'clustering_run_in_progress',
        'another clustering run for this classification run and contract is in progress',
      );
    }
    throw error;
  }

  const stored = await db.withClient((client) => getClusteringRun(client, runId));
  if (stored === null || stored.status !== 'completed') {
    throw new IngestionError(
      'database',
      'run_not_completed',
      'clustering run is missing or not completed after the transaction committed',
    );
  }
  return { outcome: 'clustered', run: stored, classificationRun, durationMs: elapsed() };
}
