/**
 * @cas/evidence
 *
 * The Sprint 5 evidence layer (decision D25): deterministic correlation of
 * canonical incidents with Graph signals, resolution of the four evidence
 * states, and the chain-and-reporting anomaly feed. Everything here is pure:
 * no database, no network, no environment access, no model call, no clock and
 * no randomness. `@cas/worker` composes this package with `@cas/database` and
 * `@cas/graph-evidence`; this package never talks to PostgreSQL or a provider.
 *
 * It is a separate package from `@cas/clustering` on purpose. Clustering's
 * behaviour contract was audited and accepted at a fixed hash, and evidence
 * has its own contract with its own lifecycle; keeping them apart means a
 * change to one cannot move the other's identity.
 */
export {
  ANOMALY_LABEL_ORDER,
  CONTRACT_VERSION,
  CORRELATION_POLICY_VERSION,
  EVIDENCE_CONTRACT,
  EVIDENCE_MODE,
  EVIDENCE_REASON_CODES,
  RELATION_TO_RULE,
  RESOLVER_VERSION,
  canonicalContract,
  canonicalize,
  deepFreeze,
  evidenceContractHash,
  isDeepFrozen,
  type AnomalyContract,
  type CorrelationContract,
  type CorrelationMatchRule,
  type EvidenceBoundsContract,
  type EvidenceContract,
  type EvidenceReasonCode,
  type ReportingAnomalyContract,
  type ResolutionRuleContract,
} from './contract.js';
export {
  correlate,
  resolveEvidenceState,
  type AcceptedAssociation,
  type CorrelationOutcome,
  type CorrelationRejection,
  type CorrelationSuggestion,
  type EvidenceResolution,
  type IncidentSubject,
  type SignalSubject,
} from './correlate.js';
export {
  CHAIN_LIMITATION,
  REPORTING_LIMITATION,
  anomalyFeed,
  chainAnomalies,
  reportingAnomalies,
  type AnomalyEntry,
  type AnomalyFeed,
  type ChainTargetSeries,
  type ReportingWindow,
  type ValueObservation,
} from './anomaly.js';
