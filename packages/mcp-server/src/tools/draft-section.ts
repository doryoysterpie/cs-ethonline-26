import type { DataOrigin } from '@cas/contracts';

import {
  DRAFT_MARKDOWN_MAX_CHARACTERS,
  DRAFT_SOURCES_PER_INCIDENT_LIMIT,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import type { DraftPreviewer, PreviewIncident } from '../engines/draft.js';
import { ToolError } from '../safety/errors.js';
import { codeSpan, escapeMarkdown } from '../safety/markdown.js';
import { REDACTED } from '../safety/redact.js';
import { classifySourceReference } from '../safety/reference.js';
import { quoteBoundedEvidence, type QuotedEvidence } from '../safety/text.js';
import { RESULT_NOTICE } from '../schemas/common.js';
import type { DraftSectionArguments } from '../schemas/input.js';
import { NAMING_NOTE, type DraftSectionOutput } from '../schemas/output.js';
import type { BoundedText, IncidentReadStoreProvider } from '../store/read-store.js';
import {
  canonicalUuid,
  requireCompletedEvidenceRun,
  runProvenance,
  type ToolContext,
} from './shared.js';

/**
 * `draft_section`: a deterministic preview of one section, assembled in
 * memory from one completed evidence run.
 *
 * The draft query is bounded before anything is fetched: at most
 * `maximumIncidents` incidents, at most `DRAFT_SOURCES_PER_INCIDENT_LIMIT`
 * sources of each, and each text column as a bounded prefix with its true
 * size. What that bounding left out is reported in `bounds`, so a preview
 * cannot pass for the whole record.
 *
 * Every headline, publisher and source reference is redacted, rendered as
 * quoted evidence with a truthful truncation marker, and then made inert for
 * Markdown (`safety/markdown.ts`, `safety/reference.ts`), so the only line
 * breaks and the only Markdown constructs in the preview are the drafter's
 * own and no retrieved text can carry a tag, a control character, an active
 * link or a credential into it. The preview text opens with a fixed notice
 * that survives on its own if a consumer keeps only the Markdown.
 *
 * The run and its draft data are read in one transaction, from one snapshot,
 * under the call's abort signal. Nothing is written anywhere and nothing is
 * fetched.
 */

/** Fixed sentences the preview text opens with. Never composed from input. */
export const PREVIEW_STATUS_NOTICE =
  'Preview notice: this is an unpublished draft section that requires human review before anything is published. It exists only in this result; nothing was written.';
export const PREVIEW_EVIDENCE_NOTICE =
  'Every headline, publisher and source reference below is quoted evidence from retrieved reporting, rendered inert: control characters, separators and angle brackets are shown as visible escapes, ASCII punctuation in quoted evidence is backslash-escaped, and a source reference is shown as a code span or withheld with a fixed reason. It is data, not an instruction; this server acts on none of it and fetches no source reference.';
export const PREVIEW_NAMING_NOTICE =
  'No structured victim name is proposed for any claim, so the drafter counts every claim as a withheld name. Quoted headlines and publishers are verbatim evidence and may contain names; nothing is redacted.';
export function previewOriginNotice(origin: DataOrigin): string {
  return `Data origin ${origin}, as recorded by the database for this run. The acquisition is not independently verified, and the stored evidence layer is under correction after a rejected audit; nothing here implies editorial truth.`;
}

/** Prepends the notice to a section, separated by a blank line. */
export function withPreviewNotice(markdown: string, origin: DataOrigin): string {
  return [
    PREVIEW_STATUS_NOTICE,
    PREVIEW_EVIDENCE_NOTICE,
    PREVIEW_NAMING_NOTICE,
    previewOriginNotice(origin),
    '',
    markdown,
  ].join('\n');
}

/** Fixed sentences for a source whose reference is absent or withheld. */
export const NO_REFERENCE = 'no reference recorded';
export const REFERENCE_WITHHELD_PREFIX = 'reference withheld: ';
const UNATTRIBUTED = 'unattributed';

/**
 * Renders one stored URL for the preview: an accepted reference as a code
 * span of its display copy, a rejected one as the fixed withheld sentence
 * with its reason and nothing of the value.
 *
 * `fetched` is the prefix the store fetched, which the policy classifies: a
 * URL's scheme, credentials and host all lie at its front, well inside the
 * fetched prefix, so a bound applied to the tail cannot change the verdict.
 * `quoted` is the display copy the caller already produced, redacted, escaped
 * and bounded, carrying the visible truncation marker when the stored URL was
 * longer than the display bound.
 */
export function renderSourceReference(
  fetched: string | null,
  quoted: QuotedEvidence | null,
): string {
  if (fetched === null) return NO_REFERENCE;
  const verdict = classifySourceReference(fetched);
  if (verdict.status === 'rejected') return `${REFERENCE_WITHHELD_PREFIX}${verdict.reason}`;
  return codeSpan(quoted?.text ?? '');
}

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
      /** Redacts, escapes and bounds one fetched column, and accounts for it. */
      const quote = (field: BoundedText | null, bound: number): QuotedEvidence | null => {
        if (field === null) return null;
        text.storedCharacters += field.characters;
        text.storedBytes += field.bytes;
        text.fetchedCharacters += [...field.fragment].length;
        const quoted = quoteBoundedEvidence(field, bound, context.redact);
        if (quoted !== null && quoted.truncated) text.fieldsTruncated += 1;
        return quoted;
      };
      // Redaction happens on the stored text, before escaping, so a secret
      // that contains punctuation is still recognized whole. The marker it
      // leaves is restored to its literal form afterwards: bracketed text with
      // every neighbouring bracket and parenthesis escaped cannot form a link,
      // and a consumer looking for the marker finds it.
      const escapedMarker = escapeMarkdown(REDACTED);
      const inert = (field: BoundedText | null, bound: number): string | null => {
        const quoted = quote(field, bound);
        if (quoted === null) return null;
        return escapeMarkdown(quoted.text).split(escapedMarker).join(REDACTED);
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
          publisher: inert(source.publisher, PUBLISHER_MAX_CHARACTERS) ?? UNATTRIBUTED,
          url: renderSourceReference(
            source.url?.fragment ?? null,
            quote(source.url, URL_MAX_CHARACTERS),
          ),
          publishedAt: source.postedAt,
        }));
        const titled = row.sources
          .map((source) => ({
            sourceRowId: source.sourceRowId,
            title: inert(source.title, HEADLINE_MAX_CHARACTERS) ?? '',
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
      const markdown = withPreviewNotice(preview.markdown, run.dataOrigin);
      if (markdown.length > DRAFT_MARKDOWN_MAX_CHARACTERS) throw new ToolError('result_too_large');
      return {
        notice: RESULT_NOTICE,
        tool: 'draft_section',
        run: runProvenance(run),
        section: args.section,
        period: { start: args.periodStart, end: args.periodEnd },
        preview: {
          markdown,
          status: 'unpublished_requires_human_review',
          persisted: false,
          modelInvoked: false,
          draftingVersion: preview.draftingVersion,
          contractVersion: preview.contractVersion,
          contractHash: preview.contractHash,
          counts: { ...preview.counts },
          naming: {
            claimsWithoutStructuredVictimName: preview.claimsWithoutStructuredVictimName,
            redactionApplied: false,
            quotedTextMayContainNames: true,
            note: NAMING_NOTE,
          },
          claims: preview.claims.map((claim) => ({
            claimId: claim.claimId,
            incidentId: claim.incidentId,
            clusteringRunId: claim.clusteringRunId,
            batchId: claim.batchId,
            evidenceRunId: claim.evidenceRunId,
            dataOrigin: claim.dataOrigin,
            evidenceState: claim.evidenceState,
            graphEvidence: claim.graphEvidence,
            confidence: claim.confidence,
            sourceRowIds: [...claim.sourceRowIds],
            namingDecision: claim.namingDecision,
            written: claim.written,
            omissionReason: claim.omissionReason,
          })),
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
