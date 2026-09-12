import type {
  AnomalyLabel,
  AnomalySignalType,
  ChainId,
  DataOrigin,
  ReviewState,
} from '@cas/contracts';

import type { Capability, Role } from '../auth/roles.ts';

/**
 * Data-transfer objects: the explicit, minimal shapes a page receives.
 *
 * Nothing here is a database record, a store record or a worker record. Every
 * field is named because a view needs it, every string that came from a
 * source row is marked as such, and no DTO carries a password hash, a session
 * token, a raw cell, a driver message or a stack. Text fields are `null`
 * rather than absent when the principal may not see them, so a template that
 * forgets to check renders nothing rather than something.
 */

export interface PrincipalDto {
  readonly username: string;
  readonly role: Role;
  readonly capabilities: readonly Capability[];
}

export interface RunReference {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface CommandCenterDto {
  readonly totals: {
    readonly importBatches: number;
    readonly classificationRuns: number;
    readonly clusteringRuns: number;
    readonly graphSignalRuns: number;
    readonly evidenceRuns: number;
  };
  readonly clusteringRuns: readonly (RunReference & {
    readonly incidentCount: number;
    readonly multiSourceIncidentCount: number;
    readonly ambiguousLinkCount: number;
    readonly classificationRunId: string;
  })[];
  readonly evidenceRuns: readonly (RunReference & {
    readonly clusteringRunId: string;
    readonly signalRunId: string;
    readonly incidentCount: number;
    readonly suggestionCount: number;
    readonly reportedOnly: number;
    readonly onchainObserved: number;
    readonly corroborated: number;
    readonly contradicted: number;
  })[];
  readonly signalRuns: readonly (RunReference & {
    readonly gatewayHost: string;
    readonly targetCount: number;
    readonly signalCount: number;
    readonly failedTargetCount: number;
  })[];
  readonly classificationRuns: readonly (RunReference & {
    readonly batchId: string;
    readonly reviewCount: number;
    readonly includeCount: number;
    readonly excludeCount: number;
  })[];
}

export interface IncidentSummaryDto {
  readonly id: string;
  readonly kind: string;
  readonly memberCount: number;
  readonly reasonCodes: readonly string[];
  readonly subjectChain: ChainId | null;
  readonly subjectProtocolSlug: string | null;
  readonly dataOrigin: DataOrigin;
}

export interface IncidentExplorerDto {
  readonly run: RunReference & { readonly incidentCount: number; readonly batchId: string };
  readonly reviewRevision: number;
  readonly reviewActions: number;
  readonly effectiveIncidents: number;
  readonly incidents: readonly IncidentSummaryDto[];
  readonly nextAfterId: string | null;
}

export interface IncidentMemberDto {
  readonly membershipId: string;
  readonly sourceRowId: string;
  readonly rowNumber: number;
  readonly decision: string;
  readonly postedAt: string | null;
  readonly dataOrigin: DataOrigin;
  /** Source text; null unless the principal may view source text. Rendered through `safeText`. */
  readonly title: string | null;
  readonly publisher: string | null;
  readonly url: string | null;
}

export interface IncidentDetailDto {
  readonly run: RunReference & { readonly batchId: string };
  readonly incident: IncidentSummaryDto;
  readonly members: readonly IncidentMemberDto[];
  readonly reviewRevision: number;
  readonly isEffective: boolean;
  readonly canReview: boolean;
}

export interface QueueEntryDto {
  readonly sourceRowId: string;
  readonly rowNumber: number;
  readonly dataOrigin: DataOrigin;
  readonly rationaleCodes: readonly string[];
  readonly signalScore: number;
  readonly postedAt: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly url: string | null;
  /** The latest human decision recorded in this dashboard for the row, if any. */
  readonly decision: {
    readonly reviewState: ReviewState;
    readonly reasonCode: string;
    readonly note: string | null;
    readonly decidedBy: string;
    readonly decidedAt: string;
  } | null;
}

export interface ReviewQueueDto {
  readonly run: RunReference & { readonly batchId: string; readonly reviewCount: number };
  readonly entries: readonly QueueEntryDto[];
  readonly nextAfterRowNumber: number | null;
}

export interface EvidenceStateDto {
  readonly incidentId: string;
  readonly state: string;
  readonly reasonCode: string;
  readonly claimId: string | null;
  readonly acceptedAssociationCount: number;
  readonly hasSubject: boolean;
}

export interface AssociationDto {
  readonly associationId: string;
  readonly incidentId: string;
  readonly signalId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly observedAt: string;
  readonly deltaPercent: string;
  readonly offsetSeconds: number;
  readonly reasonCodes: readonly string[];
  readonly suggestedRelation: string;
  readonly effectiveRelation: string;
  readonly effectiveStatus: string;
  readonly effectiveClaimId: string | null;
}

export interface EvidenceDecisionDto {
  readonly associationId: string;
  readonly operation: 'accept' | 'reject';
  readonly relation: string;
  readonly reasonCode: string;
  /** Private editorial rationale; null unless the principal may view notes. */
  readonly rationale: string | null;
  readonly actor: string;
  readonly resultingRevision: number;
  readonly createdAt: string;
}

export interface EvidenceViewDto {
  readonly run: RunReference & {
    readonly clusteringRunId: string;
    readonly signalRunId: string;
    readonly counts: {
      readonly incidents: number;
      readonly suggestions: number;
      readonly reportedOnly: number;
      readonly onchainObserved: number;
      readonly corroborated: number;
      readonly contradicted: number;
    };
  };
  readonly states: readonly EvidenceStateDto[];
  readonly associations: readonly AssociationDto[];
  readonly decisions: readonly EvidenceDecisionDto[];
  readonly revision: number;
  readonly canReview: boolean;
  /** Fixed sentences the view must keep visible beside the data. */
  readonly limitations: readonly string[];
}

export interface AnomalyEntryDto {
  readonly signalType: AnomalySignalType;
  readonly label: AnomalyLabel;
  readonly subjectId: string;
  readonly chain: ChainId | null;
  readonly protocolSlug: string | null;
  readonly observationWindow: { readonly startsAt: number; readonly endsAt: number };
  readonly baselineWindow: { readonly startsAt: number; readonly endsAt: number } | null;
  readonly value: string;
  readonly threshold: string;
  readonly dataOrigin: DataOrigin;
  readonly provenanceId: string;
  readonly reasonCodes: readonly string[];
  readonly evidenceLimitation: string;
}

export interface AnomalyViewDto {
  readonly run: RunReference & { readonly gatewayHost: string; readonly signalCount: number };
  readonly asOf: string;
  readonly entries: readonly AnomalyEntryDto[];
  readonly stats: {
    readonly chainTargets: number;
    readonly reportingWindows: number;
    readonly spikes: number;
    readonly insufficientHistory: number;
    readonly stale: number;
    readonly missing: number;
    readonly boundsReached: number;
  };
}

export interface DraftViewDto {
  readonly draftKey: string;
  readonly evidenceRun: RunReference;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: string;
  /** The Markdown shown: the latest human revision, or the generated draft when none exists. */
  readonly markdown: string;
  readonly revision: number;
  readonly generatedMarkdown: string;
  readonly counts: {
    readonly incidents: number;
    readonly claimsWritten: number;
    readonly claimsOmitted: number;
    readonly namesWithheld: number;
    readonly contradicted: number;
    readonly cryptoIncidents: number;
  };
  readonly revisions: readonly {
    readonly revision: number;
    readonly savedBy: string;
    readonly savedAt: string;
  }[];
  readonly canEdit: boolean;
}

export interface AccountDto {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly passwordChangedAt: string;
  readonly disabledAt: string | null;
  readonly expiresAt: string | null;
  readonly liveSessions: number;
}

export interface AuditEventDto {
  readonly at: string;
  readonly kind: string;
  readonly outcome: 'success' | 'failure';
  readonly code: string;
  readonly actor: string | null;
  readonly subject: string | null;
  readonly networkKey: string | null;
}

export interface AdministrationDto {
  readonly accounts: readonly AccountDto[];
  readonly audit: readonly AuditEventDto[];
}
