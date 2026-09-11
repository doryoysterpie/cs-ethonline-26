import {
  DRAFT_MARKDOWN_MAX_CHARACTERS,
  DRAFT_SOURCES_PER_INCIDENT_LIMIT,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import type { DraftPreviewer, PreviewIncident } from '../engines/draft.js';
import { ToolError } from '../safety/errors.js';
import { quoteBoundedEvidence, type QuotedEvidence } from '../safety/text.js';
import { RESULT_NOTICE } from '../schemas/common.js';
import type { DraftSectionArguments } from '../schemas/input.js';
import type { DraftSectionOutput } from '../schemas/output.js';
import type { BoundedText, IncidentReadStoreProvider } from '../store/read-store.js';
import {
  canonicalUuid,
  requireCompletedEvidenceRun,
  runProvenance,
  type ToolContext,
} from './shared.js';

/**
 * `draft_section`: a deterministic preview of one section, assembled in
 * memory from one completed evidence run. The draft query is bounded before
 * anything is fetched: at most `maximumIncidents` incidents, at most
 * `DRAFT_SOURCES_PER_INCIDENT_LIMIT` sources of each, and each text column as
 * a bounded prefix with its true size. What that bounding left out is reported
 * in `bounds`, so a preview cannot pass for the whole record. Every headline,
 * publisher and URL is redacted and rendered as quoted evidence before the
 * drafter sees it, so the only line breaks in the preview are the drafter's
 * own and no retrieved text can carry a tag, a control character or a
 * credential into it. The run and its draft data are read in one transaction,
 * under the call's abort signal. Nothing is written anywhere.
 */
export async function draftSection(
  provider: IncidentReadStoreProvider,
  previewer: DraftPreviewer,
  args: DraftSectionArguments,
  context: ToolContext,
): Promise<DraftSectionOutput> {
  const evidenceRunId = canonicalUuid(args.evidenceRunId);
  return provider.withReadTransaction(
    async (store) => {
      const run = await requireCompletedEvidenceRun(store, evidenceRunId);
      const rows = await store.listDraftIncidents(
        run.id,
        args.maximumIncidents,
        DRAFT_SOURCES_PER_INCIDENT_LIMIT,
      );

      const text = {
        fieldsTruncated: 0,
        storedCharacters: 0,
        storedBytes: 0,
        fetchedCharacters: 0,
      };
      const quote = (field: BoundedText | null, bound: number): QuotedEvidence | null => {
        if (field === null) return null;
        text.storedCharacters += field.characters;
        text.storedBytes += field.bytes;
        text.fetchedCharacters += [...field.fragment].length;
        const quoted = quoteBoundedEvidence(field, bound, context.redact);
        if (quoted !== null && quoted.truncated) text.fieldsTruncated += 1;
        return quoted;
      };

      let sourcesConsidered = 0;
      let sourcesOmitted = 0;
      let incidentsWithOmittedSources = 0;
      const incidents: PreviewIncident[] = rows.map((row) => {
        sourcesConsidered += row.sources.length;
        const omitted = Math.max(0, row.sourceTotal - row.sources.length);
        sourcesOmitted += omitted;
        if (omitted > 0) incidentsWithOmittedSources += 1;
        const sources = row.sources.map((source) => ({
          sourceRowId: source.sourceRowId,
          publisher: quote(source.publisher, PUBLISHER_MAX_CHARACTERS)?.text ?? 'unattributed',
          url: quote(source.url, URL_MAX_CHARACTERS)?.text ?? '',
          publishedAt: source.postedAt,
        }));
        const titled = row.sources
          .map((source) => ({
            sourceRowId: source.sourceRowId,
            title: quote(source.title, HEADLINE_MAX_CHARACTERS)?.text ?? '',
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
        bounds: {
          sourcesPerIncidentLimit: DRAFT_SOURCES_PER_INCIDENT_LIMIT,
          sourcesConsidered,
          sourcesOmitted,
          incidentsWithOmittedSources,
          text,
        },
        dataOrigin: run.dataOrigin,
      };
    },
    { signal: context.signal },
  );
}
