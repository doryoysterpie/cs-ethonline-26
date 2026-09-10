import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ChainId, DataOrigin } from '@cas/contracts';
import {
  completeGraphSignalRun,
  findGraphSignalRunByIdempotencyKey,
  getGraphSignalRun,
  insertGraphSignals,
  insertRunningGraphSignalRun,
  isDatabaseError,
  type Database,
  type GraphSignalRunRecord,
  type NewGraphSignal,
  type Queryable,
} from '@cas/database';
import { evidenceContractHash, CONTRACT_VERSION, RESOLVER_VERSION } from '@cas/evidence';

import { IngestionError } from '../editorial/errors.js';

/**
 * Ingesting a Graph signal snapshot into the database.
 *
 * A snapshot is a set of normalized TVL-delta observations for the seven
 * standardized identities decision D23 retained. Two origins are supported and
 * they are never confused: a `live` snapshot is read from a provider by
 * `@cas/graph-evidence`, and a `fixture` or `replay` snapshot is read from a
 * file the caller names explicitly. The origin is always given explicitly;
 * there is no default and no inference, so a replayed file can never present
 * itself as a live feed.
 *
 * What is stored is the sanitized host, the query digest, the validated
 * provider identity, the block context and a canonical response digest. The
 * provider payload, the Authorization header and the API key are not stored
 * and have no column to be stored in.
 */

export const SIGNAL_VERSION = 'standardized-tvl-signal@1';

/** One observation as a snapshot file presents it. */
export interface SnapshotObservation {
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly subgraphDeploymentId: string | null;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly observedAt: string;
  readonly baselineObservedAt: string;
  readonly currentTvlUsd: string;
  readonly baselineTvlUsd: string;
  readonly deltaUsd: string;
  readonly deltaPercent: string;
}

export interface SignalSnapshot {
  readonly gatewayHost: string;
  readonly querySha256: string;
  readonly observations: readonly SnapshotObservation[];
}

export interface IngestSnapshotRequest {
  readonly snapshotPath: string;
  readonly dataOrigin: DataOrigin;
}

export interface IngestSnapshotOutcome {
  readonly outcome: 'ingested' | 'already_ingested';
  readonly run: GraphSignalRunRecord;
  readonly signalCount: number;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^-?\d{1,32}(\.\d{1,18})?$/u;

function invalid(code: string, message: string): IngestionError {
  return new IngestionError('structural', code, message);
}

/**
 * Validates a snapshot before a single row is written.
 *
 * The checks are shape checks on a closed set of fields. A snapshot file is
 * untrusted input like any other: it cannot introduce a field the schema does
 * not have, and it cannot smuggle a credential into a host or a digest,
 * because both are matched against patterns that admit neither a scheme, a
 * userinfo section, a path nor a query string.
 */
export function assertSnapshot(value: unknown): SignalSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('snapshot_invalid', 'the snapshot is not an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['gatewayHost', 'querySha256', 'observations']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid('snapshot_invalid', 'the snapshot carries an unknown key');
  }
  const host = record['gatewayHost'];
  const query = record['querySha256'];
  const observations = record['observations'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw invalid('snapshot_invalid', 'the snapshot gateway host is not a bare hostname');
  }
  if (typeof query !== 'string' || !HEX64.test(query)) {
    throw invalid('snapshot_invalid', 'the snapshot query digest is not a SHA-256 value');
  }
  if (!Array.isArray(observations) || observations.length === 0 || observations.length > 500) {
    throw invalid('snapshot_invalid', 'the snapshot observation list is empty or too large');
  }
  const parsed: SnapshotObservation[] = [];
  for (const entry of observations) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalid('snapshot_invalid', 'an observation is not an object');
    }
    const row = entry as Record<string, unknown>;
    const fields = new Set([
      'chain',
      'protocolSlug',
      'subgraphDeploymentId',
      'blockNumber',
      'blockHash',
      'observedAt',
      'baselineObservedAt',
      'currentTvlUsd',
      'baselineTvlUsd',
      'deltaUsd',
      'deltaPercent',
    ]);
    for (const key of Object.keys(row)) {
      if (!fields.has(key))
        throw invalid('snapshot_invalid', 'an observation carries an unknown key');
    }
    const chain = row['chain'];
    const slug = row['protocolSlug'];
    if (chain !== 'ethereum' && chain !== 'base') {
      throw invalid('snapshot_invalid', 'an observation names an unsupported chain');
    }
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      throw invalid('snapshot_invalid', 'an observation names an invalid protocol slug');
    }
    for (const key of ['observedAt', 'baselineObservedAt'] as const) {
      const at = row[key];
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        throw invalid('snapshot_invalid', 'an observation carries an invalid timestamp');
      }
    }
    for (const key of ['currentTvlUsd', 'baselineTvlUsd', 'deltaUsd', 'deltaPercent'] as const) {
      const amount = row[key];
      if (typeof amount !== 'string' || !DECIMAL.test(amount)) {
        throw invalid('snapshot_invalid', 'an observation carries an invalid decimal value');
      }
    }
    const deployment = row['subgraphDeploymentId'] ?? null;
    if (
      deployment !== null &&
      (typeof deployment !== 'string' || !/^[A-Za-z0-9]{1,128}$/u.test(deployment))
    ) {
      throw invalid('snapshot_invalid', 'an observation carries an invalid deployment id');
    }
    const blockNumber = row['blockNumber'] ?? null;
    if (
      blockNumber !== null &&
      (typeof blockNumber !== 'number' || !Number.isInteger(blockNumber) || blockNumber < 0)
    ) {
      throw invalid('snapshot_invalid', 'an observation carries an invalid block number');
    }
    const blockHash = row['blockHash'] ?? null;
    if (
      blockHash !== null &&
      (typeof blockHash !== 'string' || !/^0x[0-9a-f]{64}$/u.test(blockHash))
    ) {
      throw invalid('snapshot_invalid', 'an observation carries an invalid block hash');
    }
    parsed.push({
      chain,
      protocolSlug: slug,
      subgraphDeploymentId: deployment,
      blockNumber,
      blockHash,
      observedAt: String(row['observedAt']),
      baselineObservedAt: String(row['baselineObservedAt']),
      currentTvlUsd: String(row['currentTvlUsd']),
      baselineTvlUsd: String(row['baselineTvlUsd']),
      deltaUsd: String(row['deltaUsd']),
      deltaPercent: String(row['deltaPercent']),
    });
  }
  const seen = new Set<string>();
  for (const observation of parsed) {
    const key = `${observation.chain}:${observation.protocolSlug}`;
    if (seen.has(key)) {
      throw invalid('snapshot_invalid', 'the snapshot names one target more than once');
    }
    seen.add(key);
  }
  return { gatewayHost: host, querySha256: query, observations: parsed };
}

/** Canonical digest of one validated observation, stored beside the signal. */
export function observationDigest(observation: SnapshotObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        observation.chain,
        observation.protocolSlug,
        observation.subgraphDeploymentId,
        observation.blockNumber,
        observation.blockHash,
        observation.observedAt,
        observation.baselineObservedAt,
        observation.currentTvlUsd,
        observation.baselineTvlUsd,
        observation.deltaUsd,
        observation.deltaPercent,
      ]),
      'utf8',
    )
    .digest('hex');
}

function snapshotIdempotencyKey(snapshot: SignalSnapshot, origin: DataOrigin): string {
  const digests = snapshot.observations.map(observationDigest).sort();
  return createHash('sha256')
    .update(
      JSON.stringify({ origin, host: snapshot.gatewayHost, query: snapshot.querySha256, digests }),
    )
    .digest('hex');
}

/**
 * Ingests one snapshot as a completed signal run.
 *
 * The run is inserted `running`, its signals are written, and completion is
 * validated by the database against what was stored. Re-ingesting the same
 * snapshot under the same origin returns the original run and writes nothing.
 */
export async function ingestSnapshot(
  db: Database,
  request: IngestSnapshotRequest,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly makeId?: (() => string) | undefined;
  } = {},
): Promise<IngestSnapshotOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(request.snapshotPath, 'utf8')) as unknown;
  } catch {
    throw invalid('snapshot_unreadable', 'the snapshot file could not be read as JSON');
  }
  const snapshot = assertSnapshot(parsed);
  const idempotencyKey = snapshotIdempotencyKey(snapshot, request.dataOrigin);

  const existing = await db.withClient((client) =>
    findGraphSignalRunByIdempotencyKey(client, idempotencyKey),
  );
  if (existing !== null && existing.status === 'completed') {
    return { outcome: 'already_ingested', run: existing, signalCount: existing.signalCount };
  }

  const runId = makeId();
  const startedAt = now().toISOString();
  try {
    await db.withTransaction(async (tx: Queryable) => {
      await insertRunningGraphSignalRun(tx, {
        id: runId,
        dataOrigin: request.dataOrigin,
        signalVersion: SIGNAL_VERSION,
        contractVersion: CONTRACT_VERSION,
        contractHash: evidenceContractHash(),
        querySha256: snapshot.querySha256,
        gatewayHost: snapshot.gatewayHost,
        idempotencyKey,
        targetCount: snapshot.observations.length,
        startedAt,
      });
      const signals: NewGraphSignal[] = snapshot.observations.map((observation) => ({
        id: makeId(),
        signalRunId: runId,
        dataOrigin: request.dataOrigin,
        chain: observation.chain,
        protocolSlug: observation.protocolSlug,
        subgraphDeploymentId: observation.subgraphDeploymentId,
        blockNumber: observation.blockNumber,
        blockHash: observation.blockHash,
        observedAt: observation.observedAt,
        baselineObservedAt: observation.baselineObservedAt,
        elapsedSeconds: Math.max(
          0,
          Math.round(
            (Date.parse(observation.observedAt) - Date.parse(observation.baselineObservedAt)) /
              1000,
          ),
        ),
        currentTvlUsd: observation.currentTvlUsd,
        baselineTvlUsd: observation.baselineTvlUsd,
        deltaUsd: observation.deltaUsd,
        deltaPercent: observation.deltaPercent,
        responseDigest: observationDigest(observation),
        createdAt: startedAt,
      }));
      await insertGraphSignals(tx, signals);
      await completeGraphSignalRun(tx, runId, signals.length, 0, now().toISOString());
    });
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') {
      const winner = await db.withClient((client) =>
        findGraphSignalRunByIdempotencyKey(client, idempotencyKey),
      );
      if (winner !== null && winner.status === 'completed') {
        return { outcome: 'already_ingested', run: winner, signalCount: winner.signalCount };
      }
    }
    throw error;
  }
  const stored = await db.withClient((client) => getGraphSignalRun(client, runId));
  if (stored === null || stored.status !== 'completed') {
    throw new IngestionError(
      'database',
      'signal_run_not_completed',
      'the signal run did not complete',
    );
  }
  return { outcome: 'ingested', run: stored, signalCount: stored.signalCount };
}

/** Resolver identity, reported beside every ingested run. */
export const EVIDENCE_IDENTITY = {
  resolverVersion: RESOLVER_VERSION,
  contractVersion: CONTRACT_VERSION,
} as const;
