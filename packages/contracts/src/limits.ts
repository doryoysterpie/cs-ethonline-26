/**
 * Versioned resource limits (security-foundation track, decision D26).
 *
 * Every value here is a hard ceiling on one measurable quantity at one
 * boundary the project already has: editorial CSV ingestion, the
 * Graph-provider response, the generated draft, and the lifetime of one
 * worker command. Oversized input fails with a fixed error that carries
 * counts only; nothing is truncated to fit, because a truncated record is a
 * silently altered record.
 *
 * Sizing rule. Each limit was set against the largest input the project has
 * accepted or observed, recorded below in `RESOURCE_LIMIT_MEASUREMENTS`, and
 * is at least `RESOURCE_LIMIT_HEADROOM` times that measurement, rounded up to
 * a round binary or decimal figure. Two limits are structural rather than
 * measured: the draft section count equals the drafting contract's section
 * list, and the draft claim ceiling equals the contract's maximum incidents
 * times its maximum claims per incident. A test pins every value and checks
 * the rule, so a change here is a reviewed change to `resource-limits@N`.
 *
 * Constants only. Enforcement lives at the boundaries that read the input:
 * `@cas/worker` for imports and command duration, `@cas/graph-evidence` for
 * provider responses. The draft limits are declared here and are enforced
 * by the draft writer, which the security-foundation track does not own.
 */

export const RESOURCE_LIMITS_VERSION = 'resource-limits@1';

/** Every limit is at least this many times the measured maximum, unless structural. */
export const RESOURCE_LIMIT_HEADROOM = 4;

export interface ImportLimits {
  /** Bytes of one import file, counted as the bytes are read. */
  readonly fileBytes: number;
  /** Logical data rows in one file, the header excluded. */
  readonly rowCount: number;
  /** Header cells in one file, blank headers included. */
  readonly columnCount: number;
  /** UTF-8 bytes of one cell, header cells included. */
  readonly cellBytes: number;
  /** UTF-8 bytes of every data-row cell in one file, summed: what the store retains. */
  readonly retainedBytes: number;
  /** Characters the CSV parser may buffer for one record. Derived: columns times cell bytes. */
  readonly recordBytes: number;
}

export interface GraphLimits {
  /** Decoded bytes of one successful provider response body, counted while it streams. */
  readonly responseBodyBytes: number;
  /** Bytes kept of a non-2xx body for the redacted error snippet; the rest is discarded. */
  readonly httpErrorSnippetBytes: number;
  /** Nesting depth of JSON containers, the root container being depth 1. */
  readonly jsonMaxDepth: number;
  /** Elements of one array or members of one object. */
  readonly jsonMaxCollectionSize: number;
  /** Arrays and objects in one document, counted together. */
  readonly jsonMaxCollections: number;
  /** Provider requests one client may have in flight at once. */
  readonly concurrentRequests: number;
}

export interface DraftLimits {
  /** Sections one draft may carry: exactly the drafting contract's section list. */
  readonly sections: number;
  /** Claims one draft may carry: the contract's maximum incidents times claims per incident. */
  readonly claims: number;
  /** UTF-8 bytes of the Markdown draft. */
  readonly outputBytes: number;
  /** UTF-8 bytes of the provenance sidecar. */
  readonly sidecarBytes: number;
}

export interface CommandLimits {
  /** Milliseconds one worker command may run before it is aborted. */
  readonly durationMs: number;
  /** Milliseconds a command is given to roll back after the abort before the process exits. */
  readonly graceMs: number;
}

export interface ResourceLimits {
  readonly version: string;
  readonly import: ImportLimits;
  readonly graph: GraphLimits;
  readonly draft: DraftLimits;
  readonly command: CommandLimits;
}

export const RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  version: RESOURCE_LIMITS_VERSION,
  import: Object.freeze({
    fileBytes: 536_870_912,
    rowCount: 250_000,
    columnCount: 64,
    cellBytes: 1_048_576,
    retainedBytes: 536_870_912,
    recordBytes: 67_108_864,
  }),
  graph: Object.freeze({
    responseBodyBytes: 1_048_576,
    httpErrorSnippetBytes: 4_096,
    jsonMaxDepth: 32,
    jsonMaxCollectionSize: 4_096,
    jsonMaxCollections: 16_384,
    concurrentRequests: 8,
  }),
  draft: Object.freeze({
    sections: 4,
    claims: 10_000,
    outputBytes: 16_777_216,
    sidecarBytes: 16_777_216,
  }),
  command: Object.freeze({
    durationMs: 1_800_000,
    graceMs: 5_000,
  }),
});

/**
 * The largest accepted or observed value of each limited quantity, measured
 * on 10 September 2026 over the real editorial exports (the master export of
 * 23,910 rows and the four weekly sheets CS79, CS86, CS88 and CS89), seven
 * live standardized Graph responses at the maximum snapshot count of 30, the
 * two real drafts of 154 and 180 incidents, and the replay import,
 * classification and clustering of the master export. Counts and byte
 * figures only; no content was retained.
 * The Graph responses arrived brotli-encoded and chunked with no
 * Content-Length header, which is why the body limit is applied to the
 * decoded stream and never trusts a declared length.
 */
export const RESOURCE_LIMIT_MEASUREMENTS = Object.freeze({
  measuredOn: '2026-09-10',
  import: Object.freeze({
    fileBytes: 119_643_204,
    rowCount: 23_910,
    columnCount: 9,
    cellBytes: 48_456,
    retainedBytes: 118_603_091,
    recordBytes: 97_135,
  }),
  graph: Object.freeze({
    responseBodyBytes: 4_446,
    httpErrorSnippetBytes: 0,
    jsonMaxDepth: 5,
    jsonMaxCollectionSize: 30,
    jsonMaxCollections: 37,
    concurrentRequests: 1,
  }),
  draft: Object.freeze({
    sections: 4,
    claims: 181,
    outputBytes: 75_168,
    sidecarBytes: 92_779,
  }),
  command: Object.freeze({
    /**
     * The longest real command: clustering the 23,910-row master batch,
     * 79,514 ms. The replay import of the same export took 25,864 ms and its
     * classification 12,760 ms.
     */
    durationMs: 79_514,
    graceMs: 0,
  }),
});
