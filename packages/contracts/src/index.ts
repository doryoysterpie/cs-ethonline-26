/**
 * @cas/contracts
 *
 * Shared type contracts that cross package boundaries: the pipeline, the
 * MCP server, the feed API and the dashboard. Sprint 0 defined the three
 * editorial contracts; Sprint 1 adds the minimal Graph evidence contracts
 * that `@cas/graph-evidence` produces for later consumers; Sprint 2 adds the
 * editorial source kind and the import status enums. No runtime
 * behaviour lives here beyond constant definitions. See docs/ARCHITECTURE.md
 * and docs/DATA_INPUTS.md.
 */

/**
 * HUMAN review state of one source record, as recorded in a versioned
 * editorial review record: a weekly snapshot sheet or the review workflow.
 * Written only by a human decision. Never a context-free boolean: the master
 * feed's working `ch` column is not a stable label (docs/DATA_INPUTS.md
 * section 3). Never derived from a classification decision.
 */
export const REVIEW_STATES = ['selected', 'rejected', 'unreviewed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * MACHINE decision of the automated high-recall classifier for one imported
 * source record, made before any human looks at it (docs/ARCHITECTURE.md
 * section 3, decision D15). `review` routes the record to the needs-review
 * queue. A classification decision is never a review state and never
 * implies one; the two are stored and displayed separately.
 */
export const CLASSIFICATION_DECISIONS = ['include', 'exclude', 'review'] as const;
export type ClassificationDecision = (typeof CLASSIFICATION_DECISIONS)[number];

/**
 * Execution and data context of any record, independent of the system it
 * came from:
 *
 * - `live`: obtained from a current external source during this run. A
 *   current editorial RSS or spreadsheet import and a current Graph-provider
 *   query are both `live`.
 * - `fixture`: checked-in synthetic or approved test data.
 * - `replay`: previously captured data intentionally replayed.
 *
 * Whether a record is editorial or Graph-derived is provenance, carried by a
 * later source-kind contract, not by this value. Live, fixture and replay
 * data must never be confused (docs/ARCHITECTURE.md section 7,
 * docs/SECURITY.md section 4).
 */
export const DATA_ORIGINS = ['live', 'fixture', 'replay'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

/**
 * Kind of editorial CSV export an import batch came from (decision D20,
 * docs/DATA_INPUTS.md section 3). `master` is the master RSS export, whose
 * `ch` column is working state and never a review label. `weekly` is a weekly
 * snapshot sheet, whose `ch` column is the stable review label for the named
 * week. The kind is provenance; it is never inferred from file content.
 */
export const EDITORIAL_SOURCE_KINDS = ['master', 'weekly'] as const;
export type EditorialSourceKind = (typeof EDITORIAL_SOURCE_KINDS)[number];

/**
 * Terminal status of an import batch. A structurally rejected file never
 * creates a batch, and a batch is never left half written, so the only
 * statuses are the two completed forms. `completed_with_issues` means at
 * least one row was retained in quarantine (decision D20).
 */
export const IMPORT_BATCH_STATUSES = ['completed', 'completed_with_issues'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/**
 * Status of one imported source row. A quarantined row is retained in full
 * with its raw cells and its issues; nothing is dropped.
 */
export const SOURCE_ROW_STATUSES = ['accepted', 'quarantined'] as const;
export type SourceRowStatus = (typeof SOURCE_ROW_STATUSES)[number];

/**
 * Severity of a row issue. `error` quarantines the row; `warning` records the
 * observation and leaves the row accepted.
 */
export const ROW_ISSUE_SEVERITIES = ['error', 'warning'] as const;
export type RowIssueSeverity = (typeof ROW_ISSUE_SEVERITIES)[number];

/**
 * Chains whose live indexed data the project reads (decision D11). Ethereum
 * mainnet is mandatory; Base is secondary and subject to the Sprint 1 gate.
 */
export const CHAINS = ['ethereum', 'base'] as const;
export type ChainId = (typeof CHAINS)[number];

/**
 * Identity of one protocol deployment AS RETURNED BY THE PROVIDER. Every
 * field comes from the live standardized `Protocol` entity, never from the
 * project's own registry. The configured target identity lives separately in
 * `GraphQueryProvenance.targetChain` and `targetSlug`, so the two can be
 * compared and never confused.
 */
export interface ProtocolIdentity {
  /** Provider-returned protocol name. */
  readonly name: string;
  /** Provider-returned protocol slug. Never substituted by a configured slug. */
  readonly slug: string;
  /** Provider-returned network value, verbatim, for example `MAINNET` or `BASE`. */
  readonly network: string;
  /** `network` normalized through the documented alias table; only recognized values map. */
  readonly chain: ChainId;
  /** Provider-returned standardized protocol family, for example `LENDING`. */
  readonly protocolType: string;
  /** Provider-returned standardized schema version, for example `3.1.0`. */
  readonly schemaVersion: string;
}

/**
 * Which kind of endpoint served a query. `the-graph-gateway` is claimed only
 * when the validated base URL's host is The Graph's public gateway; any other
 * validated HTTPS endpoint is recorded as a Graph-compatible endpoint.
 */
export type GraphProvider = 'the-graph-gateway' | 'graph-compatible-https-endpoint';

/**
 * Provenance of one live Graph-provider query. Every field the provider
 * returned is retained; fields it did not return are `null`, never invented.
 * No field may contain authorization data, user information, query
 * parameters or fragments.
 */
export interface GraphQueryProvenance {
  /** Always `live` for a record produced by the live client. */
  readonly origin: DataOrigin;
  readonly provider: GraphProvider;
  /** Validated HTTPS origin plus path of the endpoint, with nothing else. */
  readonly providerBase: string;
  /** Public Subgraph ID the query was addressed to (configured). */
  readonly subgraphId: string;
  /** Deployment ID (`_meta.deployment`) when the provider returned it. */
  readonly deploymentId: string | null;
  /** Chain the configured target was expected to be on. Compare with `ProtocolIdentity.chain`. */
  readonly targetChain: ChainId;
  /** Registry slug of the configured target. Compare with `ProtocolIdentity.slug`. */
  readonly targetSlug: string;
  /** UTC timestamp of the request, ISO 8601. */
  readonly queriedAtUtc: string;
  /** SHA-256 of the exact GraphQL document sent, hex. */
  readonly queryDocumentSha256: string;
  /** Block the response was served at, from `_meta.block`. */
  readonly block: {
    readonly number: number;
    readonly hash: string | null;
    /** Unix seconds when the provider returned it. */
    readonly timestamp: number | null;
  };
  /** Unix-second timestamps of every financial snapshot in the response. */
  readonly snapshotTimestamps: readonly number[];
  readonly hasIndexingErrors: boolean;
  /** Provider-returned schema version; required. */
  readonly schemaVersion: string;
  readonly subgraphVersion: string | null;
  readonly methodologyVersion: string | null;
}

/**
 * One observation of a protocol's total value locked, in USD, as the
 * standardized subgraph reports it. The raw decimal string is retained
 * unchanged; no floating-point conversion happens in the contract.
 */
export interface ProtocolTvlObservation {
  /** Unix seconds. */
  readonly timestamp: number;
  readonly blockNumber: number | null;
  /** Raw decimal string exactly as returned, for example `"24773571335.52"`. */
  readonly totalValueLockedUsd: string;
  /** Where the observation came from within the standardized response. */
  readonly source: 'protocol-head' | 'financials-daily-snapshot';
  /** Snapshot entity id when the source is a snapshot, else `null`. */
  readonly snapshotId: string | null;
}

/**
 * A calculated TVL-delta signal between a current observation and an
 * approximately 24-hour-earlier baseline. The elapsed window is always the
 * measured value; nothing here claims an exact 24 hours.
 */
export interface TvlDeltaSignal {
  /** Provider-returned identity of the protocol the signal describes. */
  readonly protocol: ProtocolIdentity;
  readonly current: ProtocolTvlObservation;
  readonly baseline: ProtocolTvlObservation;
  /** Measured seconds between baseline and current. */
  readonly elapsedSeconds: number;
  /** The window rule that selected the baseline. */
  readonly window: {
    readonly targetSeconds: number;
    readonly minSeconds: number;
    readonly maxSeconds: number;
  };
  /** Exact decimal difference, current minus baseline, as a string. */
  readonly deltaUsd: string;
  /** Percentage change, truncated (not rounded) to six decimal places, as a string. */
  readonly deltaPercent: string;
  readonly provenance: GraphQueryProvenance;
}
