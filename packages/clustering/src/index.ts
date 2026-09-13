/**
 * @cas/clustering
 *
 * The Sprint 4 deterministic clustering engine (decision D22): exact URL
 * duplicate consolidation, syndication detection and conservative incident
 * grouping, driven by a versioned executable contract. Everything here is
 * pure: no database, no network, no environment access, no model call, no
 * clock and no randomness. `@cas/worker` composes this package with
 * `@cas/database`; this package never talks to PostgreSQL.
 */

export {
  ALLOWED_INPUT_KEYS,
  canonicalContract,
  canonicalize,
  CLUSTERING_CONTRACT,
  CLUSTERING_MODE,
  contractHash,
  CONTRACT_VERSION,
  deepFreeze,
  ENGINE_VERSION,
  isDeepFrozen,
  REASON_CODES,
  type BlockingContract,
  type BoundsContract,
  type ClusteringContract,
  type FingerprintContract,
  type IncidentContract,
  type InputFieldContract,
  type InputFieldKind,
  type ReasonCode,
  type RepresentativeContract,
  type SimilarityContract,
  type TextAssemblyContract,
  type TokenizationContract,
} from './contract.js';
export {
  assertClusteringInput,
  assertClusteringInputs,
  CLUSTERING_INPUT_REJECTIONS,
  ClusteringInputError,
  type ClusteringInput,
  type ClusteringInputRejection,
} from './input.js';
export {
  assembleText,
  distinctiveTokens,
  fingerprintOf,
  normalizeForMatching,
  sharedCount,
  shingles,
  similarityOf,
  tokenize,
} from './text.js';
export {
  CLUSTERING_BOUND_REJECTIONS,
  ClusteringBoundError,
  clusterEligible,
  type AmbiguousLink,
  type ClusteringBoundRejection,
  type ClusteringOutcome,
  type ClusteringStats,
  type ClusterKind,
  type ClusterMember,
  type IncidentCluster,
} from './engine.js';
