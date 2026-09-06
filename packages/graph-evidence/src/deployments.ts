import { type DeploymentTarget, validateRegistry } from './gate.js';

/**
 * Selected live deployments for the Sprint 1 proof. Configuration only: the
 * public Subgraph IDs come from the Messari deployment registry
 * (github.com/messari/subgraphs, deployment/deployment.json). The
 * `expectedProviderSlug` and `expected` values are the exact provider-returned
 * `slug`, `network`, `type` and `schemaVersion` observed in the verified live
 * runs of 5 September 2026 (docs/SPRINT-1-REPORT.md). They are expectations
 * the live gate validates against, never facts the gate assumes. Only these
 * values vary between deployments; the query document and the adapter never
 * do. Canonical identity is normalized chain plus provider slug.
 */
export type { DeploymentTarget } from './gate.js';

export const ETHEREUM_LENDING_TARGETS: readonly DeploymentTarget[] = [
  {
    label: 'aave-v3-ethereum',
    chain: 'ethereum',
    protocol: 'Aave v3',
    slug: 'aave-v3-ethereum',
    expectedProviderSlug: 'aave-v3',
    subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk',
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
  },
  {
    label: 'spark-lend-ethereum',
    chain: 'ethereum',
    protocol: 'Spark',
    slug: 'spark-lend-ethereum',
    expectedProviderSlug: 'spark-lend',
    subgraphId: 'GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si',
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
  },
  {
    label: 'makerdao-ethereum',
    chain: 'ethereum',
    protocol: 'MakerDAO',
    slug: 'makerdao-ethereum',
    expectedProviderSlug: 'makerdao',
    subgraphId: '8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1',
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '2.0.1' },
  },
  {
    label: 'compound-v3-ethereum',
    chain: 'ethereum',
    protocol: 'Compound v3',
    slug: 'compound-v3-ethereum',
    expectedProviderSlug: 'compound-v3',
    subgraphId: 'AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9',
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
  },
  {
    label: 'liquity-ethereum',
    chain: 'ethereum',
    protocol: 'Liquity',
    slug: 'liquity-ethereum',
    expectedProviderSlug: 'liquity',
    subgraphId: '2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY',
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '2.0.1' },
  },
];

export const BASE_LENDING_TARGETS: readonly DeploymentTarget[] = [
  {
    label: 'seamless-protocol-base',
    chain: 'base',
    protocol: 'Seamless Protocol',
    slug: 'seamless-protocol-base',
    expectedProviderSlug: 'seamless-protocol',
    subgraphId: '2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP',
    schemaFamily: 'lending',
    expected: { network: 'BASE', protocolType: 'LENDING', schemaVersion: '3.1.0' },
  },
  {
    label: 'moonwell-base',
    chain: 'base',
    protocol: 'Moonwell',
    slug: 'moonwell-base',
    expectedProviderSlug: 'moonwell',
    subgraphId: '33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg',
    schemaFamily: 'lending',
    expected: { network: 'BASE', protocolType: 'LENDING', schemaVersion: '2.0.1' },
  },
];

/** Minimum distinct verified Ethereum identities for the Sprint 1 gate (D11). */
export const ETHEREUM_GATE_MINIMUM_PROTOCOLS = 5;

/** Base keeps only if every configured Base target verifies (D11, corrected gate). */
export const BASE_GATE_MINIMUM_PROTOCOLS = 2;

// An inconsistent registry is a configuration error, caught at load time
// before any query is made.
validateRegistry([...ETHEREUM_LENDING_TARGETS, ...BASE_LENDING_TARGETS]);
