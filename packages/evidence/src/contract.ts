import { createHash } from 'node:crypto';

import type { AnomalyLabel, AssociationRelation, EvidenceState } from '@cas/contracts';

/**
 * The evidence layer's behaviour contract: the executable source of truth.
 *
 * Sprints 3 and 4 both had a contract rejected for describing its engine
 * instead of driving it, so the rule here is the one those audits settled on:
 * every field below is read at run time by the correlator, the resolver or the
 * anomaly calculator, and every field is paired with a test whose input is
 * chosen so that changing the field must change an observable result. A field
 * that could not be connected to execution was left out rather than hashed for
 * appearance.
 *
 * Four identity fields cannot be executed by anything: the resolver, contract
 * and policy versions, and the mode. They are the run's identity, they are
 * stored on every evidence run, and they are declared as identity rather than
 * counted as behaviour coverage.
 *
 * `resolverVersion` is the honest residue: the ordering, the iteration and the
 * arithmetic in `resolve.ts` and `anomaly.ts` cannot be expressed
 * declaratively, and it must be incremented whenever that code changes what
 * the layer returns.
 */

export const RESOLVER_VERSION = 'evidence-resolver@1';
export const CONTRACT_VERSION = 'evidence-behavior-contract@1';
export const CORRELATION_POLICY_VERSION = 'graph-correlation-policy@1';
export const EVIDENCE_MODE = 'deterministic' as const;

/** Stable machine-readable reasons. Never a source excerpt, never free text. */
export const EVIDENCE_REASON_CODES = {
  noAcceptedSignal: 'no_accepted_signal',
  signalOutsideWindow: 'signal_outside_window',
  chainMismatch: 'chain_mismatch',
  protocolNotNamed: 'protocol_not_named',
  magnitudeBelowFloor: 'magnitude_below_floor',
  relevantActivityObserved: 'relevant_activity_observed',
  claimSupported: 'claim_supported',
  claimConflicted: 'claim_conflicted',
  suggestionNotAccepted: 'suggestion_not_accepted',
  insufficientHistory: 'insufficient_history',
  observationStale: 'observation_stale',
  observationMissing: 'observation_missing',
  zeroBaseline: 'zero_baseline',
  boundReached: 'bound_reached',
} as const;
export type EvidenceReasonCode = (typeof EVIDENCE_REASON_CODES)[keyof typeof EVIDENCE_REASON_CODES];

/**
 * How an incident may be matched to a Graph signal.
 *
 * `explicit_chain_and_protocol` is the only admitted mechanism: the incident
 * must carry an explicitly recorded chain and protocol identity, and it must
 * equal the signal's provider-returned identity. Text is never consulted, so
 * an incident cannot acquire on-chain evidence because a headline says "hack".
 */
export type CorrelationMatchRule = 'explicit_chain_and_protocol';

export interface CorrelationContract {
  readonly matchRule: CorrelationMatchRule;
  /** Signal observed at most this many hours before the incident's earliest report. */
  readonly windowBeforeHours: number;
  /** Signal observed at most this many hours after it. */
  readonly windowAfterHours: number;
  /**
   * Absolute percentage movement a signal must reach before it is material
   * enough to suggest at all. Below it the pair is not linked and the reason
   * is recorded.
   */
  readonly minimumAbsoluteDeltaPercent: number;
  /**
   * Whether a machine suggestion is evidence on its own. `false` means an
   * association counts only once a human accepts it, which is the shipped
   * value and the reason a signal cannot quietly promote a report.
   */
  readonly suggestionIsEvidence: boolean;
  /** Most suggestions one correlation run may emit. */
  readonly maximumSuggestions: number;
}

/**
 * One ordered resolution rule. The first rule whose condition holds decides
 * the evidence state, so reordering the list changes the outcome.
 */
export interface ResolutionRuleContract {
  readonly id: string;
  /** Condition the resolver implements. */
  readonly when:
    | 'accepted_conflicting_association'
    | 'accepted_supporting_association'
    | 'accepted_context_association'
    | 'always';
  readonly state: EvidenceState;
  readonly reason: EvidenceReasonCode;
}

export interface AnomalyContract {
  /** Nominal hours between consecutive observations of one target. */
  readonly observationIntervalHours: number;
  /** Baseline observations required before any label but `insufficient_history`. */
  readonly minimumBaselineObservations: number;
  /**
   * `median-absolute-deviation` is robust to the single spike it is meant to
   * find; `mean-standard-deviation` is not, and is offered so the choice is
   * visible and testable rather than implicit.
   */
  readonly baselineMethod: 'median-absolute-deviation' | 'mean-standard-deviation';
  /** Deviations from the baseline centre before a movement is a spike. */
  readonly thresholdDeviations: number;
  /** Floor below which a movement is never a spike, whatever the baseline says. */
  readonly minimumAbsoluteDeltaPercent: number;
  /** What to do when the baseline spread is zero. */
  readonly zeroDenominatorBehaviour: 'absolute-threshold-only' | 'insufficient_history';
  /** What a gap in the observation series produces. */
  readonly missingObservationBehaviour: 'missing_observation' | 'skip';
  /** An observation older than this is stale and is never labelled a spike. */
  readonly freshnessLimitHours: number;
  /** Most observations read per target, and most entries emitted. */
  readonly maximumObservationsPerTarget: number;
  readonly maximumFeedEntries: number;
}

export interface ReportingAnomalyContract {
  /** Minimum prior windows required before a reporting window can be a spike. */
  readonly minimumBaselineWindows: number;
  readonly baselineMethod: 'median-absolute-deviation' | 'mean-standard-deviation';
  readonly thresholdDeviations: number;
  /** Stories per incident at or above which concentration is called out. */
  readonly storiesPerIncidentThreshold: number;
  /** Share of incidents that must be multi-source before concentration is flagged. */
  readonly multiSourceConcentrationThreshold: number;
  readonly zeroDenominatorBehaviour: 'absolute-threshold-only' | 'insufficient_history';
}

export interface EvidenceBoundsContract {
  readonly maximumIncidentsPerRun: number;
  readonly maximumSignalsPerRun: number;
  readonly maximumClaimsPerIncident: number;
  /** Longest human note or rationale any evidence action may carry. */
  readonly maximumRationaleCharacters: number;
}

export interface EvidenceContract {
  // Identity. Not executable, deliberately hashed, stored on every run.
  readonly resolverVersion: string;
  readonly contractVersion: string;
  readonly correlationPolicyVersion: string;
  readonly mode: 'deterministic';
  // Behaviour. Every field below is read at run time.
  readonly correlation: CorrelationContract;
  /** Walked in order; the first matching rule decides. Array order is precedence. */
  readonly resolutionRules: readonly ResolutionRuleContract[];
  readonly anomaly: AnomalyContract;
  readonly reportingAnomaly: ReportingAnomalyContract;
  readonly bounds: EvidenceBoundsContract;
}

const CONTRACT: EvidenceContract = {
  resolverVersion: RESOLVER_VERSION,
  contractVersion: CONTRACT_VERSION,
  correlationPolicyVersion: CORRELATION_POLICY_VERSION,
  mode: EVIDENCE_MODE,
  correlation: {
    matchRule: 'explicit_chain_and_protocol',
    windowBeforeHours: 48,
    windowAfterHours: 72,
    minimumAbsoluteDeltaPercent: 5,
    suggestionIsEvidence: false,
    maximumSuggestions: 500,
  },
  resolutionRules: [
    {
      id: 'conflicting_evidence',
      when: 'accepted_conflicting_association',
      state: 'contradicted',
      reason: EVIDENCE_REASON_CODES.claimConflicted,
    },
    {
      id: 'supporting_evidence',
      when: 'accepted_supporting_association',
      state: 'corroborated',
      reason: EVIDENCE_REASON_CODES.claimSupported,
    },
    {
      id: 'relevant_activity',
      when: 'accepted_context_association',
      state: 'onchain_observed',
      reason: EVIDENCE_REASON_CODES.relevantActivityObserved,
    },
    {
      id: 'reporting_only',
      when: 'always',
      state: 'reported_only',
      reason: EVIDENCE_REASON_CODES.noAcceptedSignal,
    },
  ],
  anomaly: {
    observationIntervalHours: 24,
    minimumBaselineObservations: 7,
    baselineMethod: 'median-absolute-deviation',
    thresholdDeviations: 4,
    minimumAbsoluteDeltaPercent: 5,
    zeroDenominatorBehaviour: 'absolute-threshold-only',
    missingObservationBehaviour: 'missing_observation',
    freshnessLimitHours: 36,
    maximumObservationsPerTarget: 400,
    maximumFeedEntries: 500,
  },
  reportingAnomaly: {
    minimumBaselineWindows: 3,
    baselineMethod: 'median-absolute-deviation',
    thresholdDeviations: 3,
    storiesPerIncidentThreshold: 3,
    multiSourceConcentrationThreshold: 0.25,
    zeroDenominatorBehaviour: 'absolute-threshold-only',
  },
  bounds: {
    maximumIncidentsPerRun: 100000,
    maximumSignalsPerRun: 10000,
    maximumClaimsPerIncident: 50,
    maximumRationaleCharacters: 280,
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

export const EVIDENCE_CONTRACT: EvidenceContract = deepFreeze(CONTRACT);

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

export function canonicalContract(contract: EvidenceContract = EVIDENCE_CONTRACT): string {
  return canonicalize(contract);
}

export function evidenceContractHash(contract: EvidenceContract = EVIDENCE_CONTRACT): string {
  return createHash('sha256').update(canonicalContract(contract), 'utf8').digest('hex');
}

/** The relation an accepted association asserts, as the resolver reads it. */
export const RELATION_TO_RULE: Readonly<
  Record<AssociationRelation, ResolutionRuleContract['when']>
> = {
  conflicts: 'accepted_conflicting_association',
  supports: 'accepted_supporting_association',
  context: 'accepted_context_association',
};

/** Anomaly labels the calculator may emit, for exhaustiveness checks. */
export const ANOMALY_LABEL_ORDER: readonly AnomalyLabel[] = [
  'positive_spike',
  'negative_spike',
  'stale_observation',
  'missing_observation',
  'insufficient_history',
  'normal',
];
