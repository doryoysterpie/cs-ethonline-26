import type { ChainId } from '@cas/contracts';

import { adaptStandardizedTvl, type StandardizedTvlReading } from './adapter.js';
import { GraphProbeError } from './errors.js';
import { DEFAULT_SNAPSHOT_COUNT, STANDARDIZED_TVL_QUERY, queryDocumentSha256 } from './query.js';
import { createRedactor, type Redactor } from './redact.js';

/** Default public gateway base. Overridable through GRAPH_GATEWAY_URL. */
export const DEFAULT_GATEWAY_BASE_URL = 'https://gateway.thegraph.com/api';
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
  readonly chain: ChainId;
  readonly slug: string;
  readonly snapshots?: number | undefined;
}

function describeUnknownError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'UnknownError', message: String(error) };
}

/**
 * Minimal live client for The Graph gateway, built on Node's global fetch.
 *
 * - API key travels only in the `Authorization: Bearer` header, never in a URL.
 * - Base URL, timeout and fetch implementation are injectable for tests.
 * - Every failure is a GraphProbeError with a distinct kind. Nothing returns
 *   an empty success, and nothing falls back to fixture or replay data.
 */
export class GraphGatewayClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
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
    const base = (options.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL).trim();
    if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(base)) {
      throw new GraphProbeError('validation', 'gateway base URL must be an https URL');
    }
    this.#baseUrl = base.replace(/\/+$/, '');
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new GraphProbeError('validation', 'timeoutMs must be a positive integer');
    }
    this.#timeoutMs = timeout;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date());
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

    const url = `${this.#baseUrl}/subgraphs/id/${request.subgraphId}`;
    const queriedAtUtc = this.#now().toISOString();
    const body = JSON.stringify({ query: STANDARDIZED_TVL_QUERY, variables: { snapshots } });

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
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const { name, message } = describeUnknownError(error);
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GraphProbeError('timeout', `gateway request exceeded ${this.#timeoutMs} ms`, {
          subgraphId: request.subgraphId,
          timeoutMs: this.#timeoutMs,
        });
      }
      throw new GraphProbeError('network', `gateway request failed: ${this.redact(message)}`, {
        subgraphId: request.subgraphId,
      });
    }

    const text = await response.text();
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
        {
          subgraphId: request.subgraphId,
          errors: messages,
        },
      );
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new GraphProbeError('schema', 'gateway response has no data', {
        subgraphId: request.subgraphId,
      });
    }

    return adaptStandardizedTvl(envelope.data, {
      subgraphId: request.subgraphId,
      chain: request.chain,
      slug: request.slug,
      queriedAtUtc,
      queryDocumentSha256: queryDocumentSha256(),
    });
  }
}
