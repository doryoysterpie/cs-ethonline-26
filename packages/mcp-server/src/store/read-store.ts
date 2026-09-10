import type { AssociationRelation, ChainId, DataOrigin, EvidenceState } from '@cas/contracts';

/**
 * The only read operations the tools need, as an interface.
 *
 * The PostgreSQL implementation runs every method inside a `READ ONLY`
 * transaction with a statement timeout, and the tests substitute an in-memory
 * store. Nothing here can write, and nothing here returns a raw cell, a
 * derived body text, a review note, a rationale, an actor or a credential:
 * the row types below are the whole surface.
 */

export interface EvidenceRunRow {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly signalRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly resolverVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly incidentCount: number;
  readonly reportedOnlyCount: number;
  readonly onchainObservedCount: number;
  readonly corroboratedCount: number;
  readonly contradictedCount: number;
  readonly completedAt: string | null;
}

export interface IncidentSummaryRow {
  readonly incidentId: string;
  readonly kind: string;
  readonly memberCount: number;
  readonly sourceCount: number;
  readonly reasonCodes: readonly string[];
  readonly state: EvidenceState;
  readonly stateReasonCode: string;
  readonly claimId: string | null;
  readonly acceptedAssociationCount: number;
  readonly subjectChain: ChainId | null;
  readonly subjectProtocolSlug: string | null;
  /** Normalized title of the representative source row, bounded by the query. */
  readonly headline: string | null;
  readonly earliestReportedAt: string | null;
  readonly dataOrigin: DataOrigin;
}

export interface IncidentSourceRow {
  readonly sourceRowId: string;
  readonly title: string | null;
  readonly publisher: string | null;
  readonly url: string | null;
  readonly postedAt: string | null;
  readonly decision: 'include' | 'review';
}

export interface IncidentAssociationRow {
  readonly associationId: string;
  readonly signalId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly signalObservedAt: string;
  readonly signalDeltaPercent: string;
  readonly signalDataOrigin: DataOrigin;
  readonly offsetSeconds: number;
  readonly suggestedRelation: AssociationRelation;
  readonly suggestedClaimId: string | null;
  readonly decidedStatus: 'accepted' | 'rejected' | null;
  readonly decidedRelation: AssociationRelation | null;
  readonly decidedClaimId: string | null;
  readonly reasonCodes: readonly string[];
}

export interface SignalRunRow {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly signalVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly querySha256: string;
  readonly gatewayHost: string;
  readonly targetCount: number;
  readonly signalCount: number;
  readonly failedTargetCount: number;
  readonly completedAt: string | null;
}

export interface SignalTargetRow {
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly dataOrigin: DataOrigin;
}

export interface SignalObservationRow {
  readonly observedAt: string;
  readonly deltaPercent: string;
}

export interface DraftIncidentRow {
  readonly incidentId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly state: EvidenceState;
  readonly hasSubject: boolean;
  readonly sources: readonly {
    readonly sourceRowId: string;
    readonly title: string | null;
    readonly publisher: string | null;
    readonly url: string | null;
    readonly postedAt: string | null;
  }[];
}

export interface IncidentReadStore {
  getEvidenceRun(evidenceRunId: string): Promise<EvidenceRunRow | null>;
  listIncidentSummaries(
    evidenceRunId: string,
    afterIncidentId: string | null,
    limit: number,
  ): Promise<IncidentSummaryRow[]>;
  getIncidentSummary(evidenceRunId: string, incidentId: string): Promise<IncidentSummaryRow | null>;
  listIncidentSources(
    clusteringRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentSourceRow[]>;
  listIncidentAssociations(
    evidenceRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentAssociationRow[]>;
  getSignalRun(signalRunId: string): Promise<SignalRunRow | null>;
  listSignalTargets(signalRunId: string, limit: number): Promise<SignalTargetRow[]>;
  listSignalHistory(
    chain: ChainId,
    protocolSlug: string,
    dataOrigin: DataOrigin,
    limit: number,
  ): Promise<SignalObservationRow[]>;
  listDraftIncidents(evidenceRunId: string, limit: number): Promise<DraftIncidentRow[]>;
  close(): Promise<void>;
}
