import type { EvidenceState } from '@cas/contracts';

import { HEADLINE_MAX_CHARACTERS } from '../bounds.js';
import { ToolError } from '../safety/errors.js';
import type { Redactor } from '../safety/redact.js';
import { quoteBoundedEvidence } from '../safety/text.js';
import type { EvidenceRunProvenanceDto, IncidentSummaryDto } from '../schemas/output.js';
import type { EvidenceRunRow, IncidentReadStore, IncidentSummaryRow } from '../store/read-store.js';

/**
 * What every tool receives beside its validated arguments: the call's one
 * abort signal, handed to the store provider so the call's transaction checks
 * it before every statement and cancels a statement in flight when it fires,
 * and to the live source so a request socket aborts with the call; and the
 * runtime's redactor, applied to retrieved text before it is escaped or
 * bounded for display.
 */
export interface ToolContext {
  readonly signal: AbortSignal;
  readonly redact: Redactor;
}

/** Fixed sentence per evidence state. Never composed from input. */
export const EVIDENCE_SENTENCES: Readonly<Record<EvidenceState, string>> = {
  reported_only: 'Reporting only; no on-chain evidence has been accepted for this incident.',
  onchain_observed:
    'Relevant on-chain activity was observed and accepted. It does not establish that this attack occurred.',
  corroborated: 'An accepted on-chain signal supports one specific claim of this incident.',
  contradicted:
    'Accepted evidence conflicts with one specific claim of this incident. It is unresolved.',
};

/** Loads a run and refuses anything but a completed one. */
export async function requireCompletedEvidenceRun(
  store: IncidentReadStore,
  evidenceRunId: string,
): Promise<EvidenceRunRow & { readonly status: 'completed'; readonly completedAt: string }> {
  const run = await store.getEvidenceRun(evidenceRunId);
  if (run === null) throw new ToolError('evidence_run_not_found');
  if (run.status !== 'completed' || run.completedAt === null) {
    throw new ToolError('evidence_run_not_completed');
  }
  return { ...run, status: 'completed', completedAt: run.completedAt };
}

export function runProvenance(
  run: EvidenceRunRow & { readonly status: 'completed'; readonly completedAt: string },
): EvidenceRunProvenanceDto {
  return {
    evidenceRunId: run.id,
    clusteringRunId: run.clusteringRunId,
    batchId: run.batchId,
    signalRunId: run.signalRunId,
    dataOrigin: run.dataOrigin,
    status: 'completed',
    resolverVersion: run.resolverVersion,
    contractVersion: run.contractVersion,
    contractHash: run.contractHash,
    incidentCount: run.incidentCount,
    stateCounts: {
      reportedOnly: run.reportedOnlyCount,
      onchainObserved: run.onchainObservedCount,
      corroborated: run.corroboratedCount,
      contradicted: run.contradictedCount,
    },
    completedAt: run.completedAt,
  };
}

export function incidentSummaryDto(row: IncidentSummaryRow, redact: Redactor): IncidentSummaryDto {
  return {
    incidentId: row.incidentId,
    kind: row.kind,
    memberCount: row.memberCount,
    sourceCount: row.sourceCount,
    reasonCodes: [...row.reasonCodes],
    evidence: {
      state: row.state,
      reasonCode: row.stateReasonCode,
      claimId: row.claimId,
      acceptedAssociationCount: row.acceptedAssociationCount,
      sentence: EVIDENCE_SENTENCES[row.state],
    },
    subject: {
      recorded: row.subjectChain !== null && row.subjectProtocolSlug !== null,
      chain: row.subjectChain,
      protocolSlug: row.subjectProtocolSlug,
    },
    headline: quoteBoundedEvidence(row.headline, HEADLINE_MAX_CHARACTERS, redact),
    earliestReportedAt: row.earliestReportedAt,
    dataOrigin: row.dataOrigin,
  };
}

/** Lowercases a validated UUID so a mixed-case argument names the same row. */
export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}
