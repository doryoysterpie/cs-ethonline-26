import { createHash } from 'node:crypto';

import type { ClassificationDecision } from '@cas/contracts';
import { CYBERATTACK_POLICY, type CategoryPolicy, type SignalTier } from '@cas/taxonomy';

/**
 * The classifier's behaviour contract: the executable source of truth.
 *
 * Codex Desktop's re-audit found the previous contract only partly
 * executable. Reversing `decisionRules`, rewriting a rationale mapping,
 * setting `scoring.maximum` to zero and emptying `allowedInputKeys` each
 * changed the stored hash while the compiled classifier returned exactly the
 * same decision, codes and score, because the engine hard-coded its
 * precedence, imported the taxonomy directly and cached its matchers from the
 * default contract. A hash that moves without behaviour is worse than no
 * hash: it invents run identities that mean nothing.
 *
 * Every field below is now read by `classify(input, contract)` at run time.
 * Fields that could not be connected to execution were removed rather than
 * kept for appearance: the prose descriptions of the word-boundary rule, the
 * duplicate-handling rule, the truncation rule, the scoring formula and the
 * text-assembly version string are all gone, and the separate signal-policy
 * blob is gone because the policy itself is now inline and executed.
 *
 * Five identity fields remain that no engine can execute: the classifier,
 * ruleset, engine and policy versions, and the mode. They are deliberately
 * hashed. They are the run's identity, they are stored on every run, and they
 * are what a reviewer uses to tell two runs apart. They are declared together
 * below and named as identity, not as behaviour.
 *
 * `engineVersion` is the honest residue: the code in `classifier.ts` that
 * builds the alternation, de-duplicates matches and sorts the matched signal
 * identifiers cannot be expressed declaratively. It must be incremented
 * whenever that code changes what the classifier returns.
 */

export const CLASSIFIER_VERSION = 'rules-classifier@3';
export const RULESET_VERSION = 'classification-behavior-contract@2';
export const CLASSIFIER_MODE = 'rules' as const;
export const ENGINE_VERSION = 'classification-engine@2';

/** Stable rationale codes. Every code a rule may emit comes from this set. */
export const RATIONALE_CODES = {
  rowQuarantined: 'row_quarantined',
  textAbsent: 'text_absent',
  decisiveSignal: 'decisive_signal',
  contextualSignals: 'contextual_signals',
  contextualSignalSingle: 'contextual_signal_single',
  outOfScopeSignal: 'out_of_scope_signal',
  signalsConflicting: 'signals_conflicting',
  noSignalMatch: 'no_signal_match',
} as const;
export type RationaleCode = (typeof RATIONALE_CODES)[keyof typeof RATIONALE_CODES];

/** How the boundary validates one admitted field's runtime value. */
export type InputFieldKind = 'identifier' | 'status' | 'text';

export interface InputFieldContract {
  readonly key: string;
  readonly kind: InputFieldKind;
}

/**
 * The exact set of own keys an input may carry, with the shape each must
 * have. The boundary admits these and nothing else, so emptying or editing
 * this list changes what the classifier accepts.
 */
export const ALLOWED_INPUT_KEYS: readonly InputFieldContract[] = [
  { key: 'sourceRowId', kind: 'identifier' },
  { key: 'rowHash', kind: 'identifier' },
  { key: 'status', kind: 'status' },
  { key: 'normalizedTitle', kind: 'text' },
  { key: 'derivedSummaryText', kind: 'text' },
  { key: 'derivedDescriptionText', kind: 'text' },
];

export const INPUT_FIELD_ORDER = [
  'normalizedTitle',
  'derivedSummaryText',
  'derivedDescriptionText',
] as const;

export interface TextAssemblyContract {
  /** Fields concatenated in this order. Order changes what phrases can form. */
  readonly fieldOrder: readonly string[];
  /** Inserted between fields so a phrase cannot form across a boundary. */
  readonly fieldSeparator: string;
  /** `skip` omits an absent field; `empty` contributes an empty part. */
  readonly nullHandling: 'skip' | 'empty';
  /** `skip` omits a field that normalizes to nothing; `keep` retains it. */
  readonly emptyHandling: 'skip' | 'keep';
  readonly unicodeNormalizationForm: 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
  readonly caseNormalization: 'lowercase' | 'none';
  readonly whitespaceNormalization: 'collapse' | 'none';
  /** `null` evaluates the whole text; a number truncates to that many characters. */
  readonly maxInputCharacters: number | null;
}

export interface TermSignalContract {
  readonly id: string;
  readonly tier: SignalTier;
  /** Whole-word phrases, matched literally. */
  readonly terms: readonly string[];
}

export interface PatternSignalContract {
  readonly id: string;
  readonly tier: SignalTier;
  /** A regular-expression body, wrapped in the contract's boundary class. */
  readonly pattern: string;
}

export interface MatchingContract {
  /** Character class used for the boundary lookarounds around every term. */
  readonly boundaryCharacterClass: string;
  readonly termOrdering: 'longest-first-then-lexicographic' | 'declaration-order';
  readonly caseSensitive: boolean;
  /** The taxonomy the classifier executes. There is no other source. */
  readonly termSignals: readonly TermSignalContract[];
  readonly patternSignals: readonly PatternSignalContract[];
}

export interface ThresholdsContract {
  readonly decisiveHitsForInclude: number;
  readonly distinctContextualHitsForInclude: number;
  readonly outOfScopeHitsForExclude: number;
}

/** Conditions a rule may test. Each is implemented by the engine. */
export type RulePredicate =
  | 'status_quarantined'
  | 'text_absent'
  | 'in_scope_and_out_of_scope'
  | 'in_scope'
  | 'out_of_scope_without_in_scope'
  | 'always';

/** Conditions under which a rule emits one of its rationale codes. */
export type EmitCondition =
  | 'always'
  | 'decisive_threshold_met'
  | 'contextual_threshold_met'
  | 'single_contextual_signal'
  | 'any_out_of_scope_signal'
  | 'no_other_code_emitted';

export interface RationaleEmission {
  readonly code: RationaleCode;
  readonly when: EmitCondition;
}

export interface DecisionRuleContract {
  readonly id: string;
  readonly when: RulePredicate;
  readonly decision: ClassificationDecision;
  /**
   * Emitted in this order when their conditions hold. The order is behaviour:
   * the stored rationale array is the emission order, not a sorted copy.
   */
  readonly emit: readonly RationaleEmission[];
  /** `computed` scores from the matched signals; a number is used verbatim. */
  readonly score: 'computed' | number;
}

export interface ScoringContract {
  /** Weight per tier, multiplied by the count of distinct signals in it. */
  readonly weights: Readonly<Record<SignalTier, number>>;
  readonly minimum: number;
  /** `null` leaves the score unbounded above; a number clamps it. */
  readonly maximum: number | null;
}

export interface BehaviorContract {
  // Identity. Not executable, deliberately hashed, stored on every run.
  readonly classifierVersion: string;
  readonly rulesetVersion: string;
  readonly engineVersion: string;
  readonly policyVersion: string;
  readonly mode: 'rules';
  // Behaviour. Every field below is read by `classify` at run time.
  readonly allowedInputKeys: readonly InputFieldContract[];
  readonly textAssembly: TextAssemblyContract;
  readonly matching: MatchingContract;
  readonly thresholds: ThresholdsContract;
  /** Walked in this order. Array order is precedence. */
  readonly decisionRules: readonly DecisionRuleContract[];
  readonly scoring: ScoringContract;
}

/** The signal policy, carried inline so the engine has no second source. */
/** Shared by every category: how a row's text is assembled before matching. */
const TEXT_ASSEMBLY: TextAssemblyContract = {
  fieldOrder: INPUT_FIELD_ORDER,
  fieldSeparator: '\n',
  nullHandling: 'skip',
  emptyHandling: 'skip',
  unicodeNormalizationForm: 'NFC',
  caseNormalization: 'lowercase',
  whitespaceNormalization: 'collapse',
  maxInputCharacters: null,
};

/** Shared by every category: the decision rules, in precedence order. */
const DECISION_RULES: readonly DecisionRuleContract[] = [
  {
    id: 'quarantined_row',
    when: 'status_quarantined',
    decision: 'review',
    emit: [{ code: RATIONALE_CODES.rowQuarantined, when: 'always' }],
    score: 0,
  },
  {
    id: 'no_usable_text',
    when: 'text_absent',
    decision: 'review',
    emit: [{ code: RATIONALE_CODES.textAbsent, when: 'always' }],
    score: 0,
  },
  {
    id: 'in_scope_conflicting',
    when: 'in_scope_and_out_of_scope',
    decision: 'review',
    emit: [
      { code: RATIONALE_CODES.outOfScopeSignal, when: 'always' },
      { code: RATIONALE_CODES.signalsConflicting, when: 'always' },
      { code: RATIONALE_CODES.decisiveSignal, when: 'decisive_threshold_met' },
      { code: RATIONALE_CODES.contextualSignals, when: 'contextual_threshold_met' },
    ],
    score: 'computed',
  },
  {
    id: 'in_scope',
    when: 'in_scope',
    decision: 'include',
    emit: [
      { code: RATIONALE_CODES.decisiveSignal, when: 'decisive_threshold_met' },
      { code: RATIONALE_CODES.contextualSignals, when: 'contextual_threshold_met' },
    ],
    score: 'computed',
  },
  {
    id: 'out_of_scope_only',
    when: 'out_of_scope_without_in_scope',
    decision: 'exclude',
    emit: [
      { code: RATIONALE_CODES.outOfScopeSignal, when: 'always' },
      { code: RATIONALE_CODES.noSignalMatch, when: 'always' },
    ],
    score: 'computed',
  },
  {
    id: 'otherwise',
    when: 'always',
    decision: 'review',
    emit: [
      { code: RATIONALE_CODES.contextualSignalSingle, when: 'single_contextual_signal' },
      { code: RATIONALE_CODES.outOfScopeSignal, when: 'any_out_of_scope_signal' },
      { code: RATIONALE_CODES.noSignalMatch, when: 'no_other_code_emitted' },
    ],
    score: 'computed',
  },
];

function termSignalsOf(policy: CategoryPolicy): readonly TermSignalContract[] {
  return policy.signals
    .map((signal) => ({
      id: signal.id,
      tier: signal.tier,
      terms: [...signal.terms].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Builds the executable contract for one category policy (CAS-002). The
 * engine, the input allowlist, the text assembly, the matching rules and the
 * decision rules are the same for every category; the policy supplies the
 * vocabulary, the pattern signals, the thresholds and the weights. Built for
 * the cyberattack policy this reproduces the contract Sprint 3 shipped,
 * hash for hash, which a test asserts.
 */
export function buildContract(policy: CategoryPolicy): BehaviorContract {
  return deepFreeze(contractFromPolicy(policy));
}

function contractFromPolicy(policy: CategoryPolicy): BehaviorContract {
  return {
    classifierVersion: CLASSIFIER_VERSION,
    rulesetVersion: RULESET_VERSION,
    engineVersion: ENGINE_VERSION,
    policyVersion: policy.policyVersion,
    mode: CLASSIFIER_MODE,
    allowedInputKeys: ALLOWED_INPUT_KEYS,
    textAssembly: TEXT_ASSEMBLY,
    matching: {
      boundaryCharacterClass: '\\p{L}\\p{N}',
      termOrdering: 'longest-first-then-lexicographic',
      caseSensitive: false,
      termSignals: termSignalsOf(policy),
      patternSignals: policy.patternSignals.map((signal) => ({
        id: signal.id,
        tier: signal.tier,
        pattern: signal.pattern,
      })),
    },
    thresholds: {
      decisiveHitsForInclude: policy.thresholds.decisiveHitsForInclude,
      distinctContextualHitsForInclude: policy.thresholds.distinctContextualHitsForInclude,
      outOfScopeHitsForExclude: 1,
    },
    decisionRules: DECISION_RULES,
    scoring: {
      weights: policy.weights,
      minimum: 0,
      maximum: null,
    },
  };
}

const CONTRACT: BehaviorContract = contractFromPolicy(CYBERATTACK_POLICY);

/**
 * Freezes an object and everything reachable from it.
 *
 * The production contract is frozen because the matcher cache keys on object
 * identity: a contract that could be edited after its matchers were built
 * would keep returning matchers for the version it no longer describes.
 */
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

export const BEHAVIOR_CONTRACT: BehaviorContract = deepFreeze(CONTRACT);

/**
 * Deterministic canonical serialization: object keys sorted, array order
 * preserved because array order is behaviour, `null` distinguished from
 * absent, and numbers and strings kept as their own types. No locale-dependent
 * formatting is used, so the result is identical on any machine.
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

export function canonicalRuleset(contract: BehaviorContract = BEHAVIOR_CONTRACT): string {
  return canonicalize(contract);
}

export function rulesetHash(contract: BehaviorContract = BEHAVIOR_CONTRACT): string {
  return createHash('sha256').update(canonicalRuleset(contract), 'utf8').digest('hex');
}
