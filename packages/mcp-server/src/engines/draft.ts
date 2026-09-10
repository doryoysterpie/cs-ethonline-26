import type { DataOrigin, EvidenceState } from '@cas/contracts';
import { generateDraft, type DraftIncident, type DraftSection } from '@cas/drafting';

/**
 * The draft previewer, behind an interface.
 *
 * `@cas/drafting` is Sprint 5 work under correction. This adapter is the only
 * file that imports it, and it calls exactly one pure function: assemble a
 * draft in memory. Nothing here writes a file, reads a file, calls a model or
 * touches an existing draft; the Sprint 5 writer with its output directory is
 * never imported, so the path-handling findings of that audit have no reach
 * into this server.
 */

export interface PreviewSource {
  readonly sourceRowId: string;
  readonly publisher: string;
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
  /** Already rendered as quoted evidence by the caller. */
  readonly headline: string;
  readonly sources: readonly PreviewSource[];
  /** One claim per source that carried a title: the reported headline, verbatim. */
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

export interface PreviewResult {
  readonly markdown: string;
  readonly draftingVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly counts: {
    readonly incidents: number;
    readonly claimsWritten: number;
    readonly claimsOmitted: number;
    readonly namesWithheld: number;
    readonly contradicted: number;
    readonly cryptoIncidents: number;
  };
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
        // human's judgement. No name is proposed, so every name is withheld.
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
    return {
      markdown: draft.sections[request.section],
      draftingVersion: draft.provenance.draftingVersion,
      contractVersion: draft.provenance.contractVersion,
      contractHash: draft.provenance.contractHash,
      counts: { ...draft.provenance.counts },
    };
  },
});
