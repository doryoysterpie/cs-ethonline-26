import { createHash } from 'node:crypto';

import type { ClassificationDecision } from '@cas/contracts';
import {
  canonicalSignalPolicy,
  CLASSIFICATION_SIGNAL_POLICY_VERSION,
  CLASSIFICATION_SIGNALS,
  CVE_IDENTIFIER_PATTERN,
  CVE_SIGNAL_ID,
  POLICY_THRESHOLDS,
  SIGNAL_WEIGHTS,
  type SignalTier,
} from '@cas/taxonomy';

import { assertClassificationInput, type ClassificationInput } from './input.js';
import { assembleText, TEXT_ASSEMBLY_VERSION } from './text.js';

/**
 * The Sprint 3 high-recall classifier (decision D21).
 *
 * Pure and deterministic by construction: no database, no network, no
 * environment variable, no model call, no clock, no randomness and no human
 * label. The same input always yields the same decision, rationale codes,
 * matched signals and score, on any machine.
 *
 * Recall posture: uncertainty routes to `review`. A source is excluded only
 * when the text carries explicit out-of-scope vocabulary and no security
 * signal of any tier matched.
 */
export const CLASSIFIER_VERSION = 'rules-classifier@1';
export const CLASSIFIER_MODE = 'rules' as const;

/**
 * Stable rationale codes. Results store these, never a source excerpt.
 */
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

export interface ClassificationResult {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly decision: ClassificationDecision;
  /** Fixed vocabulary, sorted, never source text. */
  readonly rationaleCodes: readonly RationaleCode[];
  /** Policy signal identifiers that matched, sorted. Never source text. */
  readonly matchedSignals: readonly string[];
  /** Deterministic weighted count of distinct matched signals. Not a probability. */
  readonly signalScore: number;
}

interface TierMatch {
  readonly decisive: readonly string[];
  readonly contextual: readonly string[];
  readonly outOfScope: readonly string[];
}

/** Escapes a term so it is matched literally; policy terms carry no regex syntax. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * One alternation per tier, longest term first so that a longer phrase wins
 * over a shorter one that prefixes it. Unicode-aware lookarounds give whole
 * word matching without relying on `\b`, which treats non-ASCII letters as
 * boundaries.
 */
function buildTierMatcher(tier: SignalTier): {
  regex: RegExp;
  byTerm: ReadonlyMap<string, string>;
} {
  const byTerm = new Map<string, string>();
  for (const signal of CLASSIFICATION_SIGNALS) {
    if (signal.tier !== tier) continue;
    for (const term of signal.terms) byTerm.set(term, signal.id);
  }
  const terms = [...byTerm.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const alternation = terms.map(escapeTerm).join('|');
  const source =
    terms.length === 0 ? '(?!)' : `(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`;
  return { regex: new RegExp(source, 'gu'), byTerm };
}

const DECISIVE_MATCHER = buildTierMatcher('decisive');
const CONTEXTUAL_MATCHER = buildTierMatcher('contextual');
const OUT_OF_SCOPE_MATCHER = buildTierMatcher('out_of_scope');
const CVE_REGEX = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CVE_IDENTIFIER_PATTERN})(?![\\p{L}\\p{N}])`,
  'u',
);

function matchTier(
  text: string,
  matcher: { regex: RegExp; byTerm: ReadonlyMap<string, string> },
): string[] {
  const found = new Set<string>();
  // A fresh regex per call keeps `lastIndex` state out of the module, so
  // repeated calls cannot influence one another.
  const regex = new RegExp(matcher.regex.source, matcher.regex.flags);
  for (const match of text.matchAll(regex)) {
    const id = matcher.byTerm.get(match[0]);
    if (id !== undefined) found.add(id);
  }
  return [...found].sort();
}

function matchSignals(text: string): TierMatch {
  const decisive = new Set(matchTier(text, DECISIVE_MATCHER));
  if (CVE_REGEX.test(text)) decisive.add(CVE_SIGNAL_ID);
  return {
    decisive: [...decisive].sort(),
    contextual: matchTier(text, CONTEXTUAL_MATCHER),
    outOfScope: matchTier(text, OUT_OF_SCOPE_MATCHER),
  };
}

function scoreOf(match: TierMatch): number {
  return (
    match.decisive.length * SIGNAL_WEIGHTS.decisive +
    match.contextual.length * SIGNAL_WEIGHTS.contextual +
    match.outOfScope.length * SIGNAL_WEIGHTS.out_of_scope
  );
}

/**
 * Classifies one source row.
 *
 * Order of the rules, which is part of the version:
 *
 * 1. A quarantined row goes to `review`: its content is incomplete, so no
 *    confident judgement is possible.
 * 2. A row with no usable text goes to `review`.
 * 3. Otherwise the three tiers are matched. A row is in scope when one
 *    decisive signal or two distinct contextual signals matched.
 * 4. In-scope text that also carries out-of-scope vocabulary is conflicting,
 *    so it goes to `review` rather than being decided either way.
 * 5. In scope and unconflicted gives `include`.
 * 6. `exclude` requires at least one out-of-scope signal and no security
 *    signal of any tier.
 * 7. Everything else, including a single contextual signal and no match at
 *    all, goes to `review`.
 */
export function classify(input: ClassificationInput): ClassificationResult {
  assertClassificationInput(input);
  const base = { sourceRowId: input.sourceRowId, rowHash: input.rowHash };

  if (input.status === 'quarantined') {
    return {
      ...base,
      decision: 'review',
      rationaleCodes: [RATIONALE_CODES.rowQuarantined],
      matchedSignals: [],
      signalScore: 0,
    };
  }

  const text = assembleText(input);
  if (text.length === 0) {
    return {
      ...base,
      decision: 'review',
      rationaleCodes: [RATIONALE_CODES.textAbsent],
      matchedSignals: [],
      signalScore: 0,
    };
  }

  const match = matchSignals(text);
  const matchedSignals = [...match.decisive, ...match.contextual, ...match.outOfScope].sort();
  const signalScore = scoreOf(match);
  const inScope =
    match.decisive.length >= POLICY_THRESHOLDS.decisiveHitsForInclude ||
    match.contextual.length >= POLICY_THRESHOLDS.distinctContextualHitsForInclude;
  const codes: RationaleCode[] = [];

  if (inScope) {
    if (match.decisive.length >= POLICY_THRESHOLDS.decisiveHitsForInclude) {
      codes.push(RATIONALE_CODES.decisiveSignal);
    }
    if (match.contextual.length >= POLICY_THRESHOLDS.distinctContextualHitsForInclude) {
      codes.push(RATIONALE_CODES.contextualSignals);
    }
    if (match.outOfScope.length > 0) {
      codes.push(RATIONALE_CODES.outOfScopeSignal, RATIONALE_CODES.signalsConflicting);
      return {
        ...base,
        decision: 'review',
        rationaleCodes: codes.sort(),
        matchedSignals,
        signalScore,
      };
    }
    return {
      ...base,
      decision: 'include',
      rationaleCodes: codes.sort(),
      matchedSignals,
      signalScore,
    };
  }

  const noSecuritySignal = match.decisive.length === 0 && match.contextual.length === 0;
  if (match.outOfScope.length > 0 && noSecuritySignal) {
    return {
      ...base,
      decision: 'exclude',
      rationaleCodes: [RATIONALE_CODES.outOfScopeSignal, RATIONALE_CODES.noSignalMatch].sort(),
      matchedSignals,
      signalScore,
    };
  }

  if (match.contextual.length === 1) codes.push(RATIONALE_CODES.contextualSignalSingle);
  if (match.outOfScope.length > 0) codes.push(RATIONALE_CODES.outOfScopeSignal);
  if (codes.length === 0) codes.push(RATIONALE_CODES.noSignalMatch);
  return { ...base, decision: 'review', rationaleCodes: codes.sort(), matchedSignals, signalScore };
}

/**
 * The exact ruleset a run used, as canonical JSON: the classifier version,
 * the text-assembly version, the decision-rule order and the whole signal
 * policy. Its SHA-256 is stored on every run, so any rule change produces a
 * different hash and therefore a distinct run.
 */
export function canonicalRuleset(): string {
  return JSON.stringify({
    classifierVersion: CLASSIFIER_VERSION,
    mode: CLASSIFIER_MODE,
    textAssemblyVersion: TEXT_ASSEMBLY_VERSION,
    policyVersion: CLASSIFICATION_SIGNAL_POLICY_VERSION,
    decisionRules: [
      'quarantined:review',
      'no-text:review',
      'in-scope+out-of-scope:review',
      'in-scope:include',
      'out-of-scope-only:exclude',
      'otherwise:review',
    ],
    policy: JSON.parse(canonicalSignalPolicy()) as unknown,
  });
}

export const RULESET_VERSION = CLASSIFICATION_SIGNAL_POLICY_VERSION;

export function rulesetHash(): string {
  return createHash('sha256').update(canonicalRuleset(), 'utf8').digest('hex');
}
