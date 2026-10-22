import {
  categories,
  categoryPolicy,
  CategoryPolicyError,
  CRYPTO_POLICY,
  CYBERATTACK_POLICY,
  isCategory,
  registerCategoryPolicy,
  type CategoryPolicy,
} from '@cas/taxonomy';
import { describe, expect, it } from 'vitest';

import {
  CategoryContractError,
  categoryRulesetHash,
  contractFor,
  listCategories,
} from './categories.js';
import { classify } from './classifier.js';
import { BEHAVIOR_CONTRACT, buildContract, canonicalRuleset, rulesetHash } from './contract.js';
import type { ClassificationInput } from './input.js';

/**
 * Categories (CAS-002). The one claim that must never drift: building the
 * cyberattack policy produces the contract Sprint 3 to 5 shipped, byte for
 * byte, so every classification run recorded before categories existed is a
 * cyberattack run by hash equality, not by assumption. The hash below was
 * computed from the committed contract before the builder existed.
 */
const CYBERATTACK_CONTRACT_HASH =
  'c396ff1dd2da2b800965fc6a4816545b6939c813e57914e0591e19534d6ae58a';

function input(title: string, rowHash = 'a'.repeat(64)): ClassificationInput {
  return {
    sourceRowId: '00000000-0000-4000-8000-000000000001',
    rowHash,
    status: 'accepted',
    normalizedTitle: title,
    derivedSummaryText: null,
    derivedDescriptionText: null,
  };
}

describe('the cyberattack category is the shipped contract', () => {
  it('builds byte for byte to the contract every earlier run recorded', () => {
    expect(canonicalRuleset(buildContract(CYBERATTACK_POLICY))).toBe(
      canonicalRuleset(BEHAVIOR_CONTRACT),
    );
    expect(rulesetHash()).toBe(CYBERATTACK_CONTRACT_HASH);
    expect(categoryRulesetHash('cyberattack')).toBe(CYBERATTACK_CONTRACT_HASH);
    expect(contractFor('cyberattack')).toBe(contractFor('cyberattack'));
  });

  it('classifies exactly as before under the category contract', () => {
    for (const title of [
      'Ransomware hits regional hospital',
      'Football match recap',
      'A breach of trust',
    ]) {
      const before = classify(input(title));
      const after = classify(input(title), contractFor('cyberattack'));
      expect(after).toEqual(before);
    }
  });
});

describe('the crypto category', () => {
  it('has its own policy version and hash, and shares the engine', () => {
    const crypto = contractFor('crypto');
    expect(crypto.policyVersion).toBe(CRYPTO_POLICY.policyVersion);
    expect(crypto.classifierVersion).toBe(BEHAVIOR_CONTRACT.classifierVersion);
    expect(crypto.rulesetVersion).toBe(BEHAVIOR_CONTRACT.rulesetVersion);
    expect(crypto.decisionRules).toEqual(BEHAVIOR_CONTRACT.decisionRules);
    expect(categoryRulesetHash('crypto')).not.toBe(CYBERATTACK_CONTRACT_HASH);
    expect(CRYPTO_POLICY.calibrated).toBe(false);
  });

  it('includes a crypto story, excludes an out-of-scope one, and sends the ambiguous to review', () => {
    const crypto = contractFor('crypto');
    expect(
      classify(input('Bitcoin exchange halts withdrawals after outage'), crypto).decision,
    ).toBe('include');
    expect(
      classify(input('Stablecoin issuer freezes wallets tied to the drainer'), crypto).decision,
    ).toBe('include');
    expect(
      classify(input('Football match recap: late winner seals the title'), crypto).decision,
    ).toBe('exclude');
    // One contextual signal alone is not enough: the engine's high-recall rules
    // send it to review rather than deciding.
    expect(classify(input('The token launch drew a crowd'), crypto).decision).toBe('review');
    // A cyberattack story without crypto vocabulary is not a crypto story; with
    // no signal at all the shared rules still route it to review, never to
    // include.
    expect(classify(input('Ransomware hits regional hospital'), crypto).decision).toBe('review');
  });
});

describe('adding a category', () => {
  const weather: CategoryPolicy = {
    category: 'weather',
    question: 'Is this a weather story?',
    policyVersion: 'fixture-weather-policy@1',
    signals: [
      { id: 'storm', tier: 'decisive', terms: ['hurricane', 'blizzard', 'tornado'] },
      { id: 'forecast', tier: 'contextual', terms: ['forecast', 'rainfall'] },
      { id: 'sport', tier: 'out_of_scope', terms: ['football match'] },
    ],
    patternSignals: [],
    thresholds: { decisiveHitsForInclude: 1, distinctContextualHitsForInclude: 2 },
    weights: { decisive: 3, contextual: 1, out_of_scope: 0 },
    calibrated: false,
  };

  it('is registering a policy: a fixture-only third category reaches the production selection boundary', () => {
    expect(isCategory('weather')).toBe(false);
    expect(() => contractFor('weather')).toThrow(CategoryPolicyError);
    registerCategoryPolicy(weather);
    expect(isCategory('weather')).toBe(true);
    expect(categories()).toContain('weather');
    expect(listCategories()).toContain('weather');
    // The same engine, allowlist and decision rules; only the policy differs.
    const contract = contractFor('weather');
    expect(Object.isFrozen(contract)).toBe(true);
    expect(contract.decisionRules).toEqual(BEHAVIOR_CONTRACT.decisionRules);
    expect(classify(input('Hurricane makes landfall overnight'), contract).decision).toBe(
      'include',
    );
    expect(classify(input('Football match recap'), contract).decision).toBe('exclude');
    expect(categoryRulesetHash('weather')).not.toBe(CYBERATTACK_CONTRACT_HASH);
    expect(categoryRulesetHash('weather')).not.toBe(categoryRulesetHash('crypto'));
    // Registering the identical policy again is a no-op; a different one is refused.
    expect(registerCategoryPolicy(weather)).toBe(categoryPolicy('weather'));
    expect(() => registerCategoryPolicy({ ...weather, question: 'Changed?' })).toThrow(
      CategoryPolicyError,
    );
  });

  it('refuses a malformed policy before it can be registered', () => {
    for (const bad of [
      { ...weather, category: 'Weather' },
      { ...weather, category: 'w' },
      { ...weather, category: 'weather_2', policyVersion: 'no-version' },
      { ...weather, category: 'weather_3', signals: [] },
      {
        ...weather,
        category: 'weather_4',
        thresholds: { decisiveHitsForInclude: 0, distinctContextualHitsForInclude: 2 },
      },
      {
        ...weather,
        category: 'weather_5',
        weights: { decisive: -1, contextual: 1, out_of_scope: 0 },
      },
    ]) {
      expect(() => registerCategoryPolicy(bad)).toThrow(CategoryPolicyError);
      expect(isCategory(bad.category)).toBe(false);
    }
  });

  it('exposes every registered category with a built, frozen contract', () => {
    for (const category of listCategories()) {
      expect(Object.isFrozen(contractFor(category))).toBe(true);
      expect(contractFor(category).policyVersion).toBe(categoryPolicy(category).policyVersion);
    }
  });

  it('refuses a second category whose policy builds to a hash another category owns', () => {
    // Identical vocabulary, thresholds, weights and version under another name
    // would build the cyberattack contract byte for byte: one hash, one owner.
    registerCategoryPolicy({ ...CYBERATTACK_POLICY, category: 'cyberattack_twin' });
    expect(() => contractFor('cyberattack_twin')).toThrow(CategoryContractError);
    expect(categoryRulesetHash('cyberattack')).toBe(CYBERATTACK_CONTRACT_HASH);
  });
});
