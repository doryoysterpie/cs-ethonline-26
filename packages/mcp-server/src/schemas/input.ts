import * as z from 'zod/v4';

import {
  DRAFT_INCIDENTS_DEFAULT_LIMIT,
  DRAFT_INCIDENTS_MAX_LIMIT,
  LIST_INCIDENTS_DEFAULT_LIMIT,
  LIST_INCIDENTS_MAX_LIMIT,
} from '../bounds.js';
import { chainSchema, instantArgument, uuidArgument } from './common.js';

/**
 * The four tool input schemas. Every one is a flat, strict object of
 * primitives: unexpected keys are refused by the schema (`additionalProperties:
 * false` on the wire) and again by the hardened check in `validation.ts`
 * before any value is read.
 *
 * Every tool names its subject explicitly. There is no "latest run" default
 * anywhere, and no argument that could name a table, a query, a URL or a path.
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

export const chainAnomaliesInput = z
  .object({
    mode: z
      .enum(CHAIN_ANOMALY_MODES)
      .describe(
        "'stored' evaluates a named completed signal run from the database. 'live' queries the Graph provider now and requires GRAPH_API_KEY; it never falls back to stored, replay or fixture data.",
      ),
    signalRunId: uuidArgument(
      'Stored mode only: identifier of one completed signal run.',
    ).optional(),
    asOf: instantArgument(
      'Stored mode only: the instant freshness is judged against. Defaults to the server clock.',
    ).optional(),
    chain: chainSchema
      .describe("Live mode only: which chain's configured targets to query.")
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'stored') {
      if (value.signalRunId === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['signalRunId'],
          message: 'required in stored mode',
        });
      }
      if (value.chain !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['chain'],
          message: 'not permitted in stored mode',
        });
      }
    } else {
      if (value.chain === undefined) {
        context.addIssue({ code: 'custom', path: ['chain'], message: 'required in live mode' });
      }
      if (value.signalRunId !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['signalRunId'],
          message: 'a live request may not name a stored run',
        });
      }
      if (value.asOf !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['asOf'],
          message: 'live mode always uses the server clock',
        });
      }
    }
  });

export const DRAFT_SECTIONS = ['header', 'incidents', 'crypto', 'provenance'] as const;

export const draftSectionInput = z
  .object({
    evidenceRunId: uuidArgument('Identifier of the completed evidence run to draft from.'),
    section: z.enum(DRAFT_SECTIONS).describe('Which section of the draft to preview.'),
    periodStart: instantArgument('Explicit start of the reporting period. Never inferred.'),
    periodEnd: instantArgument('Explicit end of the reporting period. Must be after periodStart.'),
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
