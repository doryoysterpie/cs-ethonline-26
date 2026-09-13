import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';

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
 * Ingesting Graph signals into the database.
 *
 * There are exactly two ways a signal run comes to exist, and they are two
 * functions with two input types that share no field but their discriminant
 * (audit finding F1):
 *
 *   - **A file** (`ingestSnapshotFile`) carries a `fixture` or `replay`
 *     origin. `live` is not a member of `FileOrigin`, is refused at runtime
 *     before the file is opened, and cannot be added by a caller, because the
 *     only function that writes a live run takes no path at all.
 *   - **The Graph client** (`ingestLiveEvaluations`) carries validated target
 *     evaluations: identity checked against the registry, freshness checked
 *     against the query time, a provider base that names the gateway, and a
 *     query digest that matches the one the run records. The origin is not a
 *     parameter. It is `live` because the input is the client's, and every
 *     invariant the client established is re-checked here before a row is
 *     written.
 *
 * Nothing infers an origin from a filename, a label, a host or a caller's
 * word. The writer both paths share is private to this module.
 *
 * A snapshot is untrusted input (audit finding F4). It is validated
 * recursively against a closed shape before any value is read: a plain object
 * or plain array, no symbol keys, own property names equal to the allowlist,
 * every property a plain enumerable data property, and no proxy. An accessor
 * is refused without being invoked. What is stored is the sanitized host, the
 * query digest, the validated identity, the block context and a canonical
 * response digest; there is no column for a payload, a header or a key.
 */

export const SIGNAL_VERSION = 'standardized-tvl-signal@1';

/** Origins a file may carry. `live` is not one, and cannot be made one. */
export const FILE_ORIGINS = ['fixture', 'replay'] as const;
export type FileOrigin = (typeof FILE_ORIGINS)[number];

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

/** File-backed ingestion. The origin type admits no `live`. */
export interface FileIngestInput {
  readonly kind: 'file';
  readonly snapshotPath: string;
  readonly dataOrigin: FileOrigin;
}

/**
 * One validated target evaluation as `@cas/graph-evidence` produces it. Only
 * the fields this module checks and stores are named; a valid evaluation
 * carries a signal, no failure, no mismatch and a fresh observation, and this
 * module refuses anything else rather than trusting the `valid` flag alone.
 */
export interface LiveTargetEvaluation {
  readonly target: {
    readonly chain: ChainId;
    readonly slug: string;
    readonly expectedProviderSlug: string;
    readonly subgraphId: string;
  };
  readonly valid: boolean;
  readonly failure: unknown;
  readonly mismatches: readonly unknown[];
  readonly freshness: { readonly fresh: boolean } | null;
  readonly signal: {
    readonly protocol: { readonly slug: string; readonly chain: ChainId };
    readonly current: {
      readonly timestamp: number;
      readonly blockNumber: number | null;
      readonly totalValueLockedUsd: string;
    };
    readonly baseline: { readonly timestamp: number; readonly totalValueLockedUsd: string };
    readonly elapsedSeconds: number;
    readonly deltaUsd: string;
    readonly deltaPercent: string;
    readonly provenance: {
      readonly origin: DataOrigin;
      readonly providerBase: string;
      readonly deploymentId: string | null;
      readonly queriedAtUtc: string;
      readonly queryDocumentSha256: string;
      readonly block: { readonly number: number; readonly hash: string | null };
    };
  } | null;
}

/** Graph-client ingestion. There is no path and no origin field. */
export interface GraphClientIngestInput {
  readonly kind: 'graph-client';
  readonly queriedAtUtc: string;
  readonly gatewayHost: string;
  readonly querySha256: string;
  readonly evaluations: readonly LiveTargetEvaluation[];
}

export interface IngestSnapshotOutcome {
  readonly outcome: 'ingested' | 'already_ingested';
  readonly run: GraphSignalRunRecord;
  readonly signalCount: number;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/u;
/** RFC 2606 reserved names and the loopback name: fixtures live here, nothing live does. */
const RESERVED_HOST = /(^|\.)(example|invalid|test|localhost)$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/u;
const DEPLOYMENT = /^[A-Za-z0-9]{1,128}$/u;
const DECIMAL = /^-?\d{1,32}(\.\d{1,18})?$/u;
const MAX_OBSERVATIONS = 500;

function invalid(code: string, message: string): IngestionError {
  return new IngestionError('structural', code, message);
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

// ------------------------------------------------------------ closed shapes

/**
 * A plain object whose own property names are exactly `keys`, every one an
 * enumerable data property. Descriptors are inspected before any value is
 * read, so an accessor is refused rather than invoked. Proxies are refused
 * outright, because a proxy can answer every inspection differently from
 * every read.
 */
function closedRecord(
  value: unknown,
  keys: readonly string[],
  what: string,
): Record<string, unknown> {
  if (types.isProxy(value)) throw invalid('snapshot_invalid', `${what} is a proxy`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('snapshot_invalid', `${what} is not an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid('snapshot_invalid', `${what} does not have a plain prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid('snapshot_invalid', `${what} carries a symbol key`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) {
    throw invalid('snapshot_invalid', `${what} does not carry exactly the expected keys`);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw invalid('snapshot_invalid', `${what} carries a field that is not plain data`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

/** A plain array: `Array.prototype`, no symbols, no own property beyond its indices and length. */
function closedArray(value: unknown, what: string): unknown[] {
  if (types.isProxy(value)) throw invalid('snapshot_invalid', `${what} is a proxy`);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid('snapshot_invalid', `${what} is not a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid('snapshot_invalid', `${what} carries a symbol key`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1) {
    throw invalid('snapshot_invalid', `${what} carries a property beyond its elements`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw invalid('snapshot_invalid', `${what} carries an element that is not plain data`);
    }
    items.push(descriptor.value);
  }
  return items;
}

const SNAPSHOT_KEYS = ['gatewayHost', 'querySha256', 'observations'] as const;
const OBSERVATION_KEYS = [
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
] as const;

function parseObservation(entry: unknown, what: string): SnapshotObservation {
  const row = closedRecord(entry, OBSERVATION_KEYS, what);
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
  const deployment = row['subgraphDeploymentId'];
  if (deployment !== null && (typeof deployment !== 'string' || !DEPLOYMENT.test(deployment))) {
    throw invalid('snapshot_invalid', 'an observation carries an invalid deployment id');
  }
  const blockNumber = row['blockNumber'];
  if (
    blockNumber !== null &&
    (typeof blockNumber !== 'number' || !Number.isInteger(blockNumber) || blockNumber < 0)
  ) {
    throw invalid('snapshot_invalid', 'an observation carries an invalid block number');
  }
  const blockHash = row['blockHash'];
  if (blockHash !== null && (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash))) {
    throw invalid('snapshot_invalid', 'an observation carries an invalid block hash');
  }
  return {
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
  };
}

/**
 * Validates a snapshot before a single row is written. Shape first, then
 * values, then the rule that one target appears once.
 */
export function assertSnapshot(value: unknown): SignalSnapshot {
  const record = closedRecord(value, SNAPSHOT_KEYS, 'the snapshot');
  const host = record['gatewayHost'];
  const query = record['querySha256'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw invalid('snapshot_invalid', 'the snapshot gateway host is not a bare hostname');
  }
  if (typeof query !== 'string' || !HEX64.test(query)) {
    throw invalid('snapshot_invalid', 'the snapshot query digest is not a SHA-256 value');
  }
  const entries = closedArray(record['observations'], 'the observation list');
  if (entries.length === 0 || entries.length > MAX_OBSERVATIONS) {
    throw invalid('snapshot_invalid', 'the snapshot observation list is empty or too large');
  }
  const parsed = entries.map((entry) => parseObservation(entry, 'an observation'));
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

// ------------------------------------------------------------- the writer

interface WriterOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
}

/**
 * Writes one validated snapshot as a completed signal run. Private: the only
 * callers are the two ingestion functions below, and the origin they pass is
 * fixed by which one they are.
 */
async function persistSignalRun(
  db: Database,
  snapshot: SignalSnapshot,
  origin: DataOrigin,
  options: WriterOptions,
): Promise<IngestSnapshotOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const idempotencyKey = snapshotIdempotencyKey(snapshot, origin);

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
        dataOrigin: origin,
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
        dataOrigin: origin,
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

// ----------------------------------------------------------- file ingestion

const FILE_INPUT_KEYS = ['kind', 'snapshotPath', 'dataOrigin'] as const;

/**
 * Refuses everything but a file input carrying a file origin. The `live`
 * refusal is the one that matters: it happens here, before the path is
 * opened, before a database handle is used, and with a fixed message.
 */
export function assertFileIngestInput(value: unknown): FileIngestInput {
  const record = closedRecord(value, FILE_INPUT_KEYS, 'the ingestion request');
  if (record['kind'] !== 'file') {
    throw configuration('ingest_kind_invalid', 'file ingestion takes a file input');
  }
  const snapshotPath = record['snapshotPath'];
  if (typeof snapshotPath !== 'string' || snapshotPath.length === 0) {
    throw configuration('file_required', 'a snapshot path is required');
  }
  const origin = record['dataOrigin'];
  if (origin === 'live') {
    throw configuration(
      'origin_not_file_backed',
      'a file can be ingested as fixture or replay only; live evidence comes from the Graph client, never from a file',
    );
  }
  if (origin !== 'fixture' && origin !== 'replay') {
    throw configuration(
      'origin_required',
      'the origin must be given explicitly as fixture or replay; there is no default',
    );
  }
  return { kind: 'file', snapshotPath, dataOrigin: origin };
}

/**
 * Ingests one snapshot file as a completed signal run under a file origin.
 * Re-ingesting the same file under the same origin returns the original run
 * and writes nothing.
 */
export async function ingestSnapshotFile(
  db: Database,
  input: FileIngestInput,
  options: WriterOptions = {},
): Promise<IngestSnapshotOutcome> {
  const request = assertFileIngestInput(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(request.snapshotPath, 'utf8')) as unknown;
  } catch {
    throw invalid('snapshot_unreadable', 'the snapshot file could not be read as JSON');
  }
  return persistSignalRun(db, assertSnapshot(parsed), request.dataOrigin, options);
}

// ----------------------------------------------------------- live ingestion

const CLIENT_INPUT_KEYS = [
  'kind',
  'queriedAtUtc',
  'gatewayHost',
  'querySha256',
  'evaluations',
] as const;

function liveInvalid(message: string): IngestionError {
  return new IngestionError('structural', 'live_evaluation_invalid', message);
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Re-checks every invariant a valid Graph-client evaluation carries and
 * turns the set into the snapshot shape the writer stores. The checks are the
 * client's own, repeated: this module does not trust `valid` alone, and it
 * does not accept an evaluation whose provenance says anything but `live`,
 * whose digest differs from the run's, or whose provider base does not name
 * the gateway host the run records.
 */
function assertGraphClientInput(value: unknown): {
  readonly snapshot: SignalSnapshot;
  readonly queriedAtUtc: string;
} {
  const record = closedRecord(value, CLIENT_INPUT_KEYS, 'the live ingestion request');
  if (record['kind'] !== 'graph-client') {
    throw configuration('ingest_kind_invalid', 'live ingestion takes a Graph-client input');
  }
  const queriedAtUtc = record['queriedAtUtc'];
  if (typeof queriedAtUtc !== 'string' || Number.isNaN(Date.parse(queriedAtUtc))) {
    throw liveInvalid('the query time is not an instant');
  }
  const host = record['gatewayHost'];
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw liveInvalid('the gateway host is not a bare hostname');
  }
  if (RESERVED_HOST.test(host)) {
    throw liveInvalid('a live run cannot be served from a reserved-domain host');
  }
  const query = record['querySha256'];
  if (typeof query !== 'string' || !HEX64.test(query)) {
    throw liveInvalid('the query digest is not a SHA-256 value');
  }
  const evaluations = record['evaluations'];
  if (
    !Array.isArray(evaluations) ||
    evaluations.length === 0 ||
    evaluations.length > MAX_OBSERVATIONS
  ) {
    throw liveInvalid('the evaluation list is empty or too large');
  }

  const observations: SnapshotObservation[] = [];
  for (const candidate of evaluations as readonly LiveTargetEvaluation[]) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      candidate.valid !== true ||
      candidate.failure !== null ||
      !Array.isArray(candidate.mismatches) ||
      candidate.mismatches.length !== 0 ||
      candidate.freshness === null ||
      candidate.freshness.fresh !== true ||
      candidate.signal === null
    ) {
      throw liveInvalid('every evaluation must be valid, fresh and free of mismatches');
    }
    const signal = candidate.signal;
    const provenance = signal.provenance;
    if (provenance.origin !== 'live') {
      throw liveInvalid('a live run only accepts provenance the live client produced');
    }
    if (provenance.queryDocumentSha256 !== query || provenance.queriedAtUtc !== queriedAtUtc) {
      throw liveInvalid('an evaluation does not belong to this query');
    }
    let providerHost: string;
    try {
      const base = new URL(provenance.providerBase);
      if (base.protocol !== 'https:' || base.username !== '' || base.password !== '') {
        throw new Error('not a bare https base');
      }
      providerHost = base.hostname;
    } catch {
      throw liveInvalid('an evaluation names a provider base that is not a bare https origin');
    }
    if (providerHost !== host) {
      throw liveInvalid('an evaluation was served by a different host than the run records');
    }
    if (
      signal.protocol.chain !== candidate.target.chain ||
      signal.protocol.slug !== candidate.target.expectedProviderSlug
    ) {
      throw liveInvalid('an evaluation identity does not match its registry target');
    }
    if (!SLUG.test(signal.protocol.slug)) {
      throw liveInvalid('an evaluation carries an invalid provider slug');
    }
    for (const amount of [
      signal.current.totalValueLockedUsd,
      signal.baseline.totalValueLockedUsd,
      signal.deltaUsd,
      signal.deltaPercent,
    ]) {
      if (typeof amount !== 'string' || !DECIMAL.test(amount)) {
        throw liveInvalid('an evaluation carries an invalid decimal value');
      }
    }
    for (const stamp of [signal.current.timestamp, signal.baseline.timestamp]) {
      if (!Number.isInteger(stamp) || stamp <= 0) {
        throw liveInvalid('an evaluation carries an invalid observation time');
      }
    }
    const deployment = provenance.deploymentId;
    if (deployment !== null && (typeof deployment !== 'string' || !DEPLOYMENT.test(deployment))) {
      throw liveInvalid('an evaluation carries an invalid deployment id');
    }
    const blockNumber = signal.current.blockNumber ?? provenance.block.number;
    if (!Number.isInteger(blockNumber) || blockNumber < 0) {
      throw liveInvalid('an evaluation carries an invalid block number');
    }
    const blockHash = provenance.block.hash;
    if (blockHash !== null && (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash))) {
      throw liveInvalid('an evaluation carries an invalid block hash');
    }
    observations.push({
      chain: signal.protocol.chain,
      protocolSlug: signal.protocol.slug,
      subgraphDeploymentId: deployment,
      blockNumber,
      blockHash,
      observedAt: isoSeconds(signal.current.timestamp),
      baselineObservedAt: isoSeconds(signal.baseline.timestamp),
      currentTvlUsd: signal.current.totalValueLockedUsd,
      baselineTvlUsd: signal.baseline.totalValueLockedUsd,
      deltaUsd: signal.deltaUsd,
      deltaPercent: signal.deltaPercent,
    });
  }
  // The same closed validation the file path applies, so both paths store
  // exactly one shape.
  const snapshot = assertSnapshot({ gatewayHost: host, querySha256: query, observations });
  return { snapshot, queriedAtUtc };
}

/**
 * Ingests validated Graph-client evaluations as a completed `live` signal run.
 * The origin is not an argument: it follows from what the input is.
 */
export async function ingestLiveEvaluations(
  db: Database,
  input: GraphClientIngestInput,
  options: WriterOptions = {},
): Promise<IngestSnapshotOutcome> {
  const { snapshot } = assertGraphClientInput(input);
  return persistSignalRun(db, snapshot, 'live', options);
}

/** Resolver identity, reported beside every ingested run. */
export const EVIDENCE_IDENTITY = {
  resolverVersion: RESOLVER_VERSION,
  contractVersion: CONTRACT_VERSION,
} as const;
