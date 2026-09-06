/**
 * @cas/graph-evidence
 *
 * Sprint 1 live proof: one common standardized query, one response adapter,
 * a minimal gateway client, a deterministic TVL-delta calculation and an
 * executable gate that validates provider-returned identity against the
 * registry's declared expectations. Live results carry `DataOrigin` `live`
 * and complete query provenance. There is no fixture or replay path in this
 * package.
 */
export {
  adaptStandardizedTvl,
  type AdapterContext,
  type StandardizedTvlReading,
} from './adapter.js';
export {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  GraphGatewayClient,
  type FetchLike,
  type GraphGatewayClientOptions,
  type StandardizedTvlRequest,
} from './client.js';
export {
  BASE_GATE_MINIMUM_PROTOCOLS,
  BASE_LENDING_TARGETS,
  ETHEREUM_GATE_MINIMUM_PROTOCOLS,
  ETHEREUM_LENDING_TARGETS,
  type DeploymentTarget,
} from './deployments.js';
export {
  GRAPH_PROBE_FAILURE_KINDS,
  GraphProbeError,
  isGraphProbeError,
  type GraphProbeFailureKind,
} from './errors.js';
export {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  FRESHNESS_LIMIT_SECONDS,
  evaluateFreshness,
  type FreshnessResult,
} from './freshness.js';
export {
  assertUniqueTargets,
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  validateLiveIdentity,
  type ChainGateOptions,
  type ChainGateResult,
  type IdentityMismatch,
  type TargetEvaluation,
  type TargetExpectations,
} from './gate.js';
export {
  OFFICIAL_GATEWAY_HOST,
  parseGatewayBaseUrl,
  type ParsedGatewayBase,
} from './gateway-url.js';
export { NETWORK_ALIASES, normalizeNetwork } from './network.js';
export {
  formatEvaluation,
  formatGate,
  runProbe,
  type ProbeOptions,
  type ProbeRun,
} from './probe.js';
export { DEFAULT_SNAPSHOT_COUNT, STANDARDIZED_TVL_QUERY, queryDocumentSha256 } from './query.js';
export { REDACTED, createRedactor, type Redactor } from './redact.js';
export {
  DEFAULT_WINDOW,
  PERCENT_FRACTION_DIGITS,
  calculateTvlDelta,
  describeElapsed,
  type TvlDeltaInput,
} from './tvl-delta.js';
