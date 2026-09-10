import type { EvidenceState } from '@cas/contracts';
import type * as z from 'zod/v4';

import { HEADLINE_MAX_CHARACTERS } from '../bounds.js';
import { ToolError } from '../safety/errors.js';
import { quoteEvidence } from '../safety/text.js';
import {
  hex64Schema,
  hostnameSchema,
  RECORDED_ORIGIN_PROVENANCE,
  versionIdentifierSchema,
} from '../schemas/common.js';
import type { EvidenceRunProvenanceDto, IncidentSummaryDto } from '../schemas/output.js';
import type {
  EvidenceRunRow,
  IncidentReadStore,
  IncidentSummaryRow,
  SignalRunRow,
} from '../store/read-store.js';

/** Fixed sentence per evidence state. Never composed from input. */
export const EVIDENCE_SENTENCES: Readonly<Record<EvidenceState, string>> = {
  reported_only: 'Reporting only; no on-chain evidence has been accepted for this incident.',
  onchain_observed:
    'Relevant on-chain activity was observed and accepted. It does not establish that this attack occurred.',
  corroborated: 'An accepted on-chain signal supports one specific claim of this incident.',
  contradicted:
    'Accepted evidence conflicts with one specific claim of this incident. It is unresolved.',
};

/**
 * Controlled metadata is held to its grammar before anything else of the run
 * is read. A stored value outside the grammar (a version column carrying an
 * escape sequence, a hash that is not one) cannot be described in the fixed
 * vocabulary, so the run is refused with a fixed code that names the field
 * and never the value.
 */
export function requireGrammar(field: string, value: string, grammar: z.ZodType): string {
  if (!grammar.safeParse(value).success) throw new ToolError('stored_metadata_invalid', { field });
  return value;
}

/** Loads a run and refuses anything but a completed one with well-formed metadata. */
export async function requireCompletedEvidenceRun(
  store: IncidentReadStore,
  evidenceRunId: string,
): Promise<EvidenceRunRow & { readonly status: 'completed'; readonly completedAt: string }> {
  const run = await store.getEvidenceRun(evidenceRunId);
  if (run === null) throw new ToolError('evidence_run_not_found');
  if (run.status !== 'completed' || run.completedAt === null) {
    throw new ToolError('evidence_run_not_completed');
  }
  requireGrammar('resolverVersion', run.resolverVersion, versionIdentifierSchema);
  requireGrammar('contractVersion', run.contractVersion, versionIdentifierSchema);
  requireGrammar('contractHash', run.contractHash, hex64Schema);
  return { ...run, status: 'completed', completedAt: run.completedAt };
}

/** Loads a signal run and refuses anything but a completed one with well-formed metadata. */
export async function requireCompletedSignalRun(
  store: IncidentReadStore,
  signalRunId: string,
): Promise<SignalRunRow & { readonly status: 'completed'; readonly completedAt: string }> {
  const run = await store.getSignalRun(signalRunId);
  if (run === null) throw new ToolError('signal_run_not_found');
  if (run.status !== 'completed' || run.completedAt === null) {
    throw new ToolError('signal_run_not_completed');
  }
  requireGrammar('signalVersion', run.signalVersion, versionIdentifierSchema);
  requireGrammar('contractVersion', run.contractVersion, versionIdentifierSchema);
  requireGrammar('contractHash', run.contractHash, hex64Schema);
  requireGrammar('querySha256', run.querySha256, hex64Schema);
  requireGrammar('gatewayHost', run.gatewayHost, hostnameSchema);
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
    originProvenance: RECORDED_ORIGIN_PROVENANCE,
  };
}

export function incidentSummaryDto(row: IncidentSummaryRow): IncidentSummaryDto {
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
    headline: quoteEvidence(row.headline, HEADLINE_MAX_CHARACTERS),
    earliestReportedAt: row.earliestReportedAt,
    dataOrigin: row.dataOrigin,
  };
}

/** Lowercases a validated UUID so a mixed-case argument names the same row. */
export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}
