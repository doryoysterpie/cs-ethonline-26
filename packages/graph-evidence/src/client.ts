import { RESOURCE_LIMITS, type ChainId, type GraphLimits } from '@cas/contracts';

import { adaptStandardizedTvl, type StandardizedTvlReading } from './adapter.js';
import { readBodyBounded, type BoundedBody } from './bounded-body.js';
import { GraphProbeError, isGraphProbeError } from './errors.js';
import { parseGatewayBaseUrl, type ParsedGatewayBase } from './gateway-url.js';
import { parseJsonBounded, type JsonShapeLimits } from './json-shape.js';
import { DEFAULT_SNAPSHOT_COUNT, STANDARDIZED_TVL_QUERY, queryDocumentSha256 } from './query.js';
import { createRedactor, type Redactor } from './redact.js';

export { DEFAULT_GATEWAY_BASE_URL } from './gateway-url.js';
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Public Subgraph IDs are base58 strings; anything else is rejected before a request is made. */
const SUBGRAPH_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{40,50}$/;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GraphGatewayClientOptions {
  readonly apiKey: string | undefined;
  readonly gatewayBaseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Test hook only. Production takes the versioned defaults from
   * `RESOURCE_LIMITS.graph`; a test lowers one limit to reach its boundary.
   */
  readonly limits?: Partial<GraphLimits> | undefined;
}

export interface StandardizedTvlRequest {
  readonly subgraphId: string;
  /** Chain the configured target is expected on; compared, never trusted, downstream. */
  readonly targetChain: ChainId;
  /** Registry slug of the configured target; never substituted for the provider slug. */
  readonly targetSlug: string;
  readonly snapshots?: number | undefined;
}

/** The versioned defaults with any test override applied, every value checked. */
export function resolveGraphLimits(overrides?: Partial<GraphLimits> | undefined): GraphLimits {
  const limits: GraphLimits = { ...RESOURCE_LIMITS.graph, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new GraphProbeError('validation', `graph limit ${key} must be a positive integer`);
    }
  }
  return limits;
}

function describeUnknownError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'UnknownError', message: String(error) };
}

function isAbort(name: string): boolean {
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * True when the validated gateway base carries the active credential in its
 * host or path, raw or percent-encoded. Checked before any request is made so
 * the key can never travel in a URL.
 */
export function gatewayBaseContainsCredential(base: string, key: string): boolean {
  if (key.length === 0) return false;
  const candidates = new Set<string>([base, base.toLowerCase()]);
  try {
    candidates.add(decodeURIComponent(base));
    candidates.add(decodeURIComponent(base).toLowerCase());
  } catch {
    // An undecodable base still gets the raw comparisons.
  }
  const encodedKey = encodeURIComponent(key);
  const needles = [key, key.toLowerCase(), encodedKey, encodedKey.toLowerCase()];
  for (const candidate of candidates) {
    for (const needle of needles) {
      if (candidate.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Minimal live client for a Graph gateway, built on Node's global fetch.
 *
 * - API key travels only in the `Authorization: Bearer` header, never in a URL.
 * - The base URL is structurally validated (`gateway-url.ts`); provenance
 *   records only its sanitized origin and path.
 * - Timeout and fetch implementation are injectable for tests.
 * - Every failure is a GraphProbeError with a distinct kind. Nothing returns
 *   an empty success, and nothing falls back to fixture or replay data.
 * - Resource limits (`RESOURCE_LIMITS.graph`, decision D27) hold at every
 *   step: at most a fixed number of requests in flight, a body read under a
 *   byte limit while it streams, and a JSON document bounded in depth and
 *   size before and after parsing. A crossed limit is a `limit` failure with
 *   a fixed message and numeric details, never a truncated reading.
 */
export class GraphGatewayClient {
  readonly #apiKey: string;
  readonly #gateway: ParsedGatewayBase;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #limits: GraphLimits;
  readonly #jsonLimits: JsonShapeLimits;
  #inFlight = 0;
  readonly redact: Redactor;

  constructor(options: GraphGatewayClientOptions) {
    const key = options.apiKey?.trim() ?? '';
    if (key.length === 0) {
      throw new GraphProbeError(
        'credential',
        'GRAPH_API_KEY is missing. Create a Subgraph Studio API key and export it locally.',
      );
    }
    this.#apiKey = key;
    this.redact = createRedactor([key]);
    this.#gateway = parseGatewayBaseUrl(options.gatewayBaseUrl);
    if (gatewayBaseContainsCredential(this.#gateway.base, key)) {
      throw new GraphProbeError(
        'validation',
        'gateway base URL rejected: contains the active credential',
        { reason: 'contains the active credential' },
      );
    }
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new GraphProbeError('validation', 'timeoutMs must be a positive integer');
    }
    this.#timeoutMs = timeout;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date());
    this.#limits = resolveGraphLimits(options.limits);
    this.#jsonLimits = {
      maxDepth: this.#limits.jsonMaxDepth,
      maxCollectionSize: this.#limits.jsonMaxCollectionSize,
      maxCollections: this.#limits.jsonMaxCollections,
    };
  }

  /** Sanitized endpoint description, safe to print and to store in provenance. */
  get gateway(): ParsedGatewayBase {
    return this.#gateway;
  }

  /** The limits in force. */
  get limits(): GraphLimits {
    return this.#limits;
  }

  /** Requests currently in flight. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Query one deployment with the common document and adapt the response. */
  async queryStandardizedTvl(request: StandardizedTvlRequest): Promise<StandardizedTvlReading> {
    if (!SUBGRAPH_ID_PATTERN.test(request.subgraphId)) {
      throw new GraphProbeError('validation', 'subgraphId is not a valid public Subgraph ID', {
        subgraphId: request.subgraphId,
      });
    }
    const snapshots = request.snapshots ?? DEFAULT_SNAPSHOT_COUNT;
    if (!Number.isInteger(snapshots) || snapshots < 2 || snapshots > 30) {
      throw new GraphProbeError('validation', 'snapshots must be an integer between 2 and 30');
    }
    // The in-flight count is checked and raised synchronously, before the
    // first await, so two callers cannot both pass the check.
    if (this.#inFlight >= this.#limits.concurrentRequests) {
      throw new GraphProbeError('limit', 'gateway request refused: too many concurrent requests', {
        subgraphId: request.subgraphId,
        limit: this.#limits.concurrentRequests,
        inFlight: this.#inFlight,
        phase: 'request',
      });
    }
    this.#inFlight += 1;
    try {
      return await this.#query(request, snapshots);
    } finally {
      this.#inFlight -= 1;
    }
  }

  async #query(
    request: StandardizedTvlRequest,
    snapshots: number,
  ): Promise<StandardizedTvlReading> {
    const url = `${this.#gateway.base}/subgraphs/id/${request.subgraphId}`;
    const queriedAtUtc = this.#now().toISOString();
    const body = JSON.stringify({ query: STANDARDIZED_TVL_QUERY, variables: { snapshots } });
    const signal = AbortSignal.timeout(this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body,
        signal,
      });
    } catch (error) {
      const { name, message } = describeUnknownError(error);
      if (isAbort(name)) {
        throw new GraphProbeError('timeout', `gateway request exceeded ${this.#timeoutMs} ms`, {
          subgraphId: request.subgraphId,
          timeoutMs: this.#timeoutMs,
          phase: 'request',
        });
      }
      throw new GraphProbeError('network', `gateway request failed: ${this.redact(message)}`, {
        subgraphId: request.subgraphId,
        phase: 'request',
      });
    }

    // A successful body is evidence and is read under the reject policy: one
    // byte over the limit fails the query. A non-2xx body is only ever a
    // redacted snippet, so it is cut at the snippet bound and the rest of the
    // stream is discarded without being read.
    let received: BoundedBody;
    try {
      received = response.ok
        ? await readBodyBounded(response, this.#limits.responseBodyBytes, 'reject')
        : await readBodyBounded(response, this.#limits.httpErrorSnippetBytes, 'truncate');
    } catch (error) {
      if (isGraphProbeError(error)) throw error;
      const { name, message } = describeUnknownError(error);
      if (isAbort(name)) {
        throw new GraphProbeError(
          'timeout',
          `gateway response body read exceeded ${this.#timeoutMs} ms`,
          { subgraphId: request.subgraphId, timeoutMs: this.#timeoutMs, phase: 'body' },
        );
      }
      throw new GraphProbeError(
        'network',
        `gateway response body read failed: ${this.redact(message)}`,
        { subgraphId: request.subgraphId, phase: 'body' },
      );
    }
    const text = received.text;

    if (!response.ok) {
      throw new GraphProbeError('http', `gateway returned HTTP ${response.status}`, {
        subgraphId: request.subgraphId,
        status: response.status,
        body: this.redact(text).slice(0, 300),
        bodyTruncated: received.truncated,
      });
    }

    let payload: unknown;
    try {
      payload = parseJsonBounded(text, this.#jsonLimits);
    } catch (error) {
      if (isGraphProbeError(error)) throw error;
      throw new GraphProbeError('schema', 'gateway response is not JSON', {
        subgraphId: request.subgraphId,
        body: this.redact(text).slice(0, 300),
      });
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new GraphProbeError('schema', 'gateway response is not an object', {
        subgraphId: request.subgraphId,
      });
    }
    const envelope = payload as { data?: unknown; errors?: unknown };
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      const messages = envelope.errors.map((e) =>
        this.redact(
          typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e),
        ),
      );
      throw new GraphProbeError(
        'graphql',
        `gateway returned GraphQL errors: ${messages.join('; ')}`,
        { subgraphId: request.subgraphId, errors: messages },
      );
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new GraphProbeError('schema', 'gateway response has no data', {
        subgraphId: request.subgraphId,
      });
    }

    return adaptStandardizedTvl(envelope.data, {
      subgraphId: request.subgraphId,
      targetChain: request.targetChain,
      targetSlug: request.targetSlug,
      queriedAtUtc,
      queryDocumentSha256: queryDocumentSha256(),
      provider: this.#gateway.provider,
      providerBase: this.#gateway.base,
    });
  }
}
