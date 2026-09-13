import { getEvidenceRun, listDraftIncidents, type Database } from '@cas/database';
import type { EvidenceState } from '@cas/contracts';
import type { DraftIncident, DraftRequest, GraphEvidenceState } from '@cas/drafting';

import { IngestionError } from '../editorial/errors.js';
import { newDraftId } from './generate.js';

/**
 * Assembling a draft request from one completed evidence run.
 *
 * What the assembler will and will not do is the whole point. It reads the
 * reported headline of each source row and offers it as the claim, with every
 * source that carried it. It does not extract a victim name, an attack type,
 * a date or a figure from that text, because extracting a fact is not the same
 * as repeating a report, and Sprint 5 implements no extraction.
 *
 * The consequence is deliberate and visible in the output: every claim is
 * `reported`, no claim proposes a name, and the naming policy therefore
 * withholds every name. A person editing the draft supplies the facts and the
 * names; the machine supplies the shape, the sources and the evidence state.
 */

const GRAPH_STATE: Readonly<Record<EvidenceState, GraphEvidenceState>> = {
  reported_only: 'absent',
  onchain_observed: 'observed',
  corroborated: 'corroborating',
  contradicted: 'contradictory',
};

export interface BuildDraftRequest {
  readonly evidenceRunId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly maximumIncidents?: number | undefined;
}

export async function buildDraftRequest(
  db: Database,
  request: BuildDraftRequest,
): Promise<DraftRequest> {
  const run = await db.withClient((client) => getEvidenceRun(client, request.evidenceRunId));
  if (run === null || run.status !== 'completed') {
    throw new IngestionError(
      'configuration',
      'evidence_run_not_completed',
      'no completed evidence run with that id',
    );
  }
  const rows = await db.withClient((client) =>
    listDraftIncidents(client, run.id, request.maximumIncidents ?? 500),
  );
  const incidents: DraftIncident[] = rows.map((row) => {
    const sources = row.sources.map((source) => ({
      sourceRowId: source.sourceRowId,
      publisher: source.publisher ?? 'unattributed',
      url: source.url ?? '',
      publishedAt: source.postedAt,
    }));
    const state = row.state as EvidenceState;
    const headline = row.sources[0]?.title ?? 'An incident with no recorded headline';
    return {
      incidentId: row.incidentId,
      clusteringRunId: row.clusteringRunId,
      batchId: row.batchId,
      evidenceRunId: run.id,
      dataOrigin: row.dataOrigin,
      evidenceState: state,
      graphEvidence: GRAPH_STATE[state] ?? 'absent',
      onChainSubject: row.hasSubject,
      headline,
      sources,
      claims: row.sources
        .filter((source) => source.title !== null && source.title.length > 0)
        .map((source) => ({
          claimId: source.sourceRowId,
          text: source.title ?? '',
          // Everything the assembler produces is a report of a report. A
          // stronger confidence is a human's judgement, not a query's.
          confidence: 'reported' as const,
          sourceRowIds: [source.sourceRowId],
          // No name is proposed, because no extraction exists to propose one.
          victimName: null,
          victimSupport: 'none' as const,
        })),
    };
  });
  return {
    draftId: newDraftId(),
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    dataOrigin: run.dataOrigin,
    incidents,
  };
}
