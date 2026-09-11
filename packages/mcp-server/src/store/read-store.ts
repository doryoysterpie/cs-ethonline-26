import type { AssociationRelation, ChainId, DataOrigin, EvidenceState } from '@cas/contracts';

import type { PrivilegeReport } from './privileges.js';

/**
 * The only read operations the tools need, as two interfaces.
 *
 * `IncidentReadStoreProvider` opens one read transaction per tool call and
 * hands the call an `IncidentReadStore` bound to that transaction's
 * connection, so every constituent read of one call (run metadata, incidents,
 * sources, associations, review state, targets, signal history, draft data)
 * comes from one snapshot. It takes the call's one abort signal, owned by the
 * runtime (Track D finding F1): once the signal aborts no further statement
 * is sent, and a statement in flight is cancelled at the server, so the
 * runtime that owns cancellation needs no second deadline of its own.
 *
 * The PostgreSQL implementation runs the transaction `REPEATABLE READ` and
 * `READ ONLY` with a statement timeout, verifies the role's privileges before
 * any application read in production mode, and destroys the connection when
 * the call ends. The tests substitute an in-memory store. Nothing here can
 * write, and nothing here returns a raw cell, a derived body text, a review
 * note, a rationale, an actor or a credential: the row types below are the
 * whole surface.
 */

/**
 * A text column as the store fetches it: a bounded prefix and the stored
 * value's true size. The prefix is at most the display bound plus the
 * sentinel margin, so a 48,000-character cell never crosses the wire, and the
 * true size lets the display layer say, truthfully, that it was cut.
 */
export interface BoundedText {
  /** The first characters of the stored value. */
  readonly fragment: string;
  /** Characters (code points) of the whole stored value, as PostgreSQL counts them. */
  readonly characters: number;
  /** Bytes of the whole stored value in UTF-8. */
  readonly bytes: number;
}

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
  readonly headline: BoundedText | null;
  readonly earliestReportedAt: string | null;
  readonly dataOrigin: DataOrigin;
}

export interface IncidentSourceRow {
  readonly sourceRowId: string;
  readonly title: BoundedText | null;
  readonly publisher: BoundedText | null;
  readonly url: BoundedText | null;
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

/**
 * The evaluation boundary of one stored anomaly request. It is fixed by the
 * named completed run and the caller's as-of instant, never by the clock or
 * by whatever has been stored since:
 *
 *   - only completed runs of the same origin and signal version count
 *     (a running run has no completion instant and is never read; the schema
 *     has no failed state, so there is nothing else to exclude);
 *   - only runs completed at or before the named run's completion count, so a
 *     later run cannot change the named run's result;
 *   - only observations at or before `asOf` count, and that cut is applied
 *     before any limit, so the most recent rows of a series can never crowd
 *     out the rows that were current at the as-of instant.
 */
export interface SignalRunBoundary {
  readonly signalRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly signalVersion: string;
  /** Completion instant of the named run. */
  readonly completedAt: string;
  /** The caller's as-of instant, ISO 8601 UTC. */
  readonly asOf: string;
}

export interface SignalTargetRow {
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly dataOrigin: DataOrigin;
}

/** One observation with the run and signal that actually produced it. */
export interface SignalObservationRow {
  readonly observedAt: string;
  readonly deltaPercent: string;
  readonly signalRunId: string;
  readonly signalId: string;
  /** Completion instant of the run the observation belongs to. */
  readonly runCompletedAt: string;
}

export interface DraftSourceRow {
  readonly sourceRowId: string;
  readonly title: BoundedText | null;
  readonly publisher: BoundedText | null;
  readonly url: BoundedText | null;
  readonly postedAt: string | null;
}

export interface DraftIncidentRow {
  readonly incidentId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly state: EvidenceState;
  readonly hasSubject: boolean;
  /** Source rows the incident actually has, whether or not they were fetched. */
  readonly sourceTotal: number;
  /** The first `sourcesPerIncidentLimit` sources in source-row order. */
  readonly sources: readonly DraftSourceRow[];
}

export interface ReadTransactionOptions {
  /**
   * The call's abort signal. Once aborted, no further statement is sent and a
   * statement in flight is cancelled at the server; the transaction unwinds
   * and its connection is destroyed before the call reports.
   */
  readonly signal?: AbortSignal | undefined;
}

/** The read surface of one transaction. Every method reads the same snapshot. */
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
  /** Distinct targets observed by completed runs inside the boundary, in a fixed order. */
  listSignalTargets(boundary: SignalRunBoundary, limit: number): Promise<SignalTargetRow[]>;
  /** The most recent `limit` observations of one target inside the boundary, oldest first. */
  listSignalHistory(
    boundary: SignalRunBoundary,
    chain: ChainId,
    protocolSlug: string,
    limit: number,
  ): Promise<SignalObservationRow[]>;
  listDraftIncidents(
    evidenceRunId: string,
    incidentLimit: number,
    sourcesPerIncidentLimit: number,
  ): Promise<DraftIncidentRow[]>;
}

/** Opens one read transaction per tool call. */
export interface IncidentReadStoreProvider {
  withReadTransaction<T>(
    fn: (store: IncidentReadStore) => Promise<T>,
    options?: ReadTransactionOptions,
  ): Promise<T>;
  /** The privilege matrix of the configured credential, on a connection of its own. */
  verifyPrivileges(options?: ReadTransactionOptions): Promise<PrivilegeReport>;
  close(): Promise<void>;
}
