import type {
  ChainId,
  GraphProvider,
  GraphQueryProvenance,
  ProtocolIdentity,
  ProtocolTvlObservation,
} from '@cas/contracts';

import { parseDecimal } from './decimal.js';
import { GraphProbeError } from './errors.js';
import { normalizeNetwork } from './network.js';

/**
 * Response adapter for the common standardized query. One adapter serves every
 * selected deployment; nothing in here branches on protocol or chain.
 * Validation is strict: a missing or malformed field is an explicit failure.
 *
 * Two identities are preserved and never merged: the configured target
 * (`ctx.targetChain`, `ctx.targetSlug`, `ctx.subgraphId`) and the identity the
 * provider returned (`ProtocolIdentity`). The provider's name, slug, network,
 * type and schema version are all required.
 */

export interface AdapterContext {
  readonly subgraphId: string;
  readonly targetChain: ChainId;
  readonly targetSlug: string;
  readonly queriedAtUtc: string;
  readonly queryDocumentSha256: string;
  readonly provider: GraphProvider;
  readonly providerBase: string;
}

export interface StandardizedTvlReading {
  /** Identity as returned by the provider. */
  readonly identity: ProtocolIdentity;
  /** Identity the query was configured for. */
  readonly target: { readonly chain: ChainId; readonly slug: string; readonly subgraphId: string };
  readonly observations: readonly ProtocolTvlObservation[];
  readonly provenance: GraphQueryProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GraphProbeError('schema', `${field} is missing or not a non-empty string`, {
      field,
    });
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new GraphProbeError('schema', `${field} is missing or not a non-negative integer`, {
      field,
    });
  }
  return n;
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Validate the `data` object of the common query and build observations plus
 * provenance. Throws GraphProbeError('schema' | 'validation' | 'indexing').
 */
export function adaptStandardizedTvl(data: unknown, ctx: AdapterContext): StandardizedTvlReading {
  if (!isRecord(data)) {
    throw new GraphProbeError('schema', 'response data is not an object');
  }

  const meta = data['_meta'];
  if (!isRecord(meta)) {
    throw new GraphProbeError('schema', '_meta is missing');
  }
  const block = meta['block'];
  if (!isRecord(block)) {
    throw new GraphProbeError('schema', '_meta.block is missing');
  }
  const blockNumber = requireInteger(block['number'], '_meta.block.number');
  const blockHash = optionalString(block['hash']);
  const blockTimestamp = optionalInteger(block['timestamp']);
  const deploymentId = optionalString(meta['deployment']);
  const hasIndexingErrors = meta['hasIndexingErrors'];
  if (typeof hasIndexingErrors !== 'boolean') {
    throw new GraphProbeError('schema', '_meta.hasIndexingErrors is missing');
  }

  const protocols = data['protocols'];
  if (!Array.isArray(protocols) || protocols.length === 0) {
    throw new GraphProbeError('schema', 'no protocol entity returned');
  }
  const protocol = protocols[0];
  if (!isRecord(protocol)) {
    throw new GraphProbeError('schema', 'protocol entity is not an object');
  }

  // Provider identity: every field required, none substituted from the target.
  const name = requireString(protocol['name'], 'protocols[0].name');
  const slug = requireString(protocol['slug'], 'protocols[0].slug');
  const network = requireString(protocol['network'], 'protocols[0].network');
  const protocolType = requireString(protocol['type'], 'protocols[0].type');
  const schemaVersion = requireString(protocol['schemaVersion'], 'protocols[0].schemaVersion');
  const chain = normalizeNetwork(network);
  if (chain === null) {
    throw new GraphProbeError('validation', 'provider network is not a recognized chain', {
      field: 'protocols[0].network',
      received: network,
      subgraphId: ctx.subgraphId,
    });
  }

  const headTvl = requireString(
    protocol['totalValueLockedUSD'],
    'protocols[0].totalValueLockedUSD',
  );
  parseDecimal(headTvl, 'protocols[0].totalValueLockedUSD');

  const snapshots = data['financialsDailySnapshots'];
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new GraphProbeError('schema', 'no financial snapshots returned');
  }

  const observations: ProtocolTvlObservation[] = [];
  const snapshotTimestamps: number[] = [];
  snapshots.forEach((snapshot, index) => {
    if (!isRecord(snapshot)) {
      throw new GraphProbeError('schema', `financialsDailySnapshots[${index}] is not an object`);
    }
    const timestamp = requireInteger(
      snapshot['timestamp'],
      `financialsDailySnapshots[${index}].timestamp`,
    );
    const tvl = requireString(
      snapshot['totalValueLockedUSD'],
      `financialsDailySnapshots[${index}].totalValueLockedUSD`,
    );
    parseDecimal(tvl, `financialsDailySnapshots[${index}].totalValueLockedUSD`);
    snapshotTimestamps.push(timestamp);
    observations.push({
      timestamp,
      blockNumber: optionalInteger(snapshot['blockNumber']),
      totalValueLockedUsd: tvl,
      source: 'financials-daily-snapshot',
      snapshotId: optionalString(snapshot['id']),
    });
  });

  if (blockTimestamp !== null) {
    observations.push({
      timestamp: blockTimestamp,
      blockNumber,
      totalValueLockedUsd: headTvl,
      source: 'protocol-head',
      snapshotId: null,
    });
  }

  const provenance: GraphQueryProvenance = {
    origin: 'live',
    provider: ctx.provider,
    providerBase: ctx.providerBase,
    subgraphId: ctx.subgraphId,
    deploymentId,
    targetChain: ctx.targetChain,
    targetSlug: ctx.targetSlug,
    queriedAtUtc: ctx.queriedAtUtc,
    queryDocumentSha256: ctx.queryDocumentSha256,
    block: { number: blockNumber, hash: blockHash, timestamp: blockTimestamp },
    snapshotTimestamps,
    hasIndexingErrors,
    schemaVersion,
    subgraphVersion: optionalString(protocol['subgraphVersion']),
    methodologyVersion: optionalString(protocol['methodologyVersion']),
  };

  if (hasIndexingErrors) {
    throw new GraphProbeError('indexing', 'provider reports hasIndexingErrors=true', {
      subgraphId: ctx.subgraphId,
      deploymentId,
      blockNumber,
    });
  }

  return {
    identity: { name, slug, network, chain, protocolType, schemaVersion },
    target: { chain: ctx.targetChain, slug: ctx.targetSlug, subgraphId: ctx.subgraphId },
    observations,
    provenance,
  };
}
