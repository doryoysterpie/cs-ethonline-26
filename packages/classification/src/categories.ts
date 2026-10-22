import { categories, categoryPolicy, CategoryPolicyError, type Category } from '@cas/taxonomy';

import { buildContract, rulesetHash, type BehaviorContract } from './contract.js';

/**
 * One built, frozen contract per registered category (CAS-002), built on
 * first use and kept for the life of the process, so the matcher cache keyed
 * on contract identity holds exactly as it does for the cyberattack contract.
 *
 * A ruleset hash names one category and one category only: the first contract
 * to produce a hash owns it, and a later category whose policy builds to the
 * same hash is refused here, before any run could record an ambiguous hash.
 * Migration 0013 enforces the same one-to-one rule in the database.
 */
const CONTRACTS = new Map<Category, BehaviorContract>();
const OWNER_OF_HASH = new Map<string, Category>();

export class CategoryContractError extends Error {
  constructor(
    readonly code: 'category_hash_shared',
    message: string,
  ) {
    super(message);
    this.name = 'CategoryContractError';
  }
}

export function contractFor(category: Category): BehaviorContract {
  const built = CONTRACTS.get(category);
  if (built !== undefined) return built;
  const policy = categoryPolicy(category); // throws CategoryPolicyError for an unknown category
  const contract = buildContract(policy);
  const hash = rulesetHash(contract);
  const owner = OWNER_OF_HASH.get(hash);
  if (owner !== undefined && owner !== category) {
    throw new CategoryContractError(
      'category_hash_shared',
      'that policy builds to a ruleset hash another category already owns',
    );
  }
  OWNER_OF_HASH.set(hash, category);
  CONTRACTS.set(category, contract);
  return contract;
}

/** The ruleset hash a run under this category records. */
export function categoryRulesetHash(category: Category): string {
  return rulesetHash(contractFor(category));
}

/** The registered categories, each with a built contract. */
export function listCategories(): readonly Category[] {
  const names = categories();
  for (const name of names) contractFor(name);
  return names;
}

export { CategoryPolicyError };
