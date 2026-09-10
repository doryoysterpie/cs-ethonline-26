import * as z from 'zod/v4';

import {
  DRAFT_MARKDOWN_MAX_CHARACTERS,
  HEADLINE_MAX_CHARACTERS,
  IDENTITY_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import {
  ANOMALY_BOUNDARY_SENTENCE,
  anomalyLabelSchema,
  chainSchema,
  dataOriginSchema,
  decimalSchema,
  evidenceStateSchema,
  hex64Schema,
  instantOutput,
  quotedEvidenceSchema,
  RESULT_NOTICE,
  TELEMETRY_SENTENCE,
  uuidOutput,
  vocabularyList,
  vocabularySchema,
} from './common.js';
import { CHAIN_ANOMALY_MODES, DRAFT_SECTIONS } from './input.js';

/**
 * Strict public-safe output contracts. Every object is `.strict()`, so a
 * field that is not declared here cannot be serialized, whatever a query
 * happens to return. Retrieved text appears only as quoted evidence; every
 * other string is an identifier, a hash, a decimal, an instant or a fixed
 * vocabulary value.
 */

const notice = z.literal(RESULT_NOTICE);

/** Provenance of the evidence run every incident result is scoped to. */
export const evidenceRunProvenance = z
  .object({
    evidenceRunId: uuidOutput,
    clusteringRunId: uuidOutput,
    batchId: uuidOutput,
    signalRunId: uuidOutput,
    dataOrigin: dataOriginSchema,
    status: z.literal('completed'),
    resolverVersion: z.string().max(64),
    contractVersion: z.string().max(64),
    contractHash: hex64Schema,
    incidentCount: z.number().int().nonnegative(),
    stateCounts: z
      .object({
        reportedOnly: z.number().int().nonnegative(),
        onchainObserved: z.number().int().nonnegative(),
        corroborated: z.number().int().nonnegative(),
        contradicted: z.number().int().nonnegative(),
      })
      .strict(),
    completedAt: instantOutput,
  })
  .strict();

export const incidentSummary = z
  .object({
    incidentId: uuidOutput,
    kind: vocabularySchema,
    memberCount: z.number().int().positive(),
    sourceCount: z.number().int().nonnegative(),
    reasonCodes: vocabularyList,
    evidence: z
      .object({
        state: evidenceStateSchema,
        reasonCode: vocabularySchema,
        claimId: uuidOutput.nullable(),
        acceptedAssociationCount: z.number().int().nonnegative(),
        /** Fixed sentence for the state. Never composed from input. */
        sentence: z.string().max(200),
      })
      .strict(),
    subject: z
      .object({
        recorded: z.boolean(),
        chain: chainSchema.nullable(),
        protocolSlug: z.string().max(64).nullable(),
      })
      .strict(),
    headline: quotedEvidenceSchema(HEADLINE_MAX_CHARACTERS).nullable(),
    earliestReportedAt: instantOutput.nullable(),
    dataOrigin: dataOriginSchema,
  })
  .strict();

export const listIncidentsOutput = z
  .object({
    notice,
    tool: z.literal('list_incidents'),
    run: evidenceRunProvenance,
    page: z
      .object({
        limit: z.number().int().positive(),
        afterIncidentId: uuidOutput.nullable(),
        returned: z.number().int().nonnegative(),
        nextCursor: uuidOutput.nullable(),
      })
      .strict(),
    incidents: z.array(incidentSummary).max(50),
  })
  .strict();

export const incidentSource = z
  .object({
    sourceRowId: uuidOutput,
    title: quotedEvidenceSchema(HEADLINE_MAX_CHARACTERS).nullable(),
    publisher: quotedEvidenceSchema(PUBLISHER_MAX_CHARACTERS).nullable(),
    /** The canonical URL as stored, quoted. A reference, never something this server fetches. */
    url: quotedEvidenceSchema(URL_MAX_CHARACTERS).nullable(),
    postedAt: instantOutput.nullable(),
    classificationDecision: z.enum(['include', 'review']),
  })
  .strict();

export const incidentAssociation = z
  .object({
    associationId: uuidOutput,
    signalId: uuidOutput,
    chain: chainSchema,
    protocolSlug: z.string().max(64),
    signalObservedAt: instantOutput,
    signalDeltaPercent: decimalSchema,
    signalDataOrigin: dataOriginSchema,
    offsetSeconds: z.number().int(),
    /** What the machine proposed. Always a suggestion. */
    machineSuggestion: z
      .object({
        relation: z.enum(['supports', 'conflicts', 'context']),
        status: z.literal('suggested'),
        claimId: uuidOutput.nullable(),
      })
      .strict(),
    /** The suggestion plus the latest human decision, if any. */
    effective: z
      .object({
        relation: z.enum(['supports', 'conflicts', 'context']),
        status: z.enum(['suggested', 'accepted', 'rejected']),
        claimId: uuidOutput.nullable(),
        decidedByHuman: z.boolean(),
      })
      .strict(),
    reasonCodes: vocabularyList,
  })
  .strict();

export const explainIncidentOutput = z
  .object({
    notice,
    tool: z.literal('explain_incident'),
    run: evidenceRunProvenance,
    incident: incidentSummary,
    sources: z.array(incidentSource).max(50),
    associations: z.array(incidentAssociation).max(100),
    bounds: z
      .object({
        sourcesReturned: z.number().int().nonnegative(),
        sourcesLimit: z.number().int().positive(),
        associationsReturned: z.number().int().nonnegative(),
        associationsLimit: z.number().int().positive(),
      })
      .strict(),
    telemetrySentence: z.literal(TELEMETRY_SENTENCE),
  })
  .strict();

const timeWindow = z.object({ startsAt: z.number().int(), endsAt: z.number().int() }).strict();

/** The run and signal that actually produced the observation an entry labels. */
export const anomalyEntryProvenance = z
  .object({
    latestSignalRunId: uuidOutput.nullable(),
    latestSignalId: uuidOutput.nullable(),
    latestObservedAt: instantOutput.nullable(),
    observationsUsed: z.number().int().nonnegative(),
    /** Distinct completed runs whose observations of this target were used. */
    contributingRunCount: z.number().int().nonnegative(),
  })
  .strict();

export const anomalyEntry = z
  .object({
    label: anomalyLabelSchema,
    chain: chainSchema,
    protocolSlug: z.string().max(64),
    observationWindow: timeWindow,
    baselineWindow: timeWindow.nullable(),
    value: decimalSchema,
    threshold: decimalSchema,
    dataOrigin: dataOriginSchema,
    /** The run of the labelled observation; the named run only when the boundary holds none. */
    provenanceId: z.string().max(128),
    provenance: anomalyEntryProvenance,
    reasonCodes: vocabularyList,
    /** The engine's own fixed limitation sentence. */
    evidenceLimitation: z.string().max(200),
  })
  .strict();

/** The reproducible boundary a stored evaluation was read at. */
export const anomalyBoundary = z
  .object({
    requestedSignalRunId: uuidOutput,
    /** Completion instant of the named run: no run completed after it contributes. */
    completedAt: instantOutput,
    asOf: instantOutput,
    dataOrigin: dataOriginSchema,
    signalVersion: z.string().max(64),
    rule: z.literal(ANOMALY_BOUNDARY_SENTENCE),
    /** Distinct completed runs that contributed at least one used observation. */
    contributingRunCount: z.number().int().nonnegative(),
    earliestContributingRunCompletedAt: instantOutput.nullable(),
    latestContributingRunCompletedAt: instantOutput.nullable(),
  })
  .strict();

export const storedAnomalies = z
  .object({
    signalRun: z
      .object({
        signalRunId: uuidOutput,
        dataOrigin: dataOriginSchema,
        status: z.literal('completed'),
        signalVersion: z.string().max(64),
        contractVersion: z.string().max(64),
        contractHash: hex64Schema,
        querySha256: hex64Schema,
        gatewayHost: z.string().max(253),
        targetCount: z.number().int().nonnegative(),
        signalCount: z.number().int().nonnegative(),
        completedAt: instantOutput,
      })
      .strict(),
    boundary: anomalyBoundary,
    /** Distinct targets inside the boundary that were evaluated, and the observations read. */
    targetsEvaluated: z.number().int().nonnegative(),
    observationsRead: z.number().int().nonnegative(),
    entries: z.array(anomalyEntry).max(500),
    stats: z
      .object({
        spikes: z.number().int().nonnegative(),
        insufficientHistory: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        boundsReached: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const quotedIdentity = quotedEvidenceSchema(IDENTITY_MAX_CHARACTERS);

export const liveTarget = z
  .object({
    target: z
      .object({
        label: z.string().max(64),
        chain: chainSchema,
        configuredSlug: z.string().max(64),
        subgraphId: z.string().max(64),
      })
      .strict(),
    outcome: z.enum(['valid', 'failed']),
    identity: z
      .object({
        name: quotedIdentity,
        slug: quotedIdentity,
        network: quotedIdentity,
        chain: chainSchema,
        protocolType: quotedIdentity,
        schemaVersion: quotedIdentity,
      })
      .strict()
      .nullable(),
    signal: z
      .object({
        currentTimestamp: z.number().int(),
        currentTvlUsd: decimalSchema,
        baselineTimestamp: z.number().int(),
        baselineTvlUsd: decimalSchema,
        elapsedSeconds: z.number().int(),
        deltaUsd: decimalSchema,
        deltaPercent: decimalSchema,
      })
      .strict()
      .nullable(),
    freshness: z
      .object({
        fresh: z.boolean(),
        ageSeconds: z.number().int(),
        limitSeconds: z.number().int(),
        reason: z.string().max(64),
      })
      .strict()
      .nullable(),
    provenance: z
      .object({
        origin: z.literal('live'),
        provider: z.enum(['the-graph-gateway', 'graph-compatible-https-endpoint']),
        providerBase: z.string().max(256),
        subgraphId: z.string().max(64),
        deploymentId: quotedIdentity.nullable(),
        targetChain: chainSchema,
        targetSlug: z.string().max(64),
        queriedAtUtc: instantOutput,
        queryDocumentSha256: hex64Schema,
        block: z
          .object({
            number: z.number().int().nonnegative(),
            hash: quotedIdentity.nullable(),
            timestamp: z.number().int().nullable(),
          })
          .strict(),
        snapshotTimestamps: z.array(z.number().int()).max(64),
        hasIndexingErrors: z.boolean(),
        schemaVersion: quotedIdentity,
        subgraphVersion: quotedIdentity.nullable(),
        methodologyVersion: quotedIdentity.nullable(),
      })
      .strict()
      .nullable(),
    anomaly: z
      .object({
        label: anomalyLabelSchema,
        reasonCodes: vocabularyList,
        value: decimalSchema,
        threshold: decimalSchema,
        evidenceLimitation: z.string().max(200),
      })
      .strict()
      .nullable(),
    failure: z
      .object({
        kind: z.enum([
          'credential',
          'http',
          'graphql',
          'schema',
          'validation',
          'indexing',
          'timeout',
          'network',
          'unexpected',
        ]),
        /** Fixed sentence per kind. Never the provider's text. */
        message: z.string().max(200),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const liveAnomalies = z
  .object({
    chain: chainSchema,
    provider: z.enum(['the-graph-gateway', 'graph-compatible-https-endpoint']),
    providerBase: z.string().max(256),
    queriedAtUtc: instantOutput,
    targetsConfigured: z.number().int().nonnegative(),
    targetsValid: z.number().int().nonnegative(),
    targets: z.array(liveTarget).max(16),
    /** Fixed sentence stating what a live observation can and cannot be labelled. */
    baselineNote: z.string().max(300),
  })
  .strict();

export const chainAnomaliesOutput = z
  .object({
    notice,
    tool: z.literal('chain_anomalies'),
    mode: z.enum(CHAIN_ANOMALY_MODES),
    asOf: instantOutput,
    telemetrySentence: z.literal(TELEMETRY_SENTENCE),
    stored: storedAnomalies.nullable(),
    live: liveAnomalies.nullable(),
  })
  .strict();

export const draftSectionOutput = z
  .object({
    notice,
    tool: z.literal('draft_section'),
    run: evidenceRunProvenance,
    section: z.enum(DRAFT_SECTIONS),
    period: z.object({ start: instantOutput, end: instantOutput }).strict(),
    preview: z
      .object({
        /** Markdown assembled deterministically from quoted evidence and fixed sentences. */
        markdown: z.string().max(DRAFT_MARKDOWN_MAX_CHARACTERS),
        status: z.literal('unpublished_requires_human_review'),
        persisted: z.literal(false),
        modelInvoked: z.literal(false),
        draftingVersion: z.string().max(64),
        contractVersion: z.string().max(64),
        contractHash: hex64Schema,
        counts: z
          .object({
            incidents: z.number().int().nonnegative(),
            claimsWritten: z.number().int().nonnegative(),
            claimsOmitted: z.number().int().nonnegative(),
            namesWithheld: z.number().int().nonnegative(),
            contradicted: z.number().int().nonnegative(),
            cryptoIncidents: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    incidentsConsidered: z.number().int().nonnegative(),
    incidentsLimit: z.number().int().positive(),
    /** What the bounded draft query left out, so a preview cannot pass for the whole record. */
    bounds: z
      .object({
        sourcesPerIncidentLimit: z.number().int().positive(),
        /** Source rows fetched across the considered incidents. */
        sourcesConsidered: z.number().int().nonnegative(),
        /** Source rows the considered incidents have beyond the per-incident bound. */
        sourcesOmitted: z.number().int().nonnegative(),
        incidentsWithOmittedSources: z.number().int().nonnegative(),
        text: z
          .object({
            /** Title, publisher and URL fields whose display copy omits stored characters. */
            fieldsTruncated: z.number().int().nonnegative(),
            /** Size of the stored values behind the fetched fields, before any bound. */
            storedCharacters: z.number().int().nonnegative(),
            storedBytes: z.number().int().nonnegative(),
            /** Characters actually transferred from the database for those fields. */
            fetchedCharacters: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    dataOrigin: dataOriginSchema,
  })
  .strict();

export type ListIncidentsOutput = z.output<typeof listIncidentsOutput>;
export type ExplainIncidentOutput = z.output<typeof explainIncidentOutput>;
export type ChainAnomaliesOutput = z.output<typeof chainAnomaliesOutput>;
export type DraftSectionOutput = z.output<typeof draftSectionOutput>;
export type IncidentSummaryDto = z.output<typeof incidentSummary>;
export type EvidenceRunProvenanceDto = z.output<typeof evidenceRunProvenance>;
export type AnomalyEntryDto = z.output<typeof anomalyEntry>;
export type AnomalyEntryProvenanceDto = z.output<typeof anomalyEntryProvenance>;
export type LiveTargetDto = z.output<typeof liveTarget>;
