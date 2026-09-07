import { describe, expect, it } from 'vitest';

import { classify } from './classifier.js';
import {
  BEHAVIOR_CONTRACT,
  canonicalize,
  canonicalRuleset,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  ENGINE_VERSION,
  rulesetHash,
  RULESET_VERSION,
  type BehaviorContract,
} from './contract.js';
import type { ClassificationInput } from './input.js';

/**
 * The corrected ruleset hash must cover every behaviour-affecting component.
 * Each case below mutates exactly one aspect of a copy of the contract and
 * asserts the hash moves; the last group asserts that irrelevant formatting
 * does not.
 */

type Mutation = (contract: BehaviorContract) => BehaviorContract;

/** Structured clone that keeps the readonly types honest for the mutations below. */
function clone(contract: BehaviorContract): BehaviorContract {
  return JSON.parse(JSON.stringify(contract)) as BehaviorContract;
}

const MUTATIONS: readonly [name: string, mutate: Mutation][] = [
  [
    'unicode normalization form',
    (c) => ({
      ...c,
      textAssembly: { ...c.textAssembly, unicodeNormalizationForm: 'NFD' },
    }),
  ],
  [
    'case normalization rule',
    (c) => ({ ...c, textAssembly: { ...c.textAssembly, caseNormalization: 'none' } }),
  ],
  [
    'whitespace normalization rule',
    (c) => ({
      ...c,
      textAssembly: { ...c.textAssembly, whitespaceNormalization: 'none' },
    }),
  ],
  [
    'input assembly order',
    (c) => ({
      ...c,
      textAssembly: {
        ...c.textAssembly,
        fieldOrder: [...c.textAssembly.fieldOrder].reverse(),
      },
    }),
  ],
  ['field separator', (c) => ({ ...c, textAssembly: { ...c.textAssembly, fieldSeparator: ' ' } })],
  ['null handling', (c) => ({ ...c, textAssembly: { ...c.textAssembly, nullHandling: 'empty' } })],
  [
    'empty-field handling',
    (c) => ({ ...c, textAssembly: { ...c.textAssembly, emptyHandling: 'keep' } }),
  ],
  [
    'truncation behaviour',
    (c) => ({
      ...c,
      textAssembly: { ...c.textAssembly, maxInputCharacters: 4096, truncation: 'tail' },
    }),
  ],
  [
    'matching semantics: word boundary',
    (c) => ({ ...c, matching: { ...c.matching, boundaryCharacterClass: '\\w' } }),
  ],
  [
    'matching semantics: term ordering',
    (c) => ({ ...c, matching: { ...c.matching, termOrdering: 'lexicographic' } }),
  ],
  [
    'matching semantics: case sensitivity',
    (c) => ({ ...c, matching: { ...c.matching, caseSensitive: true } }),
  ],
  [
    'pattern signals',
    (c) => ({
      ...c,
      matching: {
        ...c.matching,
        patternSignals: [{ id: 'cve_identifier', pattern: 'cve-\\d{4}' }],
      },
    }),
  ],
  [
    'thresholds',
    (c) => ({ ...c, thresholds: { ...c.thresholds, distinctContextualHitsForInclude: 3 } }),
  ],
  ['decision precedence', (c) => ({ ...c, decisionRules: [...c.decisionRules].reverse() })],
  [
    'quarantine handling',
    (c) => ({
      ...c,
      decisionRules: c.decisionRules.map((rule) =>
        rule.id === 'quarantined_row' ? { ...rule, decision: 'exclude' as const } : rule,
      ),
    }),
  ],
  [
    'rationale mapping on a rule',
    (c) => ({
      ...c,
      decisionRules: c.decisionRules.map((rule) =>
        rule.id === 'in_scope' ? { ...rule, rationaleCodes: ['no_signal_match' as never] } : rule,
      ),
    }),
  ],
  [
    'rationale code vocabulary',
    (c) => ({ ...c, rationaleCodes: { ...c.rationaleCodes, rowQuarantined: 'quarantined' } }),
  ],
  [
    'score weights',
    (c) => ({ ...c, scoring: { ...c.scoring, weights: { ...c.scoring.weights, decisive: 5 } } }),
  ],
  ['score formula', (c) => ({ ...c, scoring: { ...c.scoring, formula: 'max(tier-weight)' } })],
  ['score bounds', (c) => ({ ...c, scoring: { ...c.scoring, maximum: 100 } })],
  ['quarantined score', (c) => ({ ...c, scoring: { ...c.scoring, quarantinedScore: 1 } })],
  ['classifier version', (c) => ({ ...c, classifierVersion: 'rules-classifier@99' })],
  ['ruleset version', (c) => ({ ...c, rulesetVersion: 'classification-behavior-contract@99' })],
  ['policy version', (c) => ({ ...c, policyVersion: 'classification-signal-policy@99' })],
  ['engine version', (c) => ({ ...c, engineVersion: 'classification-engine@99' })],
  ['allowed input keys', (c) => ({ ...c, allowedInputKeys: [...c.allowedInputKeys].reverse() })],
  [
    'signal policy content',
    (c) => ({
      ...c,
      signalPolicy: { ...(c.signalPolicy as Record<string, unknown>), version: 'tampered' },
    }),
  ],
];

describe('behaviour contract hash', () => {
  it('publishes the corrected identity', () => {
    expect(CLASSIFIER_VERSION).toBe('rules-classifier@2');
    expect(RULESET_VERSION).toBe('classification-behavior-contract@1');
    expect(CLASSIFIER_MODE).toBe('rules');
    expect(ENGINE_VERSION).toBe('classification-engine@1');
    expect(rulesetHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is reproducible across repeated evaluations', () => {
    const first = rulesetHash();
    for (let i = 0; i < 10; i += 1) expect(rulesetHash()).toBe(first);
    expect(canonicalRuleset()).toBe(canonicalRuleset());
  });

  it('changes when any behaviour-affecting component changes', () => {
    const baseline = rulesetHash();
    const seen = new Map<string, string>();
    for (const [name, mutate] of MUTATIONS) {
      const mutated = rulesetHash(mutate(clone(BEHAVIOR_CONTRACT)));
      expect(mutated, name).not.toBe(baseline);
      // Two different mutations must not collapse onto the same hash.
      const previous = seen.get(mutated);
      expect(previous, `${name} collides with ${previous ?? ''}`).toBeUndefined();
      seen.set(mutated, name);
    }
    expect(seen.size).toBe(MUTATIONS.length);
  });

  it('covers every documented behaviour category', () => {
    const covered = MUTATIONS.map(([name]) => name).join(' | ');
    for (const category of [
      'normalization',
      'assembly order',
      'separator',
      'null handling',
      'matching',
      'precedence',
      'rationale',
      'score',
      'quarantine',
      'truncation',
      'version',
    ]) {
      expect(covered, category).toContain(category);
    }
  });

  it('ignores irrelevant key order and formatting', () => {
    const reordered = {
      signalPolicy: BEHAVIOR_CONTRACT.signalPolicy,
      scoring: BEHAVIOR_CONTRACT.scoring,
      rationaleCodes: BEHAVIOR_CONTRACT.rationaleCodes,
      decisionRules: BEHAVIOR_CONTRACT.decisionRules,
      thresholds: BEHAVIOR_CONTRACT.thresholds,
      matching: BEHAVIOR_CONTRACT.matching,
      textAssembly: BEHAVIOR_CONTRACT.textAssembly,
      allowedInputKeys: BEHAVIOR_CONTRACT.allowedInputKeys,
      policyVersion: BEHAVIOR_CONTRACT.policyVersion,
      engineVersion: BEHAVIOR_CONTRACT.engineVersion,
      mode: BEHAVIOR_CONTRACT.mode,
      rulesetVersion: BEHAVIOR_CONTRACT.rulesetVersion,
      classifierVersion: BEHAVIOR_CONTRACT.classifierVersion,
    } as BehaviorContract;
    expect(rulesetHash(reordered)).toBe(rulesetHash());
    // A round trip through pretty-printed JSON changes formatting only.
    const prettied = JSON.parse(JSON.stringify(BEHAVIOR_CONTRACT, null, 4)) as BehaviorContract;
    expect(rulesetHash(prettied)).toBe(rulesetHash());
  });

  it('canonicalizes deterministically and distinguishes types', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize('1')).not.toBe(canonicalize(1));
    expect(canonicalize(true)).not.toBe(canonicalize('true'));
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
    expect(() => canonicalize(Number.NaN)).toThrow();
  });
});

describe('the classifier consumes the contract rather than duplicated constants', () => {
  const input = (overrides: Partial<ClassificationInput> = {}): ClassificationInput => ({
    sourceRowId: '11111111-1111-4111-8111-111111111111',
    rowHash: 'a'.repeat(64),
    status: 'accepted',
    normalizedTitle: null,
    derivedSummaryText: null,
    derivedDescriptionText: null,
    ...overrides,
  });

  it('honours a changed contextual threshold', () => {
    const sample = input({ normalizedTitle: 'Vendor ships a patch after a vulnerability report' });
    expect(classify(sample).decision).toBe('include');
    const stricter = clone(BEHAVIOR_CONTRACT);
    const raised: BehaviorContract = {
      ...stricter,
      thresholds: { ...stricter.thresholds, distinctContextualHitsForInclude: 99 },
    };
    expect(classify(sample, raised).decision).toBe('review');
  });

  it('honours a changed quarantine decision and score', () => {
    const sample = input({ status: 'quarantined', normalizedTitle: 'ransomware' });
    expect(classify(sample).decision).toBe('review');
    expect(classify(sample).signalScore).toBe(0);
    const altered = clone(BEHAVIOR_CONTRACT);
    const changed: BehaviorContract = {
      ...altered,
      scoring: { ...altered.scoring, quarantinedScore: 7 },
    };
    expect(classify(sample, changed).signalScore).toBe(7);
  });

  it('honours changed score weights', () => {
    const sample = input({ normalizedTitle: 'Ransomware halts a hospital' });
    const baseline = classify(sample).signalScore;
    const altered = clone(BEHAVIOR_CONTRACT);
    const heavier: BehaviorContract = {
      ...altered,
      scoring: { ...altered.scoring, weights: { ...altered.scoring.weights, decisive: 30 } },
    };
    expect(classify(sample, heavier).signalScore).toBeGreaterThan(baseline);
  });

  it('honours a changed field order and separator', () => {
    // "data" in the title and "breach" in the summary must not form a phrase.
    const split = input({ normalizedTitle: 'data', derivedSummaryText: 'breach' });
    expect(classify(split).matchedSignals).not.toContain('data_breach');
    const altered = clone(BEHAVIOR_CONTRACT);
    const joined: BehaviorContract = {
      ...altered,
      textAssembly: { ...altered.textAssembly, fieldSeparator: ' ' },
    };
    expect(classify(split, joined).matchedSignals).toContain('data_breach');
  });

  it('honours a declared truncation limit', () => {
    const long = `${'x '.repeat(5000)}ransomware`;
    const sample = input({ derivedSummaryText: long });
    expect(classify(sample).decision).toBe('include');
    const altered = clone(BEHAVIOR_CONTRACT);
    const truncating: BehaviorContract = {
      ...altered,
      textAssembly: { ...altered.textAssembly, maxInputCharacters: 100 },
    };
    expect(classify(sample, truncating).matchedSignals).not.toContain('ransomware');
  });
});
