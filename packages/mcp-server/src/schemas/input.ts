import * as z from 'zod/v4';

import {
  DRAFT_INCIDENTS_DEFAULT_LIMIT,
  DRAFT_INCIDENTS_MAX_LIMIT,
  LIST_INCIDENTS_DEFAULT_LIMIT,
  LIST_INCIDENTS_MAX_LIMIT,
} from '../bounds.js';
import { chainSchema, instantArgument, uuidArgument } from './common.js';

/**
 * The four tool input schemas. Three are flat, strict objects of primitives;
 * the fourth, `chain_anomalies`, is a discriminated union of two such
 * objects, one per mode. Unexpected keys are refused by the schema
 * (`additionalProperties: false` on the wire, in every branch) and again by
 * the hardened check in `validation.ts` before any value is read.
 *
 * Every tool names its subject explicitly. There is no "latest run" default,
 * no server-clock default for a stored evaluation, and no argument that could
 * name a table, a query, a URL or a path.
 */

export const listIncidentsInput = z
  .object({
    evidenceRunId: uuidArgument(
      'Identifier of one completed evidence run. Its clustering run, batch and signal run are fixed by that run; nothing is inferred.',
    ),
    afterIncidentId: uuidArgument(
      "Keyset cursor: return incidents whose identifier sorts after this one. Use the previous page's nextCursor.",
    ).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_INCIDENTS_MAX_LIMIT)
      .default(LIST_INCIDENTS_DEFAULT_LIMIT)
      .describe(`Incidents per page, 1 to ${LIST_INCIDENTS_MAX_LIMIT}.`),
  })
  .strict();

export const explainIncidentInput = z
  .object({
    evidenceRunId: uuidArgument(
      'Identifier of the completed evidence run the incident was resolved in.',
    ),
    incidentId: uuidArgument('Identifier of one incident cluster of that run.'),
  })
  .strict();

export const CHAIN_ANOMALY_MODES = ['stored', 'live'] as const;

/**
 * Stored mode: one named completed signal run, evaluated at one explicit
 * instant. Both are required, so the result is a function of the database
 * snapshot and the arguments alone; there is no server-clock default.
 */
export const chainAnomaliesStoredInput = z
  .object({
    mode: z
      .literal('stored')
      .describe(
        'Evaluates one named completed signal run from the database against the stored history of the data origin that run recorded.',
      ),
    signalRunId: uuidArgument('Identifier of one completed signal run.'),
    asOf: instantArgument(
      'The instant freshness is judged against. Required: for a fixed database snapshot the result is determined by this instant and the run; the server clock is never used in stored mode.',
    ),
  })
  .strict();

/** Live mode: one chain's configured targets, queried now; the clock is the server's. */
export const chainAnomaliesLiveInput = z
  .object({
    mode: z
      .literal('live')
      .describe(
        'Queries the Graph provider now for one chain’s configured targets. Requires GRAPH_API_KEY; never falls back to stored, replay or fixture data. Freshness is judged against the server clock.',
      ),
    chain: chainSchema.describe("Which chain's configured targets to query."),
  })
  .strict();

/**
 * The two modes share nothing, so the schema is a true discriminated union:
 * a stored request carries `signalRunId` and `asOf` and no `chain`; a live
 * request carries `chain` and neither of the others. The advertised JSON
 * Schema is `oneOf` over the same two strict alternatives, and the runtime
 * validates with this very object, so a request the advertised schema admits
 * is one the runtime admits.
 */
export const chainAnomaliesInput = z
  .discriminatedUnion('mode', [chainAnomaliesStoredInput, chainAnomaliesLiveInput])
  .describe(
    'Exactly one of two argument shapes, selected by mode: stored (signalRunId, asOf) or live (chain). Fields of the other mode are refused.',
  );

export const DRAFT_SECTIONS = ['header', 'incidents', 'crypto', 'provenance'] as const;

export const draftSectionInput = z
  .object({
    evidenceRunId: uuidArgument('Identifier of the completed evidence run to draft from.'),
    section: z.enum(DRAFT_SECTIONS).describe('Which section of the draft to preview.'),
    periodStart: instantArgument('Explicit start of the reporting period. Never inferred.'),
    periodEnd: instantArgument(
      'Explicit end of the reporting period. Must be after periodStart; that ordering is checked at runtime and cannot be expressed in the advertised JSON Schema.',
    ),
    maximumIncidents: z
      .number()
      .int()
      .min(1)
      .max(DRAFT_INCIDENTS_MAX_LIMIT)
      .default(DRAFT_INCIDENTS_DEFAULT_LIMIT)
      .describe(`Most incidents the preview considers, 1 to ${DRAFT_INCIDENTS_MAX_LIMIT}.`),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.periodEnd) <= Date.parse(value.periodStart)) {
      context.addIssue({
        code: 'custom',
        path: ['periodEnd'],
        message: 'must be after periodStart',
      });
    }
  });

export type ListIncidentsArguments = z.output<typeof listIncidentsInput>;
export type ExplainIncidentArguments = z.output<typeof explainIncidentInput>;
export type ChainAnomaliesArguments = z.output<typeof chainAnomaliesInput>;
export type DraftSectionArguments = z.output<typeof draftSectionInput>;
