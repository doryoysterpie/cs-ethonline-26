import type { ChainId } from '@cas/contracts';

/**
 * Selected live deployments for the Sprint 1 proof. Configuration only: the
 * public Subgraph IDs come from the Messari deployment registry
 * (github.com/messari/subgraphs, deployment/deployment.json) and were verified
 * live on 5 September 2026. See docs/SPRINT-1-REPORT.md for the selection and
 * rejection evidence. Only these values vary between deployments; the query
 * document and the adapter never do.
 */
export interface DeploymentTarget {
  readonly chain: ChainId;
  /** Protocol name as the project refers to it. */
  readonly protocol: string;
  /** Registry deployment slug. */
  readonly slug: string;
  readonly subgraphId: string;
  readonly schemaFamily: 'lending';
  /** Schema version recorded in the registry; the live value is in provenance. */
  readonly registrySchemaVersion: string;
}

export const ETHEREUM_LENDING_TARGETS: readonly DeploymentTarget[] = [
  {
    chain: 'ethereum',
    protocol: 'Aave v3',
    slug: 'aave-v3-ethereum',
    subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk',
    schemaFamily: 'lending',
    registrySchemaVersion: '3.1.0',
  },
  {
    chain: 'ethereum',
    protocol: 'Spark',
    slug: 'spark-lend-ethereum',
    subgraphId: 'GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si',
    schemaFamily: 'lending',
    registrySchemaVersion: '3.1.0',
  },
  {
    chain: 'ethereum',
    protocol: 'MakerDAO',
    slug: 'makerdao-ethereum',
    subgraphId: '8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1',
    schemaFamily: 'lending',
    registrySchemaVersion: '2.0.1',
  },
  {
    chain: 'ethereum',
    protocol: 'Compound v3',
    slug: 'compound-v3-ethereum',
    subgraphId: 'AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9',
    schemaFamily: 'lending',
    registrySchemaVersion: '3.1.0',
  },
  {
    chain: 'ethereum',
    protocol: 'Liquity',
    slug: 'liquity-ethereum',
    subgraphId: '2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY',
    schemaFamily: 'lending',
    registrySchemaVersion: '2.0.1',
  },
];

export const BASE_LENDING_TARGETS: readonly DeploymentTarget[] = [
  {
    chain: 'base',
    protocol: 'Seamless Protocol',
    slug: 'seamless-protocol-base',
    subgraphId: '2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP',
    schemaFamily: 'lending',
    registrySchemaVersion: '3.1.0',
  },
  {
    chain: 'base',
    protocol: 'Moonwell',
    slug: 'moonwell-base',
    subgraphId: '33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg',
    schemaFamily: 'lending',
    registrySchemaVersion: '2.0.1',
  },
];

/** Minimum distinct Ethereum protocols with a valid signal for the Sprint 1 gate (D11). */
export const ETHEREUM_GATE_MINIMUM_PROTOCOLS = 5;
