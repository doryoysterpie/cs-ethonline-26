import type { ClassificationDecision } from '@cas/contracts';
import type { SignalTier } from '@cas/taxonomy';

import {
  BEHAVIOR_CONTRACT,
  isDeepFrozen,
  type BehaviorContract,
  type DecisionRuleContract,
  type EmitCondition,
  type RationaleCode,
  type RulePredicate,
} from './contract.js';
import { assertClassificationInput, type ClassificationInput } from './input.js';
import { assembleText } from './text.js';

/**
 * The Sprint 3 high-recall classifier (decision D21), corrected twice.
 *
 * Pure and deterministic: no database, no network, no environment variable,
 * no model call, no clock, no randomness and no human label.
 *
 * The engine below executes the supplied contract and nothing else. It
 * imports no taxonomy, hard-codes no precedence, and holds no default-contract
 * cache. The only thing it decides for itself is how to build the alternation,
 * how to de-duplicate matches, and how to sort the matched signal identifiers;
 * that residue is pinned by `contract.engineVersion`.
 *
 * Recall posture: uncertainty routes to `review`. A source is excluded only
 * when the text carries explicit out-of-scope vocabulary and no security
 * signal of any tier matched.
 */

export interface ClassificationResult {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly decision: ClassificationDecision;
  /** Fixed vocabulary, in the order the fired rule emits them. Never source text. */
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
  readonly patterns: readonly { readonly id: string; readonly source: string }[];
}

type TierMatchers = Readonly<Record<SignalTier, TierMatcher>>;

/** Escapes a term so it is matched literally; policy terms carry no regex syntax. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * One alternation per tier, built from the supplied contract's own signals.
 * Term ordering, the boundary class and the pattern signals all come from the
 * contract, so a change to any of them changes the matching behaviour as well
 * as the hash.
 */
function buildTierMatcher(tier: SignalTier, contract: BehaviorContract): TierMatcher {
  const matching = contract.matching;
  const byTerm = new Map<string, string>();
  for (const signal of matching.termSignals) {
    if (signal.tier !== tier) continue;
    for (const term of signal.terms) byTerm.set(term, signal.id);
  }
  const terms = [...byTerm.keys()];
  if (matching.termOrdering === 'longest-first-then-lexicographic') {
    terms.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  }
  const boundary = matching.boundaryCharacterClass;
  const wrap = (body: string): string =>
    boundary.length === 0 ? body : `(?<![${boundary}])(?:${body})(?![${boundary}])`;
  const alternation = terms.map(escapeTerm).join('|');
  return {
    source: terms.length === 0 ? '(?!)' : wrap(alternation),
    byTerm,
    patterns: matching.patternSignals
      .filter((pattern) => pattern.tier === tier)
      .map((pattern) => ({ id: pattern.id, source: wrap(pattern.pattern) })),
  };
}

function buildMatchers(contract: BehaviorContract): TierMatchers {
  return {
    decisive: buildTierMatcher('decisive', contract),
    contextual: buildTierMatcher('contextual', contract),
    out_of_scope: buildTierMatcher('out_of_scope', contract),
  };
}

/**
 * Matchers are cached per contract object, and only for a contract that
 * cannot change afterwards. A mutable contract is rebuilt on every call, so
 * editing one between calls can never return the matchers of the version it
 * no longer describes, and two contracts can never share an entry.
 */
const MATCHER_CACHE = new WeakMap<BehaviorContract, TierMatchers>();

function matchersFor(contract: BehaviorContract): TierMatchers {
  const cached = MATCHER_CACHE.get(contract);
  if (cached !== undefined) return cached;
  const built = buildMatchers(contract);
  if (isDeepFrozen(contract.matching)) MATCHER_CACHE.set(contract, built);
  return built;
}

function matchTier(text: string, matcher: TierMatcher, caseSensitive: boolean): string[] {
  const found = new Set<string>();
  const flags = caseSensitive ? 'gu' : 'giu';
  // A fresh regex per call keeps `lastIndex` state out of the module, so
  // repeated calls cannot influence one another.
  for (const match of text.matchAll(new RegExp(matcher.source, flags))) {
    const id = matcher.byTerm.get(caseSensitive ? match[0] : match[0].toLowerCase());
    if (id !== undefined) found.add(id);
  }
  for (const pattern of matcher.patterns) {
    if (new RegExp(pattern.source, caseSensitive ? 'u' : 'iu').test(text)) found.add(pattern.id);
  }
  return [...found].sort();
}

function matchSignals(text: string, contract: BehaviorContract): TierMatch {
  const matchers = matchersFor(contract);
  const caseSensitive = contract.matching.caseSensitive;
  return {
    decisive: matchTier(text, matchers.decisive, caseSensitive),
    contextual: matchTier(text, matchers.contextual, caseSensitive),
    outOfScope: matchTier(text, matchers.out_of_scope, caseSensitive),
  };
}

function scoreOf(match: TierMatch, contract: BehaviorContract): number {
  const { weights, minimum, maximum } = contract.scoring;
  const raw =
    match.decisive.length * (weights.decisive ?? 0) +
    match.contextual.length * (weights.contextual ?? 0) +
    match.outOfScope.length * (weights.out_of_scope ?? 0);
  const floored = Math.max(minimum, raw);
  return maximum === null ? floored : Math.min(maximum, floored);
}

/**
 * Everything a predicate or an emission condition may inspect, computed at
 * most once and only when a rule actually asks for it. A quarantined row
 * therefore never has its text assembled or matched.
 */
class Evaluation {
  private assembled: string | null = null;
  private matched: TierMatch | null = null;

  constructor(
    readonly input: ClassificationInput,
    readonly contract: BehaviorContract,
  ) {}

  get text(): string {
    if (this.assembled === null) this.assembled = assembleText(this.input, this.contract);
    return this.assembled;
  }

  get match(): TierMatch {
    if (this.matched === null) this.matched = matchSignals(this.text, this.contract);
    return this.matched;
  }

  get decisiveMet(): boolean {
    return this.match.decisive.length >= this.contract.thresholds.decisiveHitsForInclude;
  }

  get contextualMet(): boolean {
    return (
      this.match.contextual.length >= this.contract.thresholds.distinctContextualHitsForInclude
    );
  }

  get outOfScopeMet(): boolean {
    return this.match.outOfScope.length >= this.contract.thresholds.outOfScopeHitsForExclude;
  }

  get inScope(): boolean {
    return this.decisiveMet || this.contextualMet;
  }
}

function predicateHolds(predicate: RulePredicate, evaluation: Evaluation): boolean {
  switch (predicate) {
    case 'status_quarantined':
      return evaluation.input.status === 'quarantined';
    case 'text_absent':
      return evaluation.text.length === 0;
    case 'in_scope_and_out_of_scope':
      return evaluation.inScope && evaluation.outOfScopeMet;
    case 'in_scope':
      return evaluation.inScope;
    case 'out_of_scope_without_in_scope':
      return (
        evaluation.outOfScopeMet &&
        evaluation.match.decisive.length === 0 &&
        evaluation.match.contextual.length === 0
      );
    case 'always':
      return true;
    default:
      throw new TypeError('behaviour contract declares an unknown rule predicate');
  }
}

function emissionHolds(
  condition: EmitCondition,
  evaluation: Evaluation,
  emittedSoFar: number,
): boolean {
  switch (condition) {
    case 'always':
      return true;
    case 'decisive_threshold_met':
      return evaluation.decisiveMet;
    case 'contextual_threshold_met':
      return evaluation.contextualMet;
    case 'single_contextual_signal':
      return evaluation.match.contextual.length === 1;
    case 'any_out_of_scope_signal':
      return evaluation.match.outOfScope.length > 0;
    case 'no_other_code_emitted':
      return emittedSoFar === 0;
    default:
      throw new TypeError('behaviour contract declares an unknown emission condition');
  }
}

function codesFor(rule: DecisionRuleContract, evaluation: Evaluation): RationaleCode[] {
  const codes: RationaleCode[] = [];
  for (const emission of rule.emit) {
    if (emissionHolds(emission.when, evaluation, codes.length)) codes.push(emission.code);
  }
  return codes;
}

/**
 * Classifies one source row by walking `contract.decisionRules` in the order
 * the contract declares. The first rule whose predicate holds supplies the
 * decision, the rationale codes and the score, so reversing the rules changes
 * precedence and rewriting an emission changes the stored rationale.
 */
export function classify(
  input: ClassificationInput,
  contract: BehaviorContract = BEHAVIOR_CONTRACT,
): ClassificationResult {
  assertClassificationInput(input, contract);
  const evaluation = new Evaluation(input, contract);

  for (const rule of contract.decisionRules) {
    if (!predicateHolds(rule.when, evaluation)) continue;
    const scored = rule.score === 'computed';
    return {
      sourceRowId: input.sourceRowId,
      rowHash: input.rowHash,
      decision: rule.decision,
      rationaleCodes: codesFor(rule, evaluation),
      matchedSignals: scored
        ? [
            ...evaluation.match.decisive,
            ...evaluation.match.contextual,
            ...evaluation.match.outOfScope,
          ].sort()
        : [],
      signalScore: scored ? scoreOf(evaluation.match, contract) : rule.score,
    };
  }
  throw new TypeError('behaviour contract has no rule that applies to this input');
}
