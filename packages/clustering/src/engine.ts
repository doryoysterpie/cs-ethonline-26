import {
  CLUSTERING_CONTRACT,
  REASON_CODES,
  type ClusteringContract,
  type ReasonCode,
} from './contract.js';
import { assertClusteringInputs, type ClusteringInput } from './input.js';
import {
  assembleText,
  distinctiveTokens,
  fingerprintOf,
  sharedCount,
  shingles,
  similarityOf,
  tokenize,
} from './text.js';

/**
 * The Sprint 4 clustering engine (decision D22).
 *
 * Pure and deterministic: no database, no network, no environment variable,
 * no model call, no clock and no randomness. Every behaviour-affecting value
 * is read from the supplied contract, so the stored contract hash describes
 * what the engine actually does.
 *
 * Three stages, kept separate because they answer different questions:
 *
 *   1. **Exact URL duplicates.** The same canonical URL group, decided by
 *      Sprint 2's grouping and never recomputed here. No row is discarded;
 *      every duplicate stays as evidence.
 *   2. **Syndication.** Substantially identical reporting carried by
 *      different URLs, decided by shingle similarity, which is sensitive to
 *      word order and therefore to rewriting.
 *   3. **Incident grouping.** Separate reports that plausibly describe one
 *      event, decided by shared *distinctive* tokens and, where both
 *      timestamps exist, time proximity. Generic security vocabulary is
 *      removed first, so two reports never merge because both say "attack".
 *
 * Conservative by construction: a merge must be positively supported, a
 * near-miss stays separate and becomes an ambiguous link for a human, and
 * every bound that stops work is recorded rather than hidden.
 *
 * **Cluster size.** `bounds.maximumClusterSize` is checked before every union,
 * against the cumulative size of the two union-find components being joined
 * and counted in `bounds.clusterSizeUnit`. Checking the pair alone was the
 * defect the first Sprint 4 audit found: a chain of pairs each under the bound
 * accumulated a component past it while nothing was recorded. A refused union
 * leaves both components standing, increments `boundsReached` and marks the
 * resulting clusters `cluster_bound_reached`. An exact-URL duplicate group
 * that already exceeds the bound is not a merge decision at all, so it is
 * handled by `bounds.oversizedDuplicateGroupBehaviour` instead.
 *
 * **Complexity.** Let N be the eligible inputs, G the duplicate groups, K the
 * contract's `blocking.keysPerItem`, B its `maximumBlockSize` and C its
 * `maximumComparisonsPerItem`. Assembly, tokenization and grouping are O(N)
 * in the bounded token count. Each blocking pass builds an inverted index in
 * O(G·K), which yields at most G·K blocking keys. A block holding more than B
 * items is skipped whole as uninformative and reported through
 * `block_bound_reached`, so every scanned block holds at most B items and
 * costs at most B(B−1)/2 pair iterations. Pair work is therefore bounded by
 * O(G·K·B²). C bounds only how many of those iterations become admitted
 * comparisons: an exhausted per-item budget skips the comparison, it does not
 * stop the scan, so O(G·C) understates the loop and is not claimed.
 * With K and B fixed by the contract, cost grows linearly in G and is never
 * quadratic in N, while the work inside one block is quadratic in B.
 * `stats.pairIterations` reports the iterations actually performed and a
 * regression holds it to this bound.
 */

export type ClusterKind =
  'singleton' | 'duplicate_group' | 'syndicated_group' | 'multi_report_incident';

export interface ClusterMember {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly classificationResultId: string;
  readonly decision: string;
  /** Identity of the exact-URL-duplicate group this row belongs to. */
  readonly duplicateFingerprint: string;
  /** Identity of the syndication group its duplicate group belongs to. */
  readonly syndicationFingerprint: string;
}

export interface IncidentCluster {
  readonly fingerprint: string;
  readonly kind: ClusterKind;
  readonly reasonCodes: readonly ReasonCode[];
  readonly representativeSourceRowId: string;
  readonly duplicateGroupCount: number;
  readonly syndicationGroupCount: number;
  readonly members: readonly ClusterMember[];
}

export interface AmbiguousLink {
  readonly leftFingerprint: string;
  readonly rightFingerprint: string;
  readonly reasonCodes: readonly ReasonCode[];
  /** Similarity truncated to six places, so it is stable across machines. */
  readonly similarity: number;
  readonly sharedSignals: number;
  /** How many of those shared signals are rare in this corpus. */
  readonly sharedRareSignals: number;
}

export interface ClusteringStats {
  readonly eligibleInputs: number;
  readonly ineligibleInputs: number;
  readonly duplicateGroups: number;
  readonly syndicationGroups: number;
  readonly incidentClusters: number;
  readonly singletonIncidents: number;
  readonly multiSourceIncidents: number;
  readonly largestClusterSize: number;
  readonly ambiguousLinks: number;
  readonly comparisons: number;
  /**
   * Inner pair-loop iterations across both blocking passes, whether or not the
   * iteration became a comparison. This is the quantity the documented
   * O(G·K·B²) bound describes; `comparisons` is the smaller admitted subset.
   */
  readonly pairIterations: number;
  readonly boundsReached: number;
}

/** Conditions under which the engine refuses to produce a result at all. */
export const CLUSTERING_BOUND_REJECTIONS = {
  exactDuplicateGroupExceedsLimit: 'exact_duplicate_group_exceeds_limit',
} as const;
export type ClusteringBoundRejection =
  (typeof CLUSTERING_BOUND_REJECTIONS)[keyof typeof CLUSTERING_BOUND_REJECTIONS];

/**
 * A bound the engine cannot satisfy without changing what it reports.
 *
 * The message names the fixed condition and the numeric bound only. No URL,
 * group key, identifier, token or count derived from source text appears in
 * it, so the failure can be printed and logged wherever an ordinary error can.
 */
export class ClusteringBoundError extends Error {
  readonly reason: ClusteringBoundRejection;
  readonly bound: number;

  constructor(reason: ClusteringBoundRejection, bound: number) {
    super(`clustering refused: ${reason} (maximumClusterSize=${bound})`);
    this.name = 'ClusteringBoundError';
    this.reason = reason;
    this.bound = bound;
  }
}

export interface ClusteringOutcome {
  readonly clusters: readonly IncidentCluster[];
  readonly ambiguousLinks: readonly AmbiguousLink[];
  readonly stats: ClusteringStats;
}

/** Truncates rather than rounds, so no locale or float mode can vary it. */
function truncate6(value: number): number {
  return Math.trunc(value * 1_000_000) / 1_000_000;
}

/** FNV-1a, used only to hold shingles as sorted integers for cheap intersection. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function sortedInt32(values: readonly string[]): Int32Array {
  const out = new Int32Array(values.length);
  for (let index = 0; index < values.length; index += 1) out[index] = hash32(values[index] ?? '');
  out.sort();
  return out;
}

/** Jaccard over two sorted integer arrays, by two pointers. */
function similarityOfSorted(left: Int32Array, right: Int32Array): number {
  if (left.length === 0 || right.length === 0) return 0;
  let a = 0;
  let b = 0;
  let shared = 0;
  while (a < left.length && b < right.length) {
    const x = left[a] ?? 0;
    const y = right[b] ?? 0;
    if (x === y) {
      shared += 1;
      a += 1;
      b += 1;
    } else if (x < y) a += 1;
    else b += 1;
  }
  const union = left.length + right.length - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Union-find that also carries the size of each component, so the cluster
 * bound can be tested against what a merge would actually produce rather than
 * against the two items in front of it.
 *
 * `size` is whatever the caller weighs a node by: source rows under the
 * shipped `clusterSizeUnit: 'rows'`, or one per duplicate group under
 * `duplicate-groups`. Only the root of a component carries the total.
 */
class UnionFind {
  private readonly parent: number[];
  private readonly size: number[];

  constructor(weights: readonly number[]) {
    this.parent = Array.from({ length: weights.length }, (_, index) => index);
    this.size = [...weights];
  }

  find(node: number): number {
    let root = node;
    while ((this.parent[root] ?? root) !== root) root = this.parent[root] ?? root;
    let walk = node;
    while ((this.parent[walk] ?? walk) !== walk) {
      const next = this.parent[walk] ?? walk;
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  /** Total weight of the component holding `node`. */
  componentSize(node: number): number {
    return this.size[this.find(node)] ?? 0;
  }

  /**
   * Whether joining these two components would stay inside `maximum`. Two
   * nodes already in one component always may: nothing grows. Read before
   * every `union`, which is why the bound holds over a chain of merges and not
   * only over the pair that proposed one.
   */
  canUnion(left: number, right: number, maximum: number): boolean {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return true;
    return (this.size[a] ?? 0) + (this.size[b] ?? 0) <= maximum;
  }

  /** Always attaches the higher index to the lower, so results never depend on call order. */
  union(left: number, right: number): boolean {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return false;
    const total = (this.size[a] ?? 0) + (this.size[b] ?? 0);
    if (a < b) {
      this.parent[b] = a;
      this.size[a] = total;
    } else {
      this.parent[a] = b;
      this.size[b] = total;
    }
    return true;
  }
}

interface Unit {
  readonly index: number;
  readonly key: string;
  readonly fingerprint: string;
  readonly members: ClusteringInput[];
  readonly representative: ClusteringInput;
  readonly tokens: readonly string[];
  readonly distinctive: readonly string[];
  readonly shingleHashes: Int32Array;
  readonly postedAt: number | null;
}

function representativeOf(
  members: readonly ClusteringInput[],
  contract: ClusteringContract,
): ClusteringInput {
  const byId = [...members].sort((a, b) =>
    a.sourceRowId < b.sourceRowId ? -1 : a.sourceRowId > b.sourceRowId ? 1 : 0,
  );
  if (contract.representative.rule === 'lowest-id') return byId[0] as ClusteringInput;
  let best = byId[0] as ClusteringInput;
  let bestTime = best.postedAt === null ? Number.POSITIVE_INFINITY : Date.parse(best.postedAt);
  for (const member of byId.slice(1)) {
    const time = member.postedAt === null ? Number.POSITIVE_INFINITY : Date.parse(member.postedAt);
    if (time < bestTime) {
      best = member;
      bestTime = time;
    }
  }
  return best;
}

/**
 * Builds an inverted index over a bounded number of each unit's distinctive
 * tokens, then yields bounded candidate pairs.
 *
 * Keys are chosen by the smallest token hash rather than by global rarity.
 * Rarity alone selects the tokens unique to one unit, which is exactly the set
 * that can never bring two units together; selecting by a fixed hash order
 * makes two units that share many tokens likely to share a key, in proportion
 * to how much they overlap. The document-frequency ratio still applies first,
 * so a token carried by more than that share of units is never a key, and a
 * block larger than the contract's bound is skipped as uninformative.
 */
function candidatePairs(
  units: readonly Unit[],
  contract: ClusteringContract,
  onBound: () => void,
): { pairs: [number, number][]; comparisons: number; iterations: number } {
  const blocking = contract.blocking;
  const frequency = new Map<string, number>();
  for (const unit of units) {
    for (const token of unit.distinctive) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  // A blocking key must be carried by at least two units to pair anything, so
  // the floor is 2 even when the ratio rounds below it on a small corpus.
  const maximumFrequency = Math.max(
    2,
    Math.floor(units.length * blocking.maximumDocumentFrequencyRatio),
  );
  const index = new Map<string, number[]>();
  for (const unit of units) {
    // Fixed hash order, tie-broken lexicographically, so the choice of keys
    // never depends on the order the units arrived in.
    const keys = [...unit.distinctive]
      .filter((token) => (frequency.get(token) ?? 0) <= maximumFrequency)
      .sort((a, b) => {
        const byHash = hash32(a) - hash32(b);
        return byHash !== 0 ? byHash : a < b ? -1 : a > b ? 1 : 0;
      })
      .slice(0, blocking.keysPerItem);
    for (const key of keys) {
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [unit.index]);
      else bucket.push(unit.index);
    }
  }
  const seen = new Set<string>();
  const budget = new Map<number, number>();
  const pairs: [number, number][] = [];
  let comparisons = 0;
  // Every inner-loop step, admitted or not. This is the quantity the
  // documented O(G·K·B²) bound describes, and counting it is what lets a test
  // hold the loop to that bound instead of to an asymptotic claim about C.
  let iterations = 0;
  for (const key of [...index.keys()].sort()) {
    const bucket = index.get(key) ?? [];
    if (bucket.length < 2) continue;
    if (bucket.length > blocking.maximumBlockSize) {
      onBound();
      continue;
    }
    const sorted = [...bucket].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        iterations += 1;
        const left = sorted[i] as number;
        const right = sorted[j] as number;
        const spentLeft = budget.get(left) ?? 0;
        const spentRight = budget.get(right) ?? 0;
        if (
          spentLeft >= blocking.maximumComparisonsPerItem ||
          spentRight >= blocking.maximumComparisonsPerItem
        ) {
          onBound();
          continue;
        }
        const id = `${left}:${right}`;
        if (seen.has(id)) continue;
        seen.add(id);
        budget.set(left, spentLeft + 1);
        budget.set(right, spentRight + 1);
        comparisons += 1;
        pairs.push([left, right]);
      }
    }
  }
  return { pairs, comparisons, iterations };
}

/** Groups unit indexes by their union-find component, in deterministic order. */
function componentsOf(units: readonly Unit[], sets: UnionFind): number[][] {
  const byRoot = new Map<number, number[]>();
  for (const unit of units) {
    const root = sets.find(unit.index);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [unit.index]);
    else bucket.push(unit.index);
  }
  return [...byRoot.keys()].sort((a, b) => a - b).map((root) => byRoot.get(root) ?? []);
}

export function clusterEligible(
  inputs: readonly ClusteringInput[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): ClusteringOutcome {
  assertClusteringInputs(inputs, contract);
  const eligibleDecisions = new Set(contract.eligibleDecisions);
  const eligible = [...inputs]
    .filter((input) => eligibleDecisions.has(input.decision))
    .sort((a, b) => (a.sourceRowId < b.sourceRowId ? -1 : a.sourceRowId > b.sourceRowId ? 1 : 0));
  const ineligible = inputs.length - eligible.length;
  let boundsReached = 0;
  const onBound = (): void => {
    boundsReached += 1;
  };

  // ---------------------------------------------------------------- stage 1
  // Exact URL duplicates: Sprint 2's canonical URL group decides, and a row
  // with no URL is its own group rather than being merged with other
  // URL-less rows.
  const byDuplicateKey = new Map<string, ClusteringInput[]>();
  for (const input of eligible) {
    const key = input.urlGroupId === null ? `row:${input.sourceRowId}` : `url:${input.urlGroupId}`;
    const bucket = byDuplicateKey.get(key);
    if (bucket === undefined) byDuplicateKey.set(key, [input]);
    else bucket.push(input);
  }
  const units: Unit[] = [];
  for (const key of [...byDuplicateKey.keys()].sort()) {
    const members = byDuplicateKey.get(key) ?? [];
    const representative = representativeOf(members, contract);
    const tokens = tokenize(assembleText(representative, contract), contract);
    units.push({
      index: units.length,
      key,
      fingerprint: fingerprintOf(['duplicate', key], contract),
      members,
      representative,
      tokens,
      distinctive: distinctiveTokens(tokens, contract),
      shingleHashes: sortedInt32(shingles(tokens, contract)),
      postedAt: representative.postedAt === null ? null : Date.parse(representative.postedAt),
    });
  }

  // ------------------------------------------------------- the cluster bound
  // What `maximumClusterSize` counts, per unit. Under the shipped `rows` it is
  // the source rows the unit would contribute to a cluster; under
  // `duplicate-groups` every unit weighs one.
  const maximumClusterSize = contract.bounds.maximumClusterSize;
  const rowsCounted = contract.bounds.clusterSizeUnit === 'rows';
  const unitWeights = units.map((unit) => (rowsCounted ? unit.members.length : 1));
  // Units and reports whose merge was refused by the bound. Their clusters
  // carry `cluster_bound_reached`, so a reader can tell a cluster the engine
  // stopped growing from one it simply never had a reason to grow.
  const boundRefusedUnits = new Set<number>();
  const boundRefusedReports = new Set<number>();

  // An exact-URL duplicate group is a fact rather than an inference: those
  // rows carry the same canonical URL. Splitting it would publish one report
  // as several; admitting it would publish a cluster past the declared bound.
  // The contract decides, and the shipped choice refuses the run.
  for (let index = 0; index < units.length; index += 1) {
    if ((unitWeights[index] ?? 0) <= maximumClusterSize) continue;
    if (contract.bounds.oversizedDuplicateGroupBehaviour === 'reject-run') {
      throw new ClusteringBoundError(
        CLUSTERING_BOUND_REJECTIONS.exactDuplicateGroupExceedsLimit,
        maximumClusterSize,
      );
    }
    boundRefusedUnits.add(index);
    onBound();
  }

  // ---------------------------------------------------------------- stage 2
  // Syndication: substantially identical wording behind different URLs.
  const syndicationSets = new UnionFind(unitWeights);
  const stage2 = candidatePairs(units, contract, onBound);
  let comparisons = stage2.comparisons;
  let pairIterations = stage2.iterations;
  for (const [left, right] of stage2.pairs) {
    const a = units[left] as Unit;
    const b = units[right] as Unit;
    const score = similarityOfSorted(a.shingleHashes, b.shingleHashes);
    if (score < contract.similarity.syndicationThreshold) continue;
    if (!syndicationSets.canUnion(left, right, maximumClusterSize)) {
      boundRefusedUnits.add(left);
      boundRefusedUnits.add(right);
      onBound();
      continue;
    }
    syndicationSets.union(left, right);
  }

  interface Report {
    readonly index: number;
    readonly fingerprint: string;
    readonly unitIndexes: readonly number[];
    readonly distinctive: readonly string[];
    readonly shingleHashes: Int32Array;
    readonly earliest: number | null;
    readonly latest: number | null;
  }
  const reports: Report[] = [];
  const unitToReport = new Map<number, number>();
  for (const component of componentsOf(units, syndicationSets)) {
    const ordered = [...component].sort((a, b) => a - b);
    const members = ordered.map((index) => units[index] as Unit);
    const distinctive = [...new Set(members.flatMap((unit) => [...unit.distinctive]))].sort();
    const times = members
      .map((unit) => unit.postedAt)
      .filter((value): value is number => value !== null && !Number.isNaN(value));
    const reportIndex = reports.length;
    for (const index of ordered) unitToReport.set(index, reportIndex);
    reports.push({
      index: reportIndex,
      fingerprint: fingerprintOf(
        ['syndication', ...members.map((unit) => unit.key).sort()],
        contract,
      ),
      unitIndexes: ordered,
      distinctive,
      shingleHashes: sortedInt32(
        shingles(
          members.flatMap((unit) => [...unit.tokens]),
          contract,
        ),
      ),
      earliest: times.length === 0 ? null : Math.min(...times),
      latest: times.length === 0 ? null : Math.max(...times),
    });
  }

  // ---------------------------------------------------------------- stage 3
  // Incident grouping: separate reports that plausibly describe one event.
  const reportWeights = reports.map((report) =>
    report.unitIndexes.reduce((total, index) => total + (unitWeights[index] ?? 0), 0),
  );
  const incidentSets = new UnionFind(reportWeights);
  const reportUnits: Unit[] = reports.map((report) => ({
    index: report.index,
    key: report.fingerprint,
    fingerprint: report.fingerprint,
    members: [],
    representative: (units[report.unitIndexes[0] ?? 0] as Unit).representative,
    tokens: [],
    distinctive: report.distinctive,
    shingleHashes: report.shingleHashes,
    postedAt: report.earliest,
  }));
  // Corpus-relative rarity over reports. A token shared by two reports and by
  // almost nothing else identifies a subject; one carried across the corpus is
  // background, however distinctive it looks beside the stop list.
  const reportFrequency = new Map<string, number>();
  for (const report of reports) {
    for (const token of report.distinctive) {
      reportFrequency.set(token, (reportFrequency.get(token) ?? 0) + 1);
    }
  }
  const rarityCap = Math.max(
    2,
    Math.floor(reports.length * contract.incident.rareTokenDocumentFrequencyRatio),
  );
  const sharedRareCount = (left: Report, right: Report): number => {
    const lookup = new Set(right.distinctive);
    let rare = 0;
    for (const token of left.distinctive) {
      if (!lookup.has(token)) continue;
      if ((reportFrequency.get(token) ?? 0) <= rarityCap) rare += 1;
    }
    return rare;
  };

  const stage3 = candidatePairs(reportUnits, contract, onBound);
  comparisons += stage3.comparisons;
  pairIterations += stage3.iterations;
  const ambiguousLinks: AmbiguousLink[] = [];
  const mergedByIncidentSignals = new Set<number>();
  const mergedWithTimeProximity = new Set<number>();
  const mergedWithoutTimestamp = new Set<number>();
  const window = contract.incident.timeWindowHours * 3600 * 1000;

  for (const [left, right] of stage3.pairs) {
    const a = reports[left] as Report;
    const b = reports[right] as Report;
    const shared = sharedCount(a.distinctive, b.distinctive);
    const rare = sharedRareCount(a, b);
    const score = similarityOf(a.distinctive, b.distinctive, contract);
    const enoughRare = rare >= contract.incident.minimumSharedRareTokens;
    const enoughSignals = shared >= contract.incident.minimumSharedDistinctiveTokens && enoughRare;
    const enoughSimilarity = score >= contract.similarity.incidentThreshold;
    const bothTimed = a.earliest !== null && b.earliest !== null;
    const withinWindow = bothTimed
      ? Math.abs((a.earliest ?? 0) - (b.earliest ?? 0)) <= window
      : contract.incident.missingTimestampBehaviour === 'allow';
    // The bound is read from the two components these reports currently
    // belong to, not from the pair, so a chain of individually small merges
    // cannot accumulate a component past `maximumClusterSize`.
    const withinSizeBound = incidentSets.canUnion(left, right, maximumClusterSize);
    const supported = enoughSignals && enoughSimilarity && withinWindow;

    if (supported && withinSizeBound) {
      if (incidentSets.union(left, right)) {
        mergedByIncidentSignals.add(incidentSets.find(left));
        if (bothTimed) mergedWithTimeProximity.add(incidentSets.find(left));
        else mergedWithoutTimestamp.add(incidentSets.find(left));
      }
      continue;
    }
    // Only a merge the evidence would otherwise have made is a bound. A pair
    // that was never going to merge is not one, so it is not counted as one.
    if (supported) {
      boundRefusedReports.add(left);
      boundRefusedReports.add(right);
      onBound();
      continue;
    }
    // A near miss is recorded for a human rather than merged. So is a pair
    // whose declared criteria disagree, when the contract says to record one.
    const nearSimilarity =
      score >= contract.similarity.incidentThreshold - contract.similarity.ambiguousMargin;
    const nearSignals = shared >= contract.incident.minimumSharedDistinctiveTokens - 1;
    const criteriaDisagree = enoughSimilarity !== enoughSignals || (enoughSignals && !withinWindow);
    const worthRecording =
      contract.incident.conflictingSignalBehaviour === 'ambiguous'
        ? (nearSignals && nearSimilarity) || criteriaDisagree
        : nearSignals && nearSimilarity && !criteriaDisagree;
    if (ambiguousLinks.length < contract.bounds.maximumAmbiguousLinks && worthRecording) {
      const codes: ReasonCode[] = [];
      if (enoughSignals && enoughSimilarity && !withinWindow) {
        codes.push(REASON_CODES.ambiguousOutsideTimeWindow);
      } else {
        codes.push(REASON_CODES.ambiguousBelowThreshold);
      }
      if (!bothTimed) codes.push(REASON_CODES.timestampAbsent);
      ambiguousLinks.push({
        leftFingerprint: a.fingerprint,
        rightFingerprint: b.fingerprint,
        reasonCodes: codes,
        similarity: truncate6(score),
        sharedSignals: shared,
        sharedRareSignals: rare,
      });
    } else if (ambiguousLinks.length >= contract.bounds.maximumAmbiguousLinks) {
      onBound();
    }
  }

  // ------------------------------------------------------------- assembly
  const clusters: IncidentCluster[] = [];
  for (const component of componentsOf(reportUnits, incidentSets)) {
    const ordered = [...component].sort((a, b) => a - b);
    const root = incidentSets.find(ordered[0] ?? 0);
    const componentReports = ordered.map((index) => reports[index] as Report);
    const componentUnits = componentReports.flatMap((report) =>
      report.unitIndexes.map((index) => units[index] as Unit),
    );
    const members: ClusterMember[] = [];
    for (const unit of componentUnits) {
      const syndicationFingerprint = (reports[unitToReport.get(unit.index) ?? 0] as Report)
        .fingerprint;
      for (const row of unit.members) {
        members.push({
          sourceRowId: row.sourceRowId,
          rowHash: row.rowHash,
          classificationResultId: row.classificationResultId,
          decision: row.decision,
          duplicateFingerprint: unit.fingerprint,
          syndicationFingerprint,
        });
      }
    }
    members.sort((a, b) =>
      a.sourceRowId < b.sourceRowId ? -1 : a.sourceRowId > b.sourceRowId ? 1 : 0,
    );

    const duplicateGroupCount = componentUnits.length;
    const syndicationGroupCount = componentReports.length;
    const kind: ClusterKind =
      members.length === 1
        ? 'singleton'
        : syndicationGroupCount > 1
          ? 'multi_report_incident'
          : duplicateGroupCount > 1
            ? 'syndicated_group'
            : 'duplicate_group';

    const codes: ReasonCode[] = [];
    if (members.length === 1) codes.push(REASON_CODES.singletonSource);
    if (componentUnits.some((unit) => unit.members.length > 1)) {
      codes.push(REASON_CODES.exactUrlDuplicate);
    }
    if (duplicateGroupCount > syndicationGroupCount) codes.push(REASON_CODES.syndicatedText);
    if (syndicationGroupCount > 1) {
      codes.push(REASON_CODES.sharedIncidentSignals);
      if (mergedWithTimeProximity.has(root)) codes.push(REASON_CODES.timeProximity);
      if (mergedWithoutTimestamp.has(root)) codes.push(REASON_CODES.timestampAbsent);
    }
    // A cluster the size bound stopped from growing says so, so it is not read
    // as a cluster the evidence simply never joined to anything.
    if (
      ordered.some((index) => boundRefusedReports.has(index)) ||
      componentUnits.some((unit) => boundRefusedUnits.has(unit.index))
    ) {
      codes.push(REASON_CODES.clusterBoundReached);
    }

    const representative = representativeOf(
      componentUnits.map((unit) => unit.representative),
      contract,
    );
    clusters.push({
      fingerprint: fingerprintOf(
        ['incident', ...members.map((member) => member.sourceRowId)],
        contract,
      ),
      kind,
      reasonCodes: codes,
      representativeSourceRowId: representative.sourceRowId,
      duplicateGroupCount,
      syndicationGroupCount,
      members,
    });
  }
  clusters.sort((a, b) =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
  );
  ambiguousLinks.sort((a, b) => {
    const byLeft =
      a.leftFingerprint < b.leftFingerprint ? -1 : a.leftFingerprint > b.leftFingerprint ? 1 : 0;
    if (byLeft !== 0) return byLeft;
    return a.rightFingerprint < b.rightFingerprint
      ? -1
      : a.rightFingerprint > b.rightFingerprint
        ? 1
        : 0;
  });

  return {
    clusters,
    ambiguousLinks,
    stats: {
      eligibleInputs: eligible.length,
      ineligibleInputs: ineligible,
      duplicateGroups: units.length,
      syndicationGroups: reports.length,
      incidentClusters: clusters.length,
      singletonIncidents: clusters.filter((cluster) => cluster.members.length === 1).length,
      multiSourceIncidents: clusters.filter((cluster) => cluster.members.length > 1).length,
      largestClusterSize: clusters.reduce(
        (largest, cluster) => Math.max(largest, cluster.members.length),
        0,
      ),
      ambiguousLinks: ambiguousLinks.length,
      comparisons,
      pairIterations,
      boundsReached,
    },
  };
}
