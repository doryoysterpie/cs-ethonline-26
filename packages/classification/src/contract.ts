import { createHash } from 'node:crypto';

import {
  canonicalSignalPolicy,
  CLASSIFICATION_SIGNAL_POLICY_VERSION,
  CVE_IDENTIFIER_PATTERN,
  POLICY_THRESHOLDS,
  SIGNAL_WEIGHTS,
} from '@cas/taxonomy';

/**
 * The classifier's behaviour contract.
 *
 * Codex Desktop's Sprint 3 audit found that the previous ruleset hash covered
 * only version strings and the signal policy, so a material implementation
 * change could keep the same stored hash. This module fixes that: every
 * behaviour-affecting parameter is declared here, the executable classifier
 * reads its values from here rather than from duplicated constants, and the
 * hash covers the whole document.
 *
 * What a version string can still hide is the *engine*: the code that builds
 * the matching expression and walks the rules. `engineVersion` stands for
 * exactly that residue and must be incremented whenever `classifier.ts`
 * changes behaviour in a way the declarations below cannot express. That
 * limitation is deliberate, minimal and recorded in the Sprint 3 report.
 */

export const CLASSIFIER_VERSION = 'rules-classifier@2';
export const RULESET_VERSION = 'classification-behavior-contract@1';
export const CLASSIFIER_MODE = 'rules' as const;

/**
 * Incremented whenever the matching or rule-walking code in `classifier.ts`
 * changes behaviour that the declarative fields cannot capture, for example
 * how the alternation is built or how matches are de-duplicated.
 */
export const ENGINE_VERSION = 'classification-engine@1';

/** Stable rationale codes. The contract maps every outcome to one of these. */
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

/** The six fields the classifier may read, in the order the text is assembled. */
export const INPUT_FIELD_ORDER = [
  'normalizedTitle',
  'derivedSummaryText',
  'derivedDescriptionText',
] as const;
export type InputTextField = (typeof INPUT_FIELD_ORDER)[number];

export const ALLOWED_INPUT_KEYS = [
  'sourceRowId',
  'rowHash',
  'status',
  'normalizedTitle',
  'derivedSummaryText',
  'derivedDescriptionText',
] as const;
export type AllowedInputKey = (typeof ALLOWED_INPUT_KEYS)[number];

export interface TextAssemblyContract {
  readonly version: string;
  /** Fields concatenated in this order. Order is behaviour: it is preserved in the hash. */
  readonly fieldOrder: readonly InputTextField[];
  /** Inserted between fields so a phrase cannot form across a boundary. */
  readonly fieldSeparator: string;
  /** What an absent field contributes. */
  readonly nullHandling: string;
  /** What a field that normalizes to the empty string contributes. */
  readonly emptyHandling: string;
  readonly unicodeNormalizationForm: 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
  readonly caseNormalization: string;
  readonly whitespaceNormalization: string;
  /** `null` means no truncation: the complete normalized fields are evaluated. */
  readonly maxInputCharacters: number | null;
  readonly truncation: string;
}

export interface MatchingContract {
  readonly wordBoundary: string;
  readonly boundaryCharacterClass: string;
  readonly termOrdering: string;
  readonly duplicateHandling: string;
  readonly caseSensitive: boolean;
  readonly patternSignals: readonly { readonly id: string; readonly pattern: string }[];
}

export interface DecisionRuleContract {
  readonly order: number;
  readonly id: string;
  readonly when: string;
  readonly decision: 'include' | 'exclude' | 'review';
  readonly rationaleCodes: readonly RationaleCode[];
}

export interface ScoringContract {
  readonly formula: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly minimum: number;
  /** `null` means no fixed upper bound: the score grows with the distinct signal count. */
  readonly maximum: number | null;
  readonly quarantinedScore: number;
  readonly textAbsentScore: number;
}

export interface BehaviorContract {
  readonly classifierVersion: string;
  readonly rulesetVersion: string;
  readonly mode: 'rules';
  readonly engineVersion: string;
  readonly policyVersion: string;
  readonly allowedInputKeys: readonly AllowedInputKey[];
  readonly textAssembly: TextAssemblyContract;
  readonly matching: MatchingContract;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly decisionRules: readonly DecisionRuleContract[];
  readonly rationaleCodes: Readonly<Record<string, string>>;
  readonly scoring: ScoringContract;
  /** The signal policy, parsed from its own canonical form so it is covered here too. */
  readonly signalPolicy: unknown;
}

export const BEHAVIOR_CONTRACT: BehaviorContract = {
  classifierVersion: CLASSIFIER_VERSION,
  rulesetVersion: RULESET_VERSION,
  mode: CLASSIFIER_MODE,
  engineVersion: ENGINE_VERSION,
  policyVersion: CLASSIFICATION_SIGNAL_POLICY_VERSION,
  allowedInputKeys: ALLOWED_INPUT_KEYS,
  textAssembly: {
    version: 'classification-text-assembly@2',
    fieldOrder: INPUT_FIELD_ORDER,
    fieldSeparator: '\n',
    nullHandling: 'skip',
    emptyHandling: 'skip',
    unicodeNormalizationForm: 'NFC',
    caseNormalization: 'locale-independent-lowercase',
    whitespaceNormalization: 'collapse-runs-to-single-space-and-trim',
    maxInputCharacters: null,
    truncation: 'none',
  },
  matching: {
    wordBoundary: 'unicode-letter-or-number-lookaround',
    boundaryCharacterClass: '\\p{L}\\p{N}',
    termOrdering: 'longest-first-then-lexicographic',
    duplicateHandling: 'distinct-signal-identifiers',
    caseSensitive: false,
    patternSignals: [{ id: 'cve_identifier', pattern: CVE_IDENTIFIER_PATTERN }],
  },
  thresholds: {
    decisiveHitsForInclude: POLICY_THRESHOLDS.decisiveHitsForInclude,
    distinctContextualHitsForInclude: POLICY_THRESHOLDS.distinctContextualHitsForInclude,
    outOfScopeHitsForExclude: 1,
  },
  decisionRules: [
    {
      order: 1,
      id: 'quarantined_row',
      when: 'status == quarantined',
      decision: 'review',
      rationaleCodes: [RATIONALE_CODES.rowQuarantined],
    },
    {
      order: 2,
      id: 'no_usable_text',
      when: 'assembled text is empty',
      decision: 'review',
      rationaleCodes: [RATIONALE_CODES.textAbsent],
    },
    {
      order: 3,
      id: 'in_scope_conflicting',
      when: 'in scope AND out_of_scope hits >= outOfScopeHitsForExclude',
      decision: 'review',
      // The first two always fire; the in-scope codes fire with whichever side
      // of the conflict was met, so the reviewer sees the evidence, not only
      // that a conflict existed.
      rationaleCodes: [
        RATIONALE_CODES.outOfScopeSignal,
        RATIONALE_CODES.signalsConflicting,
        RATIONALE_CODES.decisiveSignal,
        RATIONALE_CODES.contextualSignals,
      ],
    },
    {
      order: 4,
      id: 'in_scope',
      when: 'decisive hits >= decisiveHitsForInclude OR contextual hits >= distinctContextualHitsForInclude',
      decision: 'include',
      rationaleCodes: [RATIONALE_CODES.decisiveSignal, RATIONALE_CODES.contextualSignals],
    },
    {
      order: 5,
      id: 'out_of_scope_only',
      when: 'out_of_scope hits >= outOfScopeHitsForExclude AND decisive hits == 0 AND contextual hits == 0',
      decision: 'exclude',
      rationaleCodes: [RATIONALE_CODES.outOfScopeSignal, RATIONALE_CODES.noSignalMatch],
    },
    {
      order: 6,
      id: 'otherwise',
      when: 'no earlier rule applied',
      decision: 'review',
      rationaleCodes: [
        RATIONALE_CODES.contextualSignalSingle,
        RATIONALE_CODES.outOfScopeSignal,
        RATIONALE_CODES.noSignalMatch,
      ],
    },
  ],
  rationaleCodes: RATIONALE_CODES,
  scoring: {
    formula: 'sum(distinct-signals-per-tier * tier-weight)',
    weights: SIGNAL_WEIGHTS,
    minimum: 0,
    maximum: null,
    quarantinedScore: 0,
    textAbsentScore: 0,
  },
  signalPolicy: JSON.parse(canonicalSignalPolicy()) as unknown,
};

/**
 * Deterministic canonical serialization: object keys sorted, array order
 * preserved because order is behaviour, `null` distinguished from absent, and
 * numbers and strings kept as their own types. No locale-dependent
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
