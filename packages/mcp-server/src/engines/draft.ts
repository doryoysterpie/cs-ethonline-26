import type { DataOrigin, EvidenceState } from '@cas/contracts';
import {
  CLAIM_CONFIDENCES,
  DRAFTING_CONTRACT,
  GRAPH_EVIDENCE_STATES,
  generateDraft,
  type ClaimProvenance,
  type DraftIncident,
  type DraftSection,
  type IncidentAssessment,
} from '@cas/drafting';

import { DRAFT_INCIDENTS_MAX_LIMIT } from '../bounds.js';

/**
 * The draft previewer, behind an interface.
 *
 * `@cas/drafting` is Sprint 5 work under correction. This adapter is the only
 * file that imports it, and it calls exactly one pure function: assemble a
 * draft in memory. Nothing here writes a file, reads a file, calls a model or
 * touches an existing draft; the Sprint 5 writer with its output directory is
 * never imported, so the path-handling findings of that audit have no reach
 * into this server. The drafter's vocabularies are re-exported from here so
 * the output contract can name them without importing the package itself.
 */

export { CLAIM_CONFIDENCES, GRAPH_EVIDENCE_STATES };

/** Most sidecar records one preview can carry: every incident times the drafter's claims-per-incident bound. */
export const PREVIEW_CLAIM_RECORDS_LIMIT =
  DRAFT_INCIDENTS_MAX_LIMIT * DRAFTING_CONTRACT.bounds.maximumClaimsPerIncident;

export interface PreviewSource {
  readonly sourceRowId: string;
  /** Already rendered as inert Markdown by the caller. */
  readonly publisher: string;
  /** Already rendered by the caller: a code span, or a fixed withheld sentence. */
  readonly url: string;
  readonly publishedAt: string | null;
}

export interface PreviewIncident {
  readonly incidentId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly evidenceRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly evidenceState: EvidenceState;
  readonly onChainSubject: boolean;
  /** Already rendered as inert Markdown quoted evidence by the caller. */
  readonly headline: string;
  readonly sources: readonly PreviewSource[];
  /** One claim per source that carried a title: the reported headline, rendered inert. */
  readonly claims: readonly {
    readonly claimId: string;
    readonly text: string;
    readonly sourceRowId: string;
  }[];
}

export interface PreviewRequest {
  readonly section: DraftSection;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly dataOrigin: DataOrigin;
  readonly incidents: readonly PreviewIncident[];
}

/** One sidecar record per claim, exactly as the drafter records it. Carries no evidence state. */
export type PreviewClaimRecord = ClaimProvenance;

/** One incident's evidence assessment, exactly as the drafter records it. Never per claim. */
export type PreviewIncidentAssessment = IncidentAssessment;

export interface PreviewResult {
  readonly markdown: string;
  readonly draftingVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly counts: {
    readonly incidents: number;
    readonly claimsWritten: number;
    readonly claimsOmitted: number;
    readonly contradicted: number;
    readonly cryptoIncidents: number;
  };
  /**
   * The drafter's "names withheld" count, named for what it is: every claim
   * is handed to the drafter with no structured victim name, so the drafter
   * records every claim as withheld. Nothing is redacted from quoted text.
   */
  readonly claimsWithoutStructuredVictimName: number;
  /** The drafter's per-claim provenance sidecar for the whole draft. */
  readonly claims: readonly PreviewClaimRecord[];
  /** The drafter's per-incident evidence assessment for the whole draft, one row per incident. */
  readonly incidentAssessments: readonly PreviewIncidentAssessment[];
}

export interface DraftPreviewer {
  preview(request: PreviewRequest): PreviewResult;
}

const GRAPH_STATE = {
  reported_only: 'absent',
  onchain_observed: 'observed',
  corroborated: 'corroborating',
  contradicted: 'contradictory',
} as const;

/** The shipped previewer: the Sprint 5 deterministic drafter, unchanged. */
export const deterministicPreviewer: DraftPreviewer = Object.freeze({
  preview(request: PreviewRequest): PreviewResult {
    const incidents: DraftIncident[] = request.incidents.map((incident) => ({
      incidentId: incident.incidentId,
      clusteringRunId: incident.clusteringRunId,
      batchId: incident.batchId,
      evidenceRunId: incident.evidenceRunId,
      dataOrigin: incident.dataOrigin,
      evidenceState: incident.evidenceState,
      graphEvidence: GRAPH_STATE[incident.evidenceState],
      onChainSubject: incident.onChainSubject,
      headline: incident.headline,
      sources: incident.sources.map((source) => ({
        sourceRowId: source.sourceRowId,
        publisher: source.publisher,
        url: source.url,
        publishedAt: source.publishedAt,
      })),
      claims: incident.claims.map((claim) => ({
        claimId: claim.claimId,
        text: claim.text,
        // Everything here is a report of a report; a stronger confidence is a
        // human's judgement. No structured victim name is proposed, so the
        // drafter records every claim as name-withheld; the quoted text is
        // untouched and may still contain a name.
        confidence: 'reported' as const,
        sourceRowIds: [claim.sourceRowId],
        victimName: null,
        victimSupport: 'none' as const,
      })),
    }));
    const draft = generateDraft({
      draftId: 'preview',
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      dataOrigin: request.dataOrigin,
      incidents,
    });
    const { namesWithheld, ...counts } = draft.provenance.counts;
    return {
      markdown: draft.sections[request.section],
      draftingVersion: draft.provenance.draftingVersion,
      contractVersion: draft.provenance.contractVersion,
      contractHash: draft.provenance.contractHash,
      counts: { ...counts },
      claimsWithoutStructuredVictimName: namesWithheld,
      claims: draft.provenance.claims.map((claim) => ({
        ...claim,
        sourceRowIds: [...claim.sourceRowIds],
      })),
      incidentAssessments: draft.provenance.incidentAssessments.map((assessment) => ({
        ...assessment,
      })),
    };
  },
});
