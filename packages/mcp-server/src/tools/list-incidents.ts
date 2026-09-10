import { RESULT_NOTICE } from '../schemas/common.js';
import type { ListIncidentsArguments } from '../schemas/input.js';
import type { ListIncidentsOutput } from '../schemas/output.js';
import type { IncidentReadStore } from '../store/read-store.js';
import {
  canonicalUuid,
  incidentSummaryDto,
  requireCompletedEvidenceRun,
  runProvenance,
} from './shared.js';

/**
 * `list_incidents`: one bounded keyset page of the incidents one completed
 * evidence run resolved. The cursor is an incident identifier, so the page
 * boundary is a value the caller already holds and nothing is inferred.
 */
export async function listIncidents(
  store: IncidentReadStore,
  args: ListIncidentsArguments,
): Promise<ListIncidentsOutput> {
  const evidenceRunId = canonicalUuid(args.evidenceRunId);
  const afterIncidentId =
    args.afterIncidentId === undefined ? null : canonicalUuid(args.afterIncidentId);
  const run = await requireCompletedEvidenceRun(store, evidenceRunId);
  const rows = await store.listIncidentSummaries(run.id, afterIncidentId, args.limit);
  const incidents = rows.map(incidentSummaryDto);
  const last = incidents[incidents.length - 1];
  return {
    notice: RESULT_NOTICE,
    tool: 'list_incidents',
    run: runProvenance(run),
    page: {
      limit: args.limit,
      afterIncidentId,
      returned: incidents.length,
      nextCursor: incidents.length === args.limit && last !== undefined ? last.incidentId : null,
    },
    incidents,
  };
}
