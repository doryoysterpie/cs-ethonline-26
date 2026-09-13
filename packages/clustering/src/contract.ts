import { createHash } from 'node:crypto';

/**
 * The clustering engine's behaviour contract: the executable source of truth.
 *
 * Sprint 3's re-audit found a contract that described its engine instead of
 * driving it, so a hash could move while behaviour stood still. Every field
 * below is read by `cluster(inputs, contract)` at run time, and every one of
 * them is proven by a test whose input is chosen so that changing the field
 * must change an observable result. Three identity fields cannot be executed
 * by anything; they are the run's identity, they are stored on every run, and
 * they are declared as identity rather than counted as behaviour.
 *
 * `engineVersion` is the honest residue: the union-find, the inverted index,
 * the order the three stages run in and the iteration order in `engine.ts`
 * cannot be expressed declaratively. It must be incremented whenever that code
 * changes what the engine returns. A field that only described one of those,
 * such as a stage-order list the engine did not read, was deliberately left
 * out rather than hashed for appearance.
 */

export const ENGINE_VERSION = 'clustering-engine@2';
export const CONTRACT_VERSION = 'clustering-behavior-contract@2';
export const CLUSTERING_MODE = 'deterministic' as const;

/** Stable machine-readable reasons. Never a source excerpt. */
export const REASON_CODES = {
  singletonSource: 'singleton_source',
  exactUrlDuplicate: 'exact_url_duplicate',
  syndicatedText: 'syndicated_text',
  sharedIncidentSignals: 'shared_incident_signals',
  timeProximity: 'time_proximity',
  timestampAbsent: 'timestamp_absent',
  ambiguousBelowThreshold: 'ambiguous_below_threshold',
  ambiguousOutsideTimeWindow: 'ambiguous_outside_time_window',
  blockBoundReached: 'block_bound_reached',
  clusterBoundReached: 'cluster_bound_reached',
} as const;
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

/** How the boundary validates one admitted field's runtime value. */
export type InputFieldKind =
  'identifier' | 'decision' | 'text' | 'optional-identifier' | 'optional-timestamp';

export interface InputFieldContract {
  readonly key: string;
  readonly kind: InputFieldKind;
}

/**
 * The exact set of own keys a clustering input may carry. Nothing outside this
 * list is admitted, so a human review state, a weekly label, a publisher
 * category, a `ch` value, a raw cell or a connection string cannot reach the
 * engine even under a new name.
 */
export const ALLOWED_INPUT_KEYS: readonly InputFieldContract[] = [
  { key: 'sourceRowId', kind: 'identifier' },
  { key: 'rowHash', kind: 'identifier' },
  { key: 'classificationResultId', kind: 'identifier' },
  { key: 'classificationRunId', kind: 'identifier' },
  { key: 'batchId', kind: 'identifier' },
  { key: 'dataOrigin', kind: 'identifier' },
  { key: 'decision', kind: 'decision' },
  { key: 'urlGroupId', kind: 'optional-identifier' },
  { key: 'postedAt', kind: 'optional-timestamp' },
  { key: 'normalizedTitle', kind: 'text' },
  { key: 'derivedSummaryText', kind: 'text' },
  { key: 'derivedDescriptionText', kind: 'text' },
];

export interface TextAssemblyContract {
  /**
   * Fields joined in this order. Order is behaviour: shingles span the join,
   * so which field comes first decides which token sequences exist.
   *
   * There are deliberately no separator, null-handling or empty-handling
   * fields. Tokenization ignores every character that is not part of a token,
   * so a joiner, an absent field and a field that normalizes to nothing all
   * contribute exactly no tokens however they are treated. A field that
   * cannot change behaviour is not hashed here. Absent and empty fields are
   * simply skipped, and runs of whitespace are always collapsed because no
   * treatment of whitespace can change which tokens exist either.
   */
  readonly fieldOrder: readonly string[];
  readonly unicodeNormalizationForm: 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
  readonly caseNormalization: 'lowercase' | 'none';
  /** `null` evaluates the whole text; a number truncates to that many characters. */
  readonly maxInputCharacters: number | null;
}

export interface TokenizationContract {
  /** Regular-expression body matching one token. */
  readonly tokenPattern: string;
  readonly minimumTokenLength: number;
  /** Tokens beyond this count are not read. Bounds a hostile or huge field. */
  readonly maximumTokens: number;
  /**
   * Generic vocabulary that may never carry an incident on its own. Shared
   * stop terms cannot support a merge.
   */
  readonly stopTerms: readonly string[];
}

export interface FingerprintContract {
  /** Number of consecutive tokens per shingle. */
  readonly shingleSize: number;
  readonly maximumShingles: number;
  readonly componentSeparator: string;
  readonly algorithm: 'sha256';
  /** Hexadecimal characters kept from the digest. */
  readonly digestLength: number;
}

export interface SimilarityContract {
  readonly function: 'jaccard' | 'containment';
  /** Shingle similarity at or above which two reports are the same reporting. */
  readonly syndicationThreshold: number;
  /** Distinctive-token similarity at or above which two reports are one incident. */
  readonly incidentThreshold: number;
  /**
   * How far below a threshold still counts as an ambiguous relationship worth
   * a human's attention. Below this margin the pair is simply separate.
   */
  readonly ambiguousMargin: number;
}

export interface BlockingContract {
  /** Tokens per item used as blocking keys, chosen in a fixed hash order. */
  readonly keysPerItem: number;
  /** A blocking key holding more items than this is skipped as uninformative. */
  readonly maximumBlockSize: number;
  /** Hard cap on candidate comparisons for one item. */
  readonly maximumComparisonsPerItem: number;
  /** A token appearing in more than this share of items cannot be a blocking key. */
  readonly maximumDocumentFrequencyRatio: number;
}

export interface IncidentContract {
  readonly minimumSharedDistinctiveTokens: number;
  readonly minimumDistinctiveTokenLength: number;
  /**
   * How many of the shared tokens must be rare in this corpus. Journalistic
   * boilerplate is distinctive by the stop list yet common in the corpus, so
   * without this a merge can rest on "officials", "services" and "outage".
   */
  readonly minimumSharedRareTokens: number;
  /** A token carried by no more than this share of reports is rare. */
  readonly rareTokenDocumentFrequencyRatio: number;
  /** Hours between two reports for time proximity to hold. */
  readonly timeWindowHours: number;
  /** What to do when one or both timestamps are absent. */
  readonly missingTimestampBehaviour: 'allow' | 'separate';
  /**
   * What to do when the declared criteria disagree: one is met and another is
   * not. `ambiguous` records the pair for a human; `separate` leaves it apart
   * with no record.
   */
  readonly conflictingSignalBehaviour: 'ambiguous' | 'separate';
}

export interface RepresentativeContract {
  readonly rule: 'earliest-timestamp-then-lowest-id' | 'lowest-id';
}

export interface BoundsContract {
  readonly maximumInputs: number;
  /**
   * The largest cluster the engine may produce, counted in `clusterSizeUnit`.
   *
   * Checked before every union, against the cumulative size of the two
   * union-find components being joined, not against the size of the pair. The
   * first audit of Sprint 4 rejected a check that read the pair alone: a chain
   * of pairs each individually under the bound accumulated a 501-member
   * component while `boundsReached` stayed at zero.
   */
  readonly maximumClusterSize: number;
  /**
   * What `maximumClusterSize` counts. `rows` counts the source rows that
   * would end up in the cluster, which is what a membership row is and what a
   * reader sees. `duplicate-groups` counts exact-URL groups instead, so a
   * corpus of large duplicate groups can pass a bound that its row count
   * exceeds many times over.
   */
  readonly clusterSizeUnit: 'rows' | 'duplicate-groups';
  /**
   * What to do when one exact-URL duplicate group is already larger than
   * `maximumClusterSize` before any merge is considered.
   *
   * A duplicate group is a fact, not an inference: those rows carry the same
   * canonical URL, so splitting them would publish one report as several and
   * admitting them would publish a cluster past the declared bound.
   * `reject-run` refuses the whole run with a fixed condition and the numeric
   * bound, which is the shipped choice because a failed run is recoverable and
   * a silently oversized cluster is not. `admit-and-record` keeps the group
   * whole, admits the oversized cluster and records the bound instead.
   */
  readonly oversizedDuplicateGroupBehaviour: 'reject-run' | 'admit-and-record';
  readonly maximumAmbiguousLinks: number;
}

export interface ClusteringContract {
  // Identity. Not executable, deliberately hashed, stored on every run.
  readonly engineVersion: string;
  readonly contractVersion: string;
  readonly mode: 'deterministic';
  // Behaviour. Every field below is read by `cluster` at run time.
  readonly allowedInputKeys: readonly InputFieldContract[];
  readonly eligibleDecisions: readonly string[];
  readonly textAssembly: TextAssemblyContract;
  readonly tokenization: TokenizationContract;
  readonly fingerprint: FingerprintContract;
  readonly similarity: SimilarityContract;
  readonly blocking: BlockingContract;
  readonly incident: IncidentContract;
  readonly representative: RepresentativeContract;
  readonly bounds: BoundsContract;
}

/**
 * Generic security vocabulary. These words describe the subject matter of the
 * whole corpus, so two reports sharing them share nothing that identifies an
 * event. They are excluded from every distinctive-token decision.
 */
const STOP_TERMS: readonly string[] = [
  'attack',
  'attacked',
  'attackers',
  'attacks',
  'breach',
  'breached',
  'breaches',
  'compromise',
  'compromised',
  'cyber',
  'cyberattack',
  'cyberattacks',
  'cybersecurity',
  'data',
  'exploit',
  'exploited',
  'hack',
  'hacked',
  'hackers',
  'hacking',
  'incident',
  'infosec',
  'intrusion',
  'leak',
  'leaked',
  'malware',
  'ransomware',
  'report',
  'reported',
  'said',
  'security',
  'threat',
  'vulnerabilities',
  'vulnerability',
];

const CONTRACT: ClusteringContract = {
  engineVersion: ENGINE_VERSION,
  contractVersion: CONTRACT_VERSION,
  mode: CLUSTERING_MODE,
  allowedInputKeys: ALLOWED_INPUT_KEYS,
  eligibleDecisions: ['include', 'review'],
  textAssembly: {
    fieldOrder: ['normalizedTitle', 'derivedSummaryText', 'derivedDescriptionText'],
    unicodeNormalizationForm: 'NFC',
    caseNormalization: 'lowercase',
    maxInputCharacters: 12000,
  },
  tokenization: {
    tokenPattern: '[\\p{L}\\p{N}]+',
    minimumTokenLength: 3,
    maximumTokens: 1200,
    stopTerms: STOP_TERMS,
  },
  fingerprint: {
    shingleSize: 4,
    maximumShingles: 128,
    componentSeparator: ' ',
    algorithm: 'sha256',
    digestLength: 64,
  },
  similarity: {
    function: 'jaccard',
    syndicationThreshold: 0.6,
    incidentThreshold: 0.34,
    ambiguousMargin: 0.12,
  },
  blocking: {
    keysPerItem: 8,
    maximumBlockSize: 120,
    maximumComparisonsPerItem: 400,
    maximumDocumentFrequencyRatio: 0.08,
  },
  incident: {
    minimumSharedDistinctiveTokens: 3,
    minimumDistinctiveTokenLength: 4,
    minimumSharedRareTokens: 2,
    rareTokenDocumentFrequencyRatio: 0.02,
    timeWindowHours: 72,
    missingTimestampBehaviour: 'allow',
    conflictingSignalBehaviour: 'ambiguous',
  },
  representative: {
    rule: 'earliest-timestamp-then-lowest-id',
  },
  bounds: {
    maximumInputs: 250000,
    maximumClusterSize: 500,
    clusterSizeUnit: 'rows',
    oversizedDuplicateGroupBehaviour: 'reject-run',
    maximumAmbiguousLinks: 50000,
  },
};

/** Freezes an object and everything reachable from it. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** True when nothing reachable from `value` can be changed. */
export function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

export const CLUSTERING_CONTRACT: ClusteringContract = deepFreeze(CONTRACT);

/**
 * Deterministic canonical serialization: object keys sorted, array order
 * preserved because array order is behaviour, `null` distinguished from
 * absent, and numbers and strings kept as their own types.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('contract contains a non-finite number');
    return Number.isInteger(value) ? value.toFixed(0) : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  throw new TypeError('contract contains an unserializable value');
}

export function canonicalContract(contract: ClusteringContract = CLUSTERING_CONTRACT): string {
  return canonicalize(contract);
}

export function contractHash(contract: ClusteringContract = CLUSTERING_CONTRACT): string {
  return createHash('sha256').update(canonicalContract(contract), 'utf8').digest('hex');
}
