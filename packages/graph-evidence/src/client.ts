import type { ChainId } from '@cas/contracts';

import { adaptStandardizedTvl, type StandardizedTvlReading } from './adapter.js';
import { GraphProbeError } from './errors.js';
import { parseGatewayBaseUrl, type ParsedGatewayBase } from './gateway-url.js';
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
}

export interface StandardizedTvlRequest {
  readonly subgraphId: string;
  /** Chain the configured target is expected on; compared, never trusted, downstream. */
  readonly targetChain: ChainId;
  /** Registry slug of the configured target; never substituted for the provider slug. */
  readonly targetSlug: string;
  readonly snapshots?: number | undefined;
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
 */
export class GraphGatewayClient {
  readonly #apiKey: string;
  readonly #gateway: ParsedGatewayBase;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
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
  }

  /** Sanitized endpoint description, safe to print and to store in provenance. */
  get gateway(): ParsedGatewayBase {
    return this.#gateway;
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

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
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

    if (!response.ok) {
      throw new GraphProbeError('http', `gateway returned HTTP ${response.status}`, {
        subgraphId: request.subgraphId,
        status: response.status,
        body: this.redact(text).slice(0, 300),
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
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
