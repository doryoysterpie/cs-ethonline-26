import { describe, expect, it } from 'vitest';

import { classify, type ClassificationResult } from './classifier.js';
import {
  BEHAVIOR_CONTRACT,
  canonicalize,
  canonicalRuleset,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  deepFreeze,
  ENGINE_VERSION,
  isDeepFrozen,
  RATIONALE_CODES,
  rulesetHash,
  RULESET_VERSION,
  type BehaviorContract,
} from './contract.js';
import { ClassificationInputError, type ClassificationInput } from './input.js';

/**
 * The behaviour contract is the executable source of truth, and this file is
 * what holds it to that.
 *
 * Codex Desktop's re-audit showed the previous version of this suite proving
 * only that a JSON mutation changed a hash. Four of those mutations changed
 * nothing the compiled classifier did. Every behaviour mutation below is
 * therefore paired with an input chosen so that the mutation must change an
 * observable result: the decision, the rationale codes, the matched signals or
 * the score. A mutation that changes the hash without changing the result
 * fails here.
 */

type Mutation = (contract: BehaviorContract) => BehaviorContract;

/** Structured clone that keeps the readonly types honest for the mutations below. */
function clone(contract: BehaviorContract): BehaviorContract {
  return JSON.parse(JSON.stringify(contract)) as BehaviorContract;
}

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    sourceRowId: 'row-1',
    rowHash: 'a'.repeat(64),
    status: 'accepted',
    normalizedTitle: null,
    derivedSummaryText: null,
    derivedDescriptionText: null,
    ...overrides,
  };
}

/** Comparable projection of everything a caller can observe. */
function observed(result: ClassificationResult): string {
  return canonicalize({
    decision: result.decision,
    rationaleCodes: [...result.rationaleCodes],
    matchedSignals: [...result.matchedSignals],
    signalScore: result.signalScore,
  });
}

function run(contract: BehaviorContract, value: ClassificationInput): string {
  try {
    return observed(classify(value, contract));
  } catch (error) {
    // A refused input is an observable outcome too, and the reason is fixed
    // vocabulary rather than anything from the value.
    if (error instanceof ClassificationInputError) return `rejected:${error.reason}`;
    throw error;
  }
}

/** Text carrying one decisive signal and one out-of-scope signal. */
const CONFLICTING = input({
  normalizedTitle: 'Ransomware halts the stadium',
  derivedSummaryText: 'The super bowl broadcast was affected.',
});

/** Two distinct contextual signals and nothing decisive. */
const TWO_CONTEXTUAL = input({
  normalizedTitle: 'Security researchers report a vulnerability',
});

/** One contextual signal only, which the last rule routes to review. */
const ONE_CONTEXTUAL = input({ normalizedTitle: 'A security conference opens' });

/** Out-of-scope vocabulary with no security signal of any tier. */
const OUT_OF_SCOPE_ONLY = input({ normalizedTitle: 'The super bowl drew record viewers' });

const QUARANTINED = input({ status: 'quarantined', normalizedTitle: 'Ransomware hits a hospital' });

/**
 * Every behaviour field of the contract, the mutation that changes it, and an
 * input whose observable result must change with it.
 *
 * A fourth element supplies a different starting contract when a field is only
 * observable in combination with another. Field order is the one case: with
 * the production separator no phrase can span a field boundary, so the order
 * of the fields is proven against a contract that joins them with a space.
 * The pair still isolates the single field under test.
 */
type MutationCase = readonly [
  name: string,
  probe: ClassificationInput,
  mutate: Mutation,
  baseline?: Mutation,
];

const BEHAVIOR_MUTATIONS: readonly MutationCase[] = [
  [
    'decision precedence: rule order',
    CONFLICTING,
    (c) => {
      const next = clone(c);
      return { ...next, decisionRules: [...next.decisionRules].reverse() };
    },
  ],
  [
    'conflict rule: its decision',
    CONFLICTING,
    (c) => {
      const next = clone(c);
      const rules = next.decisionRules.map((rule) =>
        rule.id === 'in_scope_conflicting' ? { ...rule, decision: 'exclude' as const } : rule,
      );
      return { ...next, decisionRules: rules };
    },
  ],
  [
    'rationale mapping on the in-scope rule',
    TWO_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      const rules = next.decisionRules.map((rule) =>
        rule.id === 'in_scope'
          ? {
              ...rule,
              emit: [{ code: RATIONALE_CODES.noSignalMatch, when: 'always' as const }],
            }
          : rule,
      );
      return { ...next, decisionRules: rules };
    },
  ],
  [
    'rationale emission order',
    CONFLICTING,
    (c) => {
      const next = clone(c);
      const rules = next.decisionRules.map((rule) =>
        rule.id === 'in_scope_conflicting' ? { ...rule, emit: [...rule.emit].reverse() } : rule,
      );
      return { ...next, decisionRules: rules };
    },
  ],
  [
    'quarantine handling: the rule that catches it',
    QUARANTINED,
    (c) => {
      const next = clone(c);
      const rules = next.decisionRules.map((rule) =>
        rule.id === 'quarantined_row' ? { ...rule, decision: 'exclude' as const, score: 7 } : rule,
      );
      return { ...next, decisionRules: rules };
    },
  ],
  [
    'admission: the allowed input keys',
    TWO_CONTEXTUAL,
    (c) => ({ ...clone(c), allowedInputKeys: [] }),
  ],
  [
    // A null title is valid text and an invalid identifier, so the declared
    // shape is what decides whether this input is admitted at all.
    'admission: a declared field shape',
    input({ derivedSummaryText: 'Security researchers report a vulnerability' }),
    (c) => {
      const next = clone(c);
      return {
        ...next,
        allowedInputKeys: next.allowedInputKeys.map((field) =>
          field.key === 'normalizedTitle' ? { ...field, kind: 'identifier' as const } : field,
        ),
      };
    },
  ],
  [
    'taxonomy: the terms of one signal',
    TWO_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      return {
        ...next,
        matching: {
          ...next.matching,
          termSignals: next.matching.termSignals.map((signal) =>
            signal.id === 'weakness' ? { ...signal, terms: ['unrelated phrase'] } : signal,
          ),
        },
      };
    },
  ],
  [
    'taxonomy: the tier of one signal',
    TWO_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      return {
        ...next,
        matching: {
          ...next.matching,
          termSignals: next.matching.termSignals.map((signal) =>
            signal.id === 'weakness' ? { ...signal, tier: 'decisive' as const } : signal,
          ),
        },
      };
    },
  ],
  [
    'taxonomy: a pattern signal',
    input({ normalizedTitle: 'Advisory covers CVE-2026-12345 in detail' }),
    (c) => {
      const next = clone(c);
      return { ...next, matching: { ...next.matching, patternSignals: [] } };
    },
  ],
  [
    'matching: the boundary character class',
    input({ normalizedTitle: 'A hackathon and a conference' }),
    (c) => {
      const next = clone(c);
      return { ...next, matching: { ...next.matching, boundaryCharacterClass: '' } };
    },
  ],
  [
    // 'security bug' and 'security' belong to different signals, so which
    // one the alternation tries first decides which signal is reported.
    'matching: term ordering',
    input({ normalizedTitle: 'A security bug was reported' }),
    (c) => {
      const next = clone(c);
      return { ...next, matching: { ...next.matching, termOrdering: 'declaration-order' } };
    },
  ],
  [
    // Case sensitivity only shows once the text is no longer lower-cased for
    // us, so the baseline turns that normalization off and the mutation turns
    // matching strict.
    'matching: case sensitivity',
    input({ normalizedTitle: 'RANSOMWARE hits a hospital' }),
    (c) => {
      const next = clone(c);
      return { ...next, matching: { ...next.matching, caseSensitive: true } };
    },
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, caseNormalization: 'none' } };
    },
  ],
  [
    'text assembly: field order',
    input({ normalizedTitle: 'bug', derivedSummaryText: 'security' }),
    (c) => {
      const next = clone(c);
      return {
        ...next,
        textAssembly: {
          ...next.textAssembly,
          fieldOrder: ['derivedSummaryText', 'normalizedTitle', 'derivedDescriptionText'],
        },
      };
    },
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, fieldSeparator: ' ' } };
    },
  ],
  [
    'text assembly: the field separator',
    input({ normalizedTitle: 'a security', derivedSummaryText: 'bug was reported' }),
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, fieldSeparator: ' ' } };
    },
  ],
  [
    // An absent field either disappears or contributes an empty part, which
    // is the difference between "security bug" and "security  bug".
    'text assembly: null handling',
    input({ normalizedTitle: 'security', derivedDescriptionText: 'bug' }),
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, nullHandling: 'empty' } };
    },
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, fieldSeparator: ' ' } };
    },
  ],
  [
    // Full-width letters are their own code points under NFC and fold to
    // ASCII under NFKC, so the form decides whether a term matches at all.
    'text assembly: Unicode normalization form',
    input({ normalizedTitle: 'ｃｙｂｅｒ ｓｅｃｕｒｉｔｙ' }),
    (c) => {
      const next = clone(c);
      return {
        ...next,
        textAssembly: { ...next.textAssembly, unicodeNormalizationForm: 'NFKC' },
      };
    },
  ],
  [
    // The mirror of the case-sensitivity probe: with strict matching, whether
    // the assembler lower-cases the text is what decides the match.
    'text assembly: case normalization',
    input({ normalizedTitle: 'SECURITY researchers found a VULNERABILITY' }),
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, caseNormalization: 'none' } };
    },
    (c) => {
      const next = clone(c);
      return { ...next, matching: { ...next.matching, caseSensitive: true } };
    },
  ],
  [
    // Collapsing the run of spaces is what lets the phrase 'security bug'
    // form; without it only the single word 'security' matches.
    'text assembly: whitespace normalization',
    input({ normalizedTitle: 'a security  bug was reported' }),
    (c) => {
      const next = clone(c);
      return {
        ...next,
        textAssembly: { ...next.textAssembly, whitespaceNormalization: 'none' },
      };
    },
  ],
  [
    'text assembly: truncation',
    input({
      normalizedTitle: 'A long preamble that carries no signal at all in its opening clause',
      derivedSummaryText: 'ransomware',
    }),
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, maxInputCharacters: 20 } };
    },
  ],
  [
    'thresholds: contextual hits needed for scope',
    ONE_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      return {
        ...next,
        thresholds: { ...next.thresholds, distinctContextualHitsForInclude: 1 },
      };
    },
  ],
  [
    'thresholds: decisive hits needed for scope',
    input({ normalizedTitle: 'Ransomware hits a hospital' }),
    (c) => {
      const next = clone(c);
      return { ...next, thresholds: { ...next.thresholds, decisiveHitsForInclude: 2 } };
    },
  ],
  [
    'thresholds: out-of-scope hits needed to conflict',
    CONFLICTING,
    (c) => {
      const next = clone(c);
      return { ...next, thresholds: { ...next.thresholds, outOfScopeHitsForExclude: 2 } };
    },
  ],
  [
    'scoring: tier weights',
    TWO_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      return {
        ...next,
        scoring: { ...next.scoring, weights: { ...next.scoring.weights, contextual: 5 } },
      };
    },
  ],
  [
    'scoring: the maximum',
    TWO_CONTEXTUAL,
    (c) => {
      const next = clone(c);
      return { ...next, scoring: { ...next.scoring, maximum: 0 } };
    },
  ],
  [
    'scoring: the minimum',
    OUT_OF_SCOPE_ONLY,
    (c) => {
      const next = clone(c);
      return { ...next, scoring: { ...next.scoring, minimum: 4 } };
    },
  ],
];

/** Identity fields. They are hashed deliberately and execute nothing. */
const IDENTITY_MUTATIONS: readonly [name: string, mutate: Mutation][] = [
  ['classifier version', (c) => ({ ...clone(c), classifierVersion: 'rules-classifier@99' })],
  ['ruleset version', (c) => ({ ...clone(c), rulesetVersion: 'contract@99' })],
  ['engine version', (c) => ({ ...clone(c), engineVersion: 'engine@99' })],
  ['policy version', (c) => ({ ...clone(c), policyVersion: 'policy@99' })],
];

describe('the behaviour contract is executed, not described', () => {
  it('publishes the corrected identity and a reproducible hash', () => {
    expect(CLASSIFIER_VERSION).toBe('rules-classifier@3');
    expect(RULESET_VERSION).toBe('classification-behavior-contract@2');
    expect(ENGINE_VERSION).toBe('classification-engine@2');
    expect(CLASSIFIER_MODE).toBe('rules');
    expect(rulesetHash()).toMatch(/^[0-9a-f]{64}$/u);
    expect(rulesetHash()).toBe(rulesetHash(BEHAVIOR_CONTRACT));
    // Repeated evaluation is stable: nothing in the contract is derived from a
    // clock, an environment value or an iteration order that could vary.
    const hashes = new Set(Array.from({ length: 25 }, () => rulesetHash()));
    expect(hashes.size).toBe(1);
  });

  it('changes an observable result for every behaviour field it hashes', () => {
    const seen = new Map<string, string>();
    for (const [name, probe, mutate, baseline] of BEHAVIOR_MUTATIONS) {
      const from = baseline === undefined ? BEHAVIOR_CONTRACT : baseline(BEHAVIOR_CONTRACT);
      const mutated = mutate(from);
      const hash = rulesetHash(mutated);
      expect(hash, `${name} must change the hash`).not.toBe(rulesetHash(from));
      expect(run(mutated, probe), `${name} must change what the classifier returns`).not.toBe(
        run(from, probe),
      );
      // No two mutations may collapse onto the same document from the same
      // starting contract. Two mirror-image probes may legitimately meet at
      // one endpoint from different baselines, so the key carries both.
      const key = `${rulesetHash(from)}:${hash}`;
      const previous = seen.get(key);
      expect(previous, `${name} collides with ${previous ?? ''}`).toBeUndefined();
      seen.set(key, name);
    }
    expect(seen.size).toBe(BEHAVIOR_MUTATIONS.length);
  });

  it('covers every behaviour field of the contract', () => {
    const covered = BEHAVIOR_MUTATIONS.map(([name]) => name).join(' | ');
    for (const field of [
      'decision precedence',
      'conflict rule',
      'rationale mapping',
      'rationale emission order',
      'quarantine handling',
      'admission',
      'taxonomy',
      'matching',
      'text assembly',
      'thresholds',
      'scoring',
    ]) {
      expect(covered, field).toContain(field);
    }
    // Every top-level behaviour key of the contract is exercised above.
    expect(Object.keys(BEHAVIOR_CONTRACT).sort()).toEqual([
      'allowedInputKeys',
      'classifierVersion',
      'decisionRules',
      'engineVersion',
      'matching',
      'mode',
      'policyVersion',
      'rulesetVersion',
      'scoring',
      'textAssembly',
      'thresholds',
    ]);
  });

  it('hashes its identity fields, which are declared as identity and execute nothing', () => {
    const baseline = rulesetHash();
    const probe = TWO_CONTEXTUAL;
    for (const [name, mutate] of IDENTITY_MUTATIONS) {
      const mutated = mutate(BEHAVIOR_CONTRACT);
      expect(rulesetHash(mutated), name).not.toBe(baseline);
      // Identity does not change behaviour; that is exactly why it is named
      // identity in the contract rather than counted as behaviour coverage.
      expect(run(mutated, probe), name).toBe(run(BEHAVIOR_CONTRACT, probe));
    }
  });

  it('ignores irrelevant key order and formatting, and keeps meaningful array order', () => {
    const reordered = {
      scoring: BEHAVIOR_CONTRACT.scoring,
      matching: BEHAVIOR_CONTRACT.matching,
      mode: BEHAVIOR_CONTRACT.mode,
      thresholds: BEHAVIOR_CONTRACT.thresholds,
      decisionRules: BEHAVIOR_CONTRACT.decisionRules,
      textAssembly: BEHAVIOR_CONTRACT.textAssembly,
      allowedInputKeys: BEHAVIOR_CONTRACT.allowedInputKeys,
      policyVersion: BEHAVIOR_CONTRACT.policyVersion,
      engineVersion: BEHAVIOR_CONTRACT.engineVersion,
      rulesetVersion: BEHAVIOR_CONTRACT.rulesetVersion,
      classifierVersion: BEHAVIOR_CONTRACT.classifierVersion,
    } as BehaviorContract;
    expect(rulesetHash(reordered)).toBe(rulesetHash());
    // Round-tripping through pretty-printed JSON changes only whitespace.
    const prettied = JSON.parse(JSON.stringify(BEHAVIOR_CONTRACT, null, 4)) as BehaviorContract;
    expect(rulesetHash(prettied)).toBe(rulesetHash());
    expect(canonicalRuleset(prettied)).toBe(canonicalRuleset());
    // Array order is behaviour and stays significant.
    const reversedRules = {
      ...clone(BEHAVIOR_CONTRACT),
      decisionRules: [...BEHAVIOR_CONTRACT.decisionRules].reverse(),
    };
    expect(rulesetHash(reversedRules)).not.toBe(rulesetHash());
  });

  it('canonicalizes deterministically and distinguishes types', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    expect(canonicalize(null)).not.toBe(canonicalize('null'));
    expect(canonicalize(1)).not.toBe(canonicalize('1'));
    expect(canonicalize(true)).not.toBe(canonicalize('true'));
    expect(canonicalize({ a: undefined, b: 1 })).toBe(canonicalize({ b: 1 }));
    expect(() => canonicalize(Number.NaN)).toThrowError(TypeError);
    expect(() => canonicalize(() => 1)).toThrowError(TypeError);
  });
});

describe('the production contract cannot be edited or shared by accident', () => {
  it('is deeply frozen, so its matchers can be cached by identity', () => {
    expect(isDeepFrozen(BEHAVIOR_CONTRACT)).toBe(true);
    expect(Object.isFrozen(BEHAVIOR_CONTRACT.matching.termSignals)).toBe(true);
    const rule = BEHAVIOR_CONTRACT.decisionRules[0];
    if (rule === undefined) throw new Error('no rules');
    expect(Object.isFrozen(rule.emit)).toBe(true);
    // A frozen structure silently ignores writes in sloppy mode and throws in
    // strict mode; either way the value is unchanged.
    expect(() => {
      (BEHAVIOR_CONTRACT.thresholds as { decisiveHitsForInclude: number }).decisiveHitsForInclude =
        99;
    }).toThrowError(TypeError);
    expect(BEHAVIOR_CONTRACT.thresholds.decisiveHitsForInclude).toBe(1);
  });

  it('never lets one contract reuse another contract’s matchers', () => {
    const probe = input({ normalizedTitle: 'Ransomware hits a hospital' });
    const withoutRansomware = {
      ...clone(BEHAVIOR_CONTRACT),
      matching: {
        ...clone(BEHAVIOR_CONTRACT).matching,
        termSignals: clone(BEHAVIOR_CONTRACT).matching.termSignals.filter(
          (signal) => signal.id !== 'ransomware',
        ),
      },
    };
    const a = classify(probe, BEHAVIOR_CONTRACT);
    const b = classify(probe, withoutRansomware);
    const againA = classify(probe, BEHAVIOR_CONTRACT);
    expect(a.matchedSignals).toContain('ransomware');
    expect(b.matchedSignals).not.toContain('ransomware');
    expect(againA.matchedSignals).toContain('ransomware');
    // Interleaving the two must not leak either way.
    expect(observed(classify(probe, withoutRansomware))).toBe(observed(b));
    expect(observed(classify(probe, BEHAVIOR_CONTRACT))).toBe(observed(a));
  });

  it('rebuilds matchers for a contract that is still mutable', () => {
    const mutable = clone(BEHAVIOR_CONTRACT);
    const before = classify(input({ normalizedTitle: 'Ransomware hits a hospital' }), mutable);
    expect(before.matchedSignals).toContain('ransomware');
    // Editing the same object between calls must be honoured, not cached over.
    const edited = mutable as unknown as {
      matching: { termSignals: { id: string; tier: string; terms: string[] }[] };
    };
    edited.matching.termSignals = edited.matching.termSignals.filter(
      (signal) => signal.id !== 'ransomware',
    );
    const after = classify(input({ normalizedTitle: 'Ransomware hits a hospital' }), mutable);
    expect(after.matchedSignals).not.toContain('ransomware');
  });

  it('deep-freezes what it is given and reports what is not frozen', () => {
    const shallow = Object.freeze({ nested: { value: 1 } });
    expect(isDeepFrozen(shallow)).toBe(false);
    expect(isDeepFrozen(deepFreeze({ nested: { value: 1 } }))).toBe(true);
    expect(isDeepFrozen(1)).toBe(true);
    expect(isDeepFrozen(null)).toBe(true);
  });
});

describe('the production classifier matches the production contract', () => {
  it('returns the same result whether the contract is supplied or defaulted', () => {
    for (const probe of [
      CONFLICTING,
      TWO_CONTEXTUAL,
      ONE_CONTEXTUAL,
      OUT_OF_SCOPE_ONLY,
      QUARANTINED,
      input(),
    ]) {
      expect(observed(classify(probe))).toBe(observed(classify(probe, BEHAVIOR_CONTRACT)));
    }
  });

  it('produces the decisions the contract declares for each rule', () => {
    expect(classify(QUARANTINED).decision).toBe('review');
    expect(classify(QUARANTINED).rationaleCodes).toEqual(['row_quarantined']);
    expect(classify(QUARANTINED).signalScore).toBe(0);
    expect(classify(input()).rationaleCodes).toEqual(['text_absent']);
    expect(classify(CONFLICTING).decision).toBe('review');
    expect(classify(CONFLICTING).rationaleCodes).toEqual([
      'out_of_scope_signal',
      'signals_conflicting',
      'decisive_signal',
    ]);
    expect(classify(TWO_CONTEXTUAL).decision).toBe('include');
    expect(classify(TWO_CONTEXTUAL).rationaleCodes).toEqual(['contextual_signals']);
    expect(classify(OUT_OF_SCOPE_ONLY).decision).toBe('exclude');
    expect(classify(OUT_OF_SCOPE_ONLY).rationaleCodes).toEqual([
      'out_of_scope_signal',
      'no_signal_match',
    ]);
    expect(classify(ONE_CONTEXTUAL).decision).toBe('review');
    expect(classify(ONE_CONTEXTUAL).rationaleCodes).toEqual(['contextual_signal_single']);
  });
});
