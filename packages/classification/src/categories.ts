import { CATEGORIES, categoryPolicy, type Category } from '@cas/taxonomy';

import { buildContract, rulesetHash, type BehaviorContract } from './contract.js';

/**
 * One built, frozen contract per category (CAS-002). Built once at module
 * load, so the matcher cache keyed on contract identity holds for the life
 * of the process, exactly as it does for the cyberattack contract.
 */
export const CATEGORY_CONTRACTS: Readonly<Record<Category, BehaviorContract>> = Object.freeze(
  Object.fromEntries(
    CATEGORIES.map((category) => [category, buildContract(categoryPolicy(category))]),
  ) as Record<Category, BehaviorContract>,
);

export function contractFor(category: Category): BehaviorContract {
  return CATEGORY_CONTRACTS[category];
}

/** The ruleset hash a run under this category records. */
export function categoryRulesetHash(category: Category): string {
  return rulesetHash(contractFor(category));
}
