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

export const CATEGORIES = ['cyberattack', 'crypto'] as const;
export type Category = (typeof CATEGORIES)[number];

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

export const CYBERATTACK_POLICY: CategoryPolicy = {
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

export const CRYPTO_POLICY: CategoryPolicy = {
  category: 'crypto',
  question: 'Is this a crypto story?',
  policyVersion: CRYPTO_SIGNAL_POLICY_VERSION,
  signals: [...CRYPTO_DECISIVE, ...CRYPTO_CONTEXTUAL, ...GENERAL_OUT_OF_SCOPE],
  patternSignals: [],
  thresholds: { decisiveHitsForInclude: 1, distinctContextualHitsForInclude: 2 },
  weights: SIGNAL_WEIGHTS,
  calibrated: false,
};

export const CATEGORY_POLICIES: Readonly<Record<Category, CategoryPolicy>> = Object.freeze({
  cyberattack: CYBERATTACK_POLICY,
  crypto: CRYPTO_POLICY,
});

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export function categoryPolicy(category: Category): CategoryPolicy {
  return CATEGORY_POLICIES[category];
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
