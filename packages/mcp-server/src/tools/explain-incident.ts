import {
  EXPLAIN_ASSOCIATIONS_LIMIT,
  EXPLAIN_SOURCES_LIMIT,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import { ToolError } from '../safety/errors.js';
import { quoteBoundedEvidence } from '../safety/text.js';
import { RESULT_NOTICE, TELEMETRY_SENTENCE } from '../schemas/common.js';
import type { ExplainIncidentArguments } from '../schemas/input.js';
import type { ExplainIncidentOutput } from '../schemas/output.js';
import type { IncidentReadStoreProvider } from '../store/read-store.js';
import {
  canonicalUuid,
  incidentSummaryDto,
  requireCompletedEvidenceRun,
  runProvenance,
  type ToolContext,
} from './shared.js';

/**
 * `explain_incident`: one incident of one completed evidence run, with the
 * bounded source list behind it and every machine suggestion beside the
 * latest human decision on it. The machine's proposal and the person's answer
 * are separate fields, so neither can be mistaken for the other. The run, the
 * incident, its sources and its associations are read in one transaction,
 * from one snapshot: a decision recorded while this call is in flight is
 * seen by the next call, never half by this one.
 */
export async function explainIncident(
  provider: IncidentReadStoreProvider,
  args: ExplainIncidentArguments,
  context: ToolContext,
): Promise<ExplainIncidentOutput> {
  const evidenceRunId = canonicalUuid(args.evidenceRunId);
  const incidentId = canonicalUuid(args.incidentId);
  return provider.withReadTransaction(
    async (store) => {
      const run = await requireCompletedEvidenceRun(store, evidenceRunId);
      const summary = await store.getIncidentSummary(run.id, incidentId);
      if (summary === null) throw new ToolError('incident_not_found');
      const sources = await store.listIncidentSources(
        run.clusteringRunId,
        incidentId,
        EXPLAIN_SOURCES_LIMIT,
      );
      const associations = await store.listIncidentAssociations(
        run.id,
        incidentId,
        EXPLAIN_ASSOCIATIONS_LIMIT,
      );
      return {
        notice: RESULT_NOTICE,
        tool: 'explain_incident',
        run: runProvenance(run),
        incident: incidentSummaryDto(summary, context.redact),
        sources: sources.map((source) => ({
          sourceRowId: source.sourceRowId,
          title: quoteBoundedEvidence(source.title, HEADLINE_MAX_CHARACTERS, context.redact),
          publisher: quoteBoundedEvidence(
            source.publisher,
            PUBLISHER_MAX_CHARACTERS,
            context.redact,
          ),
          url: quoteBoundedEvidence(source.url, URL_MAX_CHARACTERS, context.redact),
          postedAt: source.postedAt,
          classificationDecision: source.decision,
        })),
        associations: associations.map((association) => ({
          associationId: association.associationId,
          signalId: association.signalId,
          chain: association.chain,
          protocolSlug: association.protocolSlug,
          signalObservedAt: association.signalObservedAt,
          signalDeltaPercent: association.signalDeltaPercent,
          signalDataOrigin: association.signalDataOrigin,
          offsetSeconds: association.offsetSeconds,
          machineSuggestion: {
            relation: association.suggestedRelation,
            status: 'suggested',
            claimId: association.suggestedClaimId,
          },
          effective: {
            relation: association.decidedRelation ?? association.suggestedRelation,
            status: association.decidedStatus ?? 'suggested',
            claimId:
              association.decidedStatus === null
                ? association.suggestedClaimId
                : association.decidedClaimId,
            decidedByHuman: association.decidedStatus !== null,
          },
          reasonCodes: [...association.reasonCodes],
        })),
        bounds: {
          sourcesReturned: sources.length,
          sourcesLimit: EXPLAIN_SOURCES_LIMIT,
          associationsReturned: associations.length,
          associationsLimit: EXPLAIN_ASSOCIATIONS_LIMIT,
        },
        telemetrySentence: TELEMETRY_SENTENCE,
      };
    },
    { signal: context.signal },
  );
}
