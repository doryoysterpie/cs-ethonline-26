/**
 * @cas/contracts
 *
 * Shared type contracts that cross package boundaries: the pipeline, the
 * MCP server, the feed API and the dashboard. Sprint 0 defined the three
 * editorial contracts; Sprint 1 adds the minimal Graph evidence contracts
 * that `@cas/graph-evidence` produces for later consumers. No runtime
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
 * Chains whose live indexed data the project reads (decision D11). Ethereum
 * mainnet is mandatory; Base is secondary and subject to the Sprint 1 gate.
 */
export const CHAINS = ['ethereum', 'base'] as const;
export type ChainId = (typeof CHAINS)[number];

/** Identity of one protocol deployment as observed through a Graph provider. */
export interface ProtocolIdentity {
  /** Human-readable protocol name as reported by the standardized subgraph. */
  readonly name: string;
  /** Registry slug of the deployment, for example `aave-v3-ethereum`. */
  readonly slug: string;
  readonly chain: ChainId;
}

/**
 * Provenance of one live Graph-provider query. Every field the provider
 * returned is retained; fields it did not return are `null`, never invented.
 */
export interface GraphQueryProvenance {
  /** Always `live` for a record produced by the live client. */
  readonly origin: DataOrigin;
  /** Provider that served the query. */
  readonly provider: 'the-graph-gateway';
  /** Public Subgraph ID the query was addressed to. */
  readonly subgraphId: string;
  /** Deployment ID (`_meta.deployment`) when the provider returned it. */
  readonly deploymentId: string | null;
  readonly chain: ChainId;
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
  readonly schemaVersion: string | null;
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
