import type { ClassificationDecision } from '@cas/contracts';
import { CLASSIFICATION_SIGNALS, type SignalTier } from '@cas/taxonomy';

import {
  BEHAVIOR_CONTRACT,
  RATIONALE_CODES,
  type BehaviorContract,
  type RationaleCode,
} from './contract.js';
import { assertClassificationInput, type ClassificationInput } from './input.js';
import { assembleText } from './text.js';

/**
 * The Sprint 3 high-recall classifier (decision D21), corrected after the
 * Codex Desktop audit.
 *
 * Pure and deterministic: no database, no network, no environment variable,
 * no model call, no clock, no randomness and no human label. Every
 * behaviour-affecting parameter comes from the behaviour contract, so the
 * stored ruleset hash covers what the code actually does. The engine below,
 * meaning how the matching expression is built and how the rules are walked,
 * is the residue the declarations cannot express; it is pinned by
 * `contract.engineVersion`.
 *
 * Recall posture: uncertainty routes to `review`. A source is excluded only
 * when the text carries explicit out-of-scope vocabulary and no security
 * signal of any tier matched.
 */

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

interface TierMatcher {
  readonly source: string;
  readonly byTerm: ReadonlyMap<string, string>;
}

/** Escapes a term so it is matched literally; policy terms carry no regex syntax. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * One alternation per tier. Term ordering, the boundary class and case
 * sensitivity all come from the contract, so a change to any of them changes
 * the hash as well as the behaviour.
 */
function buildTierMatcher(tier: SignalTier, contract: BehaviorContract): TierMatcher {
  const byTerm = new Map<string, string>();
  for (const signal of CLASSIFICATION_SIGNALS) {
    if (signal.tier !== tier) continue;
    for (const term of signal.terms) byTerm.set(term, signal.id);
  }
  const terms = [...byTerm.keys()];
  if (contract.matching.termOrdering === 'longest-first-then-lexicographic') {
    terms.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  }
  const boundary = contract.matching.boundaryCharacterClass;
  const alternation = terms.map(escapeTerm).join('|');
  const source =
    terms.length === 0 ? '(?!)' : `(?<![${boundary}])(?:${alternation})(?![${boundary}])`;
  return { source, byTerm };
}

const MATCHERS = {
  decisive: buildTierMatcher('decisive', BEHAVIOR_CONTRACT),
  contextual: buildTierMatcher('contextual', BEHAVIOR_CONTRACT),
  out_of_scope: buildTierMatcher('out_of_scope', BEHAVIOR_CONTRACT),
} as const;

function matchTier(text: string, matcher: TierMatcher): string[] {
  const found = new Set<string>();
  // A fresh regex per call keeps `lastIndex` state out of the module, so
  // repeated calls cannot influence one another.
  const regex = new RegExp(matcher.source, 'gu');
  for (const match of text.matchAll(regex)) {
    const id = matcher.byTerm.get(match[0]);
    if (id !== undefined) found.add(id);
  }
  return [...found].sort();
}

function matchSignals(text: string, contract: BehaviorContract): TierMatch {
  const decisive = new Set(matchTier(text, MATCHERS.decisive));
  const boundary = contract.matching.boundaryCharacterClass;
  for (const pattern of contract.matching.patternSignals) {
    const regex = new RegExp(`(?<![${boundary}])(?:${pattern.pattern})(?![${boundary}])`, 'u');
    if (regex.test(text)) decisive.add(pattern.id);
  }
  return {
    decisive: [...decisive].sort(),
    contextual: matchTier(text, MATCHERS.contextual),
    outOfScope: matchTier(text, MATCHERS.out_of_scope),
  };
}

function scoreOf(match: TierMatch, contract: BehaviorContract): number {
  const weights = contract.scoring.weights;
  const score =
    match.decisive.length * (weights['decisive'] ?? 0) +
    match.contextual.length * (weights['contextual'] ?? 0) +
    match.outOfScope.length * (weights['out_of_scope'] ?? 0);
  return Math.max(contract.scoring.minimum, score);
}

function result(
  input: ClassificationInput,
  decision: ClassificationDecision,
  rationaleCodes: readonly RationaleCode[],
  matchedSignals: readonly string[],
  signalScore: number,
): ClassificationResult {
  return {
    sourceRowId: input.sourceRowId,
    rowHash: input.rowHash,
    decision,
    rationaleCodes: [...rationaleCodes].sort(),
    matchedSignals,
    signalScore,
  };
}

/**
 * Classifies one source row by walking `contract.decisionRules` in order.
 * The rule that fires supplies both the decision and the rationale codes, so
 * the mapping between them is declared rather than hidden in branches.
 */
export function classify(
  input: ClassificationInput,
  contract: BehaviorContract = BEHAVIOR_CONTRACT,
): ClassificationResult {
  assertClassificationInput(input);
  const thresholds = contract.thresholds;
  const decisiveNeeded = thresholds['decisiveHitsForInclude'] ?? 1;
  const contextualNeeded = thresholds['distinctContextualHitsForInclude'] ?? 2;
  const outOfScopeNeeded = thresholds['outOfScopeHitsForExclude'] ?? 1;

  if (input.status === 'quarantined') {
    return result(
      input,
      'review',
      [RATIONALE_CODES.rowQuarantined],
      [],
      contract.scoring.quarantinedScore,
    );
  }

  const text = assembleText(input, contract);
  if (text.length === 0) {
    return result(
      input,
      'review',
      [RATIONALE_CODES.textAbsent],
      [],
      contract.scoring.textAbsentScore,
    );
  }

  const match = matchSignals(text, contract);
  const matchedSignals = [...match.decisive, ...match.contextual, ...match.outOfScope].sort();
  const signalScore = scoreOf(match, contract);
  const inScope =
    match.decisive.length >= decisiveNeeded || match.contextual.length >= contextualNeeded;
  const outOfScopeHit = match.outOfScope.length >= outOfScopeNeeded;

  if (inScope && outOfScopeHit) {
    // The conflict codes carry the in-scope evidence with them, so a reviewer
    // sees which side of the conflict fired rather than only that one existed.
    const codes: RationaleCode[] = [
      RATIONALE_CODES.outOfScopeSignal,
      RATIONALE_CODES.signalsConflicting,
    ];
    if (match.decisive.length >= decisiveNeeded) codes.push(RATIONALE_CODES.decisiveSignal);
    if (match.contextual.length >= contextualNeeded) codes.push(RATIONALE_CODES.contextualSignals);
    return result(input, 'review', codes, matchedSignals, signalScore);
  }
  if (inScope) {
    const codes: RationaleCode[] = [];
    if (match.decisive.length >= decisiveNeeded) codes.push(RATIONALE_CODES.decisiveSignal);
    if (match.contextual.length >= contextualNeeded) codes.push(RATIONALE_CODES.contextualSignals);
    return result(input, 'include', codes, matchedSignals, signalScore);
  }
  if (outOfScopeHit && match.decisive.length === 0 && match.contextual.length === 0) {
    return result(
      input,
      'exclude',
      [RATIONALE_CODES.outOfScopeSignal, RATIONALE_CODES.noSignalMatch],
      matchedSignals,
      signalScore,
    );
  }
  const codes: RationaleCode[] = [];
  if (match.contextual.length === 1) codes.push(RATIONALE_CODES.contextualSignalSingle);
  if (match.outOfScope.length > 0) codes.push(RATIONALE_CODES.outOfScopeSignal);
  if (codes.length === 0) codes.push(RATIONALE_CODES.noSignalMatch);
  return result(input, 'review', codes, matchedSignals, signalScore);
}
