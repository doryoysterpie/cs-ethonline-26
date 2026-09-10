import {
  DRAFT_MARKDOWN_MAX_CHARACTERS,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import type { DraftPreviewer, PreviewIncident } from '../engines/draft.js';
import { ToolError } from '../safety/errors.js';
import { quoteEvidence } from '../safety/text.js';
import { RESULT_NOTICE } from '../schemas/common.js';
import type { DraftSectionArguments } from '../schemas/input.js';
import type { DraftSectionOutput } from '../schemas/output.js';
import type { IncidentReadStore } from '../store/read-store.js';
import { canonicalUuid, requireCompletedEvidenceRun, runProvenance } from './shared.js';

/**
 * `draft_section`: a deterministic preview of one section, assembled in
 * memory from one completed evidence run. Every headline, publisher and URL
 * is rendered as quoted evidence before the drafter sees it, so the only line
 * breaks in the preview are the drafter's own and no retrieved text can carry
 * a tag or a control character into it. Nothing is written anywhere.
 */
export async function draftSection(
  store: IncidentReadStore,
  previewer: DraftPreviewer,
  args: DraftSectionArguments,
): Promise<DraftSectionOutput> {
  const run = await requireCompletedEvidenceRun(store, canonicalUuid(args.evidenceRunId));
  const rows = await store.listDraftIncidents(run.id, args.maximumIncidents);
  const incidents: PreviewIncident[] = rows.map((row) => {
    const sources = row.sources.map((source) => ({
      sourceRowId: source.sourceRowId,
      publisher: quoteEvidence(source.publisher, PUBLISHER_MAX_CHARACTERS)?.text ?? 'unattributed',
      url: quoteEvidence(source.url, URL_MAX_CHARACTERS)?.text ?? '',
      publishedAt: source.postedAt,
    }));
    const titled = row.sources
      .map((source) => ({
        sourceRowId: source.sourceRowId,
        title: quoteEvidence(source.title, HEADLINE_MAX_CHARACTERS)?.text ?? '',
      }))
      .filter((source) => source.title.length > 0);
    return {
      incidentId: row.incidentId,
      clusteringRunId: row.clusteringRunId,
      batchId: row.batchId,
      evidenceRunId: run.id,
      dataOrigin: row.dataOrigin,
      evidenceState: row.state,
      onChainSubject: row.hasSubject,
      headline: titled[0]?.title ?? 'An incident with no recorded headline',
      sources,
      claims: titled.map((source) => ({
        claimId: source.sourceRowId,
        text: source.title,
        sourceRowId: source.sourceRowId,
      })),
    };
  });
  const preview = previewer.preview({
    section: args.section,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    dataOrigin: run.dataOrigin,
    incidents,
  });
  if (preview.markdown.length > DRAFT_MARKDOWN_MAX_CHARACTERS)
    throw new ToolError('result_too_large');
  return {
    notice: RESULT_NOTICE,
    tool: 'draft_section',
    run: runProvenance(run),
    section: args.section,
    period: { start: args.periodStart, end: args.periodEnd },
    preview: {
      markdown: preview.markdown,
      status: 'unpublished_requires_human_review',
      persisted: false,
      modelInvoked: false,
      draftingVersion: preview.draftingVersion,
      contractVersion: preview.contractVersion,
      contractHash: preview.contractHash,
      counts: preview.counts,
    },
    incidentsConsidered: incidents.length,
    incidentsLimit: args.maximumIncidents,
    dataOrigin: run.dataOrigin,
  };
}
