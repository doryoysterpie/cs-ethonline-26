import { createHash, randomUUID } from 'node:crypto';

import type { ChainId } from '@cas/contracts';
import {
  completeEvidenceRun,
  countAssociations,
  countEvidenceStates,
  findEvidenceRunByIdempotencyKey,
  getClusteringRun,
  getEvidenceRun,
  getGraphSignalRun,
  insertAssociations,
  insertEvidenceStates,
  insertRunningEvidenceRun,
  isDatabaseError,
  listEffectiveAssociations,
  listIncidentSubjects,
  listSignalsForRun,
  type Database,
  type EvidenceRunRecord,
  type Queryable,
} from '@cas/database';
import {
  correlate,
  evidenceContractHash,
  resolveEvidenceState,
  CONTRACT_VERSION,
  EVIDENCE_CONTRACT,
  RESOLVER_VERSION,
  type AcceptedAssociation,
  type IncidentSubject,
  type SignalSubject,
} from '@cas/evidence';

import { IngestionError } from '../editorial/errors.js';

/**
 * Correlating one clustering run against one signal run, and resolving every
 * incident's evidence state (decision D25).
 *
 * `@cas/worker` composes: the pure engine decides, `@cas/database` stores, and
 * this file carries neither rule. The lifecycle is the one Sprints 3 and 4
 * settled on — insert the run `running`, write its rows, complete last, and
 * let the database validate the counters — so a partially written evidence run
 * cannot exist.
 *
 * Resolution reads *effective* association status: the machine's suggestion
 * plus whatever a human has since decided. On a first pass nothing is accepted
 * yet, so every incident resolves to `reported_only`, which is correct rather
 * than disappointing: nothing has been accepted, so nothing is corroborated.
 */

export interface EvidenceRunRequest {
  readonly clusteringRunId: string;
  readonly signalRunId: string;
}

export interface EvidenceRunOutcome {
  readonly outcome: 'resolved' | 'already_resolved';
  readonly run: EvidenceRunRecord;
  readonly suggestions: number;
  readonly rejectedPairs: number;
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

function idempotencyKey(input: {
  readonly clusteringRunId: string;
  readonly signalRunId: string;
  readonly contractHash: string;
  readonly resolverVersion: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Correlates and resolves, writing exactly one evidence run. */
export async function resolveEvidence(
  db: Database,
  request: EvidenceRunRequest,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly makeId?: (() => string) | undefined;
  } = {},
): Promise<EvidenceRunOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;

  const clustering = await db.withClient((client) =>
    getClusteringRun(client, request.clusteringRunId),
  );
  if (clustering === null || clustering.status !== 'completed') {
    throw configuration('clustering_run_not_completed', 'no completed clustering run with that id');
  }
  const signalRun = await db.withClient((client) => getGraphSignalRun(client, request.signalRunId));
  if (signalRun === null || signalRun.status !== 'completed') {
    throw configuration('signal_run_not_completed', 'no completed signal run with that id');
  }

  const contractHash = evidenceContractHash();
  const key = idempotencyKey({
    clusteringRunId: clustering.id,
    signalRunId: signalRun.id,
    contractHash,
    resolverVersion: RESOLVER_VERSION,
  });

  const existing = await db.withClient((client) => findEvidenceRunByIdempotencyKey(client, key));
  if (existing !== null && existing.status === 'completed') {
    return {
      outcome: 'already_resolved',
      run: existing,
      suggestions: existing.suggestionCount,
      rejectedPairs: 0,
    };
  }

  const runId = makeId();
  const startedAt = now().toISOString();
  let rejectedPairs = 0;

  try {
    await db.withTransaction(
      async (tx: Queryable) => {
        await insertRunningEvidenceRun(tx, {
          id: runId,
          clusteringRunId: clustering.id,
          batchId: clustering.batchId,
          signalRunId: signalRun.id,
          dataOrigin: clustering.dataOrigin,
          resolverVersion: RESOLVER_VERSION,
          contractVersion: CONTRACT_VERSION,
          contractHash,
          idempotencyKey: key,
          startedAt,
        });

        const incidentRows = await listIncidentSubjects(
          tx,
          clustering.id,
          EVIDENCE_CONTRACT.bounds.maximumIncidentsPerRun,
        );
        const signalRows = await listSignalsForRun(
          tx,
          signalRun.id,
          EVIDENCE_CONTRACT.bounds.maximumSignalsPerRun,
        );

        const incidents: IncidentSubject[] = incidentRows.map((row) => ({
          incidentId: row.incidentId,
          clusteringRunId: row.clusteringRunId,
          batchId: row.batchId,
          chain: row.chain,
          protocolSlug: row.protocolSlug,
          earliestReportedAt:
            row.earliestReportedAt === null
              ? null
              : Math.floor(Date.parse(row.earliestReportedAt) / 1000),
          claimIds: [],
        }));
        const signals: SignalSubject[] = signalRows.map((row) => ({
          signalId: row.id,
          signalRunId: row.signalRunId,
          chain: row.chain,
          protocolSlug: row.protocolSlug,
          observedAt: Math.floor(Date.parse(row.observedAt) / 1000),
          deltaPercent: row.deltaPercent,
        }));

        const correlation = correlate(incidents, signals);
        rejectedPairs = correlation.rejections.length;
        const byChain = new Map<string, ChainId>(
          signalRows.map((row) => [row.id, row.chain] as const),
        );
        await insertAssociations(
          tx,
          correlation.suggestions.map((suggestion) => ({
            id: makeId(),
            evidenceRunId: runId,
            clusteringRunId: clustering.id,
            batchId: clustering.batchId,
            signalRunId: signalRun.id,
            incidentClusterId: suggestion.incidentId,
            signalId: suggestion.signalId,
            chain: byChain.get(suggestion.signalId) ?? 'ethereum',
            claimId: suggestion.claimId,
            relation: suggestion.relation,
            reasonCodes: suggestion.reasonCodes,
            offsetSeconds: suggestion.offsetSeconds,
            createdAt: startedAt,
          })),
        );

        // Effective status: the suggestion plus any decision already recorded.
        const effective = await listEffectiveAssociations(
          tx,
          runId,
          EVIDENCE_CONTRACT.bounds.maximumIncidentsPerRun,
        );
        const accepted: AcceptedAssociation[] = effective.map((row) => ({
          incidentId: row.incidentId,
          signalId: row.signalId,
          claimId: row.claimId,
          relation: row.relation,
          status: row.status,
        }));

        await insertEvidenceStates(
          tx,
          incidents.map((incident) => {
            const resolved = resolveEvidenceState(incident.incidentId, accepted);
            return {
              id: makeId(),
              evidenceRunId: runId,
              clusteringRunId: clustering.id,
              batchId: clustering.batchId,
              signalRunId: signalRun.id,
              incidentClusterId: incident.incidentId,
              state: resolved.state,
              reasonCode: resolved.reason,
              claimId: resolved.claimId,
              acceptedAssociationCount: resolved.acceptedAssociationIds.length,
              createdAt: startedAt,
            };
          }),
        );

        const counts = await countEvidenceStates(tx, runId);
        await completeEvidenceRun(
          tx,
          runId,
          {
            ...counts,
            signalCount: signals.length,
            suggestionCount: correlation.suggestions.length,
          },
          now().toISOString(),
        );
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (isDatabaseError(error) && (error.code === '23505' || error.code === '40001')) {
      const winner = await db.withClient((client) => findEvidenceRunByIdempotencyKey(client, key));
      if (winner !== null && winner.status === 'completed') {
        return {
          outcome: 'already_resolved',
          run: winner,
          suggestions: winner.suggestionCount,
          rejectedPairs: 0,
        };
      }
    }
    throw error;
  }

  const stored = await db.withClient((client) => getEvidenceRun(client, runId));
  if (stored === null || stored.status !== 'completed') {
    throw new IngestionError(
      'database',
      'evidence_run_not_completed',
      'the evidence run did not complete',
    );
  }
  return {
    outcome: 'resolved',
    run: stored,
    suggestions: stored.suggestionCount,
    rejectedPairs,
  };
}

export interface EvidenceReport {
  readonly run: EvidenceRunRecord;
  readonly states: Awaited<ReturnType<typeof countEvidenceStates>>;
  readonly associations: Awaited<ReturnType<typeof countAssociations>>;
  readonly reconciled: boolean;
}

/** Count-only reconciliation report for one explicit evidence run. */
export async function reportEvidenceRun(db: Database, runId: string): Promise<EvidenceReport> {
  const run = await db.withClient((client) => getEvidenceRun(client, runId));
  if (run === null) {
    throw configuration('evidence_run_not_found', 'no evidence run with that id');
  }
  return db.withClient(async (client) => {
    const states = await countEvidenceStates(client, run.id);
    const associations = await countAssociations(client, run.id);
    return {
      run,
      states,
      associations,
      reconciled:
        states.total === run.incidentCount &&
        states.reportedOnly === run.reportedOnlyCount &&
        states.onchainObserved === run.onchainObservedCount &&
        states.corroborated === run.corroboratedCount &&
        states.contradicted === run.contradictedCount,
    };
  });
}
