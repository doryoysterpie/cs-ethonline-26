import type {
  ChainId,
  GraphQueryProvenance,
  ProtocolIdentity,
  ProtocolTvlObservation,
} from '@cas/contracts';

import { parseDecimal } from './decimal.js';
import { GraphProbeError } from './errors.js';

/**
 * Response adapter for the common standardized query. One adapter serves every
 * selected deployment; nothing in here branches on protocol or chain.
 * Validation is strict: a missing or malformed field is an explicit failure.
 */

export interface AdapterContext {
  readonly subgraphId: string;
  readonly chain: ChainId;
  readonly slug: string;
  readonly queriedAtUtc: string;
  readonly queryDocumentSha256: string;
}

export interface StandardizedTvlReading {
  readonly protocol: ProtocolIdentity;
  readonly protocolType: string | null;
  readonly reportedNetwork: string | null;
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
  if (typeof value !== 'string' || value.length === 0) {
    throw new GraphProbeError('schema', `${field} is missing or not a string`, { field });
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
  const name = requireString(protocol['name'], 'protocols[0].name');
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
    provider: 'the-graph-gateway',
    subgraphId: ctx.subgraphId,
    deploymentId,
    chain: ctx.chain,
    queriedAtUtc: ctx.queriedAtUtc,
    queryDocumentSha256: ctx.queryDocumentSha256,
    block: { number: blockNumber, hash: blockHash, timestamp: blockTimestamp },
    snapshotTimestamps,
    hasIndexingErrors,
    schemaVersion: optionalString(protocol['schemaVersion']),
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
    protocol: { name, slug: ctx.slug, chain: ctx.chain },
    protocolType: optionalString(protocol['type']),
    reportedNetwork: optionalString(protocol['network']),
    observations,
    provenance,
  };
}
