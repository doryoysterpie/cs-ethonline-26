/**
 * Editorial categories, version 1 (CAS-002).
 *
 * A category is one question the high-recall classifier answers about every
 * story, with its own signal policy. The engine, the thresholds' meaning and
 * the decision rules are shared; only the vocabulary, the version and the
 * thresholds' values are the category's own. Adding a category is adding a
 * policy here, nothing else.
 *
 * `cyberattack` is the policy Sprint 3 shipped, by reference and unchanged:
 * its contract hash is therefore the hash every existing classification run
 * recorded, which is what lets a run that predates categories be identified
 * as a cyberattack run by equality rather than by assumption.
 *
 * `crypto` answers "is this a crypto story?", the question the Latest in
 * Crypto round-up asks; it is not "is this a crypto attack?". Its first
 * version is written from vocabulary, not fitted to any labelled set, and is
 * recorded as uncalibrated until the owner supplies one (CAS-002, step 2).
 */
import {
  CLASSIFICATION_SIGNAL_POLICY_VERSION,
  CLASSIFICATION_SIGNALS,
  CVE_IDENTIFIER_PATTERN,
  CVE_SIGNAL_ID,
  POLICY_THRESHOLDS,
  SIGNAL_WEIGHTS,
  type SignalDefinition,
  type SignalTier,
} from './signal-policy.js';

/**
 * A category identifier: lowercase, digits and underscores, 2 to 32
 * characters, the alphabet migration 0013 checks. The type is a string
 * because the vocabulary is a registry, not a compile-time union: a category
 * is known once its policy is registered, and `isCategory` is the question.
 */
export type Category = string;
export const CATEGORY_IDENTIFIER = /^[a-z][a-z0-9_]{1,31}$/u;
export const POLICY_VERSION_PATTERN = /^[a-z][a-z0-9-]*@[0-9]+$/u;

export interface PatternSignalDefinition {
  readonly id: string;
  readonly tier: SignalTier;
  /** A regular expression source, matched case-insensitively on normalized text. */
  readonly pattern: string;
}

export interface CategoryThresholds {
  readonly decisiveHitsForInclude: number;
  readonly distinctContextualHitsForInclude: number;
}

export interface CategoryWeights {
  readonly decisive: number;
  readonly contextual: number;
  readonly out_of_scope: number;
}

export interface CategoryPolicy {
  readonly category: Category;
  /** The question the category answers, one sentence. */
  readonly question: string;
  readonly policyVersion: string;
  readonly signals: readonly SignalDefinition[];
  readonly patternSignals: readonly PatternSignalDefinition[];
  readonly thresholds: CategoryThresholds;
  readonly weights: CategoryWeights;
  /** True once retention recall was measured against an owner-labelled set. */
  readonly calibrated: boolean;
}

/** The general out-of-scope vocabulary, shared by every category. */
const GENERAL_OUT_OF_SCOPE: readonly SignalDefinition[] = CLASSIFICATION_SIGNALS.filter(
  (signal) => signal.tier === 'out_of_scope',
);

const CYBERATTACK: CategoryPolicy = {
  category: 'cyberattack',
  question: 'Is this a cybersecurity incident story?',
  policyVersion: CLASSIFICATION_SIGNAL_POLICY_VERSION,
  signals: CLASSIFICATION_SIGNALS,
  patternSignals: [{ id: CVE_SIGNAL_ID, tier: 'decisive', pattern: CVE_IDENTIFIER_PATTERN }],
  thresholds: POLICY_THRESHOLDS,
  weights: SIGNAL_WEIGHTS,
  calibrated: true,
};

export const CRYPTO_SIGNAL_POLICY_VERSION = 'crypto-signal-policy@1';

const CRYPTO_DECISIVE: readonly SignalDefinition[] = [
  {
    id: 'cryptocurrency',
    tier: 'decisive',
    terms: ['cryptocurrency', 'cryptocurrencies', 'crypto'],
  },
  { id: 'bitcoin', tier: 'decisive', terms: ['bitcoin', 'btc'] },
  { id: 'ethereum', tier: 'decisive', terms: ['ethereum', 'ether', 'eth'] },
  {
    id: 'stablecoin',
    tier: 'decisive',
    terms: ['stablecoin', 'stablecoins', 'usdt', 'usdc', 'tether'],
  },
  {
    id: 'defi',
    tier: 'decisive',
    terms: ['defi', 'decentralized finance', 'decentralised finance'],
  },
  {
    id: 'blockchain',
    tier: 'decisive',
    terms: ['blockchain', 'blockchains', 'on-chain', 'onchain'],
  },
  { id: 'web3', tier: 'decisive', terms: ['web3', 'web 3'] },
  { id: 'nft', tier: 'decisive', terms: ['nft', 'nfts', 'non-fungible token'] },
  {
    id: 'crypto_exchange',
    tier: 'decisive',
    terms: [
      'crypto exchange',
      'cryptocurrency exchange',
      'binance',
      'coinbase',
      'kraken exchange',
      'bybit',
      'okx',
    ],
  },
  {
    id: 'altcoin',
    tier: 'decisive',
    terms: ['altcoin', 'altcoins', 'memecoin', 'memecoins', 'solana', 'xrp', 'dogecoin'],
  },
  {
    id: 'crypto_theft',
    tier: 'decisive',
    terms: [
      'wallet drainer',
      'drainer',
      'rug pull',
      'bridge exploit',
      'flash loan attack',
      'seed phrase',
    ],
  },
];

const CRYPTO_CONTEXTUAL: readonly SignalDefinition[] = [
  { id: 'token', tier: 'contextual', terms: ['token', 'tokens', 'tokenized', 'tokenised'] },
  {
    id: 'wallet',
    tier: 'contextual',
    terms: ['wallet', 'wallets', 'cold storage', 'hardware wallet'],
  },
  { id: 'exchange', tier: 'contextual', terms: ['exchange', 'exchanges'] },
  {
    id: 'mining',
    tier: 'contextual',
    terms: ['mining', 'miner', 'miners', 'proof of work', 'proof of stake', 'staking'],
  },
  {
    id: 'digital_asset',
    tier: 'contextual',
    terms: ['digital asset', 'digital assets', 'digital currency', 'virtual currency'],
  },
  { id: 'coin', tier: 'contextual', terms: ['coin', 'coins', 'ledger'] },
  {
    id: 'smart_contract',
    tier: 'contextual',
    terms: ['smart contract', 'smart contracts', 'protocol', 'bridge'],
  },
  { id: 'crypto_regulation', tier: 'contextual', terms: ['sec', 'etf', 'custody', 'custodian'] },
];

const CRYPTO: CategoryPolicy = {
  category: 'crypto',
  question: 'Is this a crypto story?',
  policyVersion: CRYPTO_SIGNAL_POLICY_VERSION,
  signals: [...CRYPTO_DECISIVE, ...CRYPTO_CONTEXTUAL, ...GENERAL_OUT_OF_SCOPE],
  patternSignals: [],
  thresholds: { decisiveHitsForInclude: 1, distinctContextualHitsForInclude: 2 },
  weights: SIGNAL_WEIGHTS,
  calibrated: false,
};

export class CategoryPolicyError extends Error {
  constructor(
    readonly code:
      | 'category_identifier_invalid'
      | 'policy_version_invalid'
      | 'policy_shape_invalid'
      | 'category_policy_conflict'
      | 'category_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'CategoryPolicyError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function assertPolicyShape(policy: CategoryPolicy): void {
  if (!CATEGORY_IDENTIFIER.test(policy.category)) {
    throw new CategoryPolicyError(
      'category_identifier_invalid',
      'a category identifier is 2 to 32 lowercase letters, digits or underscores',
    );
  }
  if (!POLICY_VERSION_PATTERN.test(policy.policyVersion)) {
    throw new CategoryPolicyError(
      'policy_version_invalid',
      'a policy version reads <name>@<integer>',
    );
  }
  const positiveInteger = (n: number): boolean => Number.isInteger(n) && n >= 1;
  const weight = (n: number): boolean => Number.isFinite(n) && n >= 0;
  if (
    typeof policy.question !== 'string' ||
    policy.question.length === 0 ||
    policy.signals.length === 0 ||
    !positiveInteger(policy.thresholds.decisiveHitsForInclude) ||
    !positiveInteger(policy.thresholds.distinctContextualHitsForInclude) ||
    !weight(policy.weights.decisive) ||
    !weight(policy.weights.contextual) ||
    !weight(policy.weights.out_of_scope) ||
    typeof policy.calibrated !== 'boolean'
  ) {
    throw new CategoryPolicyError(
      'policy_shape_invalid',
      'a category policy needs a question, at least one signal, positive integer thresholds and non-negative weights',
    );
  }
}

/**
 * The registry: one frozen policy per category, append-only for the life of
 * the process. The two policies this file declares are registered at load.
 * Registering the same category again with an identical policy is a no-op;
 * with a different one it is refused, because a category's policy changes
 * only through a new version in this file, never by replacement at run time.
 * Nothing outside code can reach this function: no input, no file, no
 * request registers a category.
 */
const REGISTRY = new Map<Category, CategoryPolicy>();

/** Every field of a policy, in canonical form: two policies are the same only if this is. */
function policyIdentity(policy: CategoryPolicy): string {
  return JSON.stringify({
    canonical: canonicalCategoryPolicy(policy),
    question: policy.question,
    calibrated: policy.calibrated,
  });
}

export function registerCategoryPolicy(policy: CategoryPolicy): CategoryPolicy {
  assertPolicyShape(policy);
  const existing = REGISTRY.get(policy.category);
  if (existing !== undefined) {
    if (policyIdentity(existing) === policyIdentity(policy)) return existing;
    throw new CategoryPolicyError(
      'category_policy_conflict',
      'that category is registered with a different policy; a change is a new policy version',
    );
  }
  const frozen = deepFreeze({ ...policy });
  REGISTRY.set(frozen.category, frozen);
  return frozen;
}

export const CYBERATTACK_POLICY: CategoryPolicy = registerCategoryPolicy(CYBERATTACK);
export const CRYPTO_POLICY: CategoryPolicy = registerCategoryPolicy(CRYPTO);

/** The registered categories, in registration order. */
export function categories(): readonly Category[] {
  return Object.freeze([...REGISTRY.keys()]);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && REGISTRY.has(value);
}

export function categoryPolicy(category: Category): CategoryPolicy {
  const policy = REGISTRY.get(category);
  if (policy === undefined) {
    throw new CategoryPolicyError('category_unknown', 'no policy is registered for that category');
  }
  return policy;
}

/** The canonical JSON of one policy: the same form `canonicalSignalPolicy` uses, plus the category. */
export function canonicalCategoryPolicy(policy: CategoryPolicy): string {
  const signals = [...policy.signals]
    .map((signal) => ({ id: signal.id, tier: signal.tier, terms: [...signal.terms].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const patternSignals = [...policy.patternSignals]
    .map((signal) => ({ id: signal.id, tier: signal.tier, pattern: signal.pattern }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    category: policy.category,
    version: policy.policyVersion,
    thresholds: policy.thresholds,
    weights: policy.weights,
    signals,
    patternSignals,
  });
}
