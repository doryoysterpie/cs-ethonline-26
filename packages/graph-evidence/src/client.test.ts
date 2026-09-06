import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_GATEWAY_BASE_URL, GraphGatewayClient, type FetchLike } from './client.js';
import { GraphProbeError } from './errors.js';
import { STANDARDIZED_TVL_QUERY, queryDocumentSha256 } from './query.js';
import { REDACTED } from './redact.js';
import { TEST_KEY, TEST_SUBGRAPH_ID, T_NOW, jsonResponse, validPayload } from './test-support.js';

const request = {
  subgraphId: TEST_SUBGRAPH_ID,
  targetChain: 'ethereum',
  targetSlug: 'synthetic-lending',
} as const;

async function failure(promise: Promise<unknown>): Promise<GraphProbeError | null> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphProbeError) return error;
    throw error;
  }
  return null;
}

function clientWith(
  fetchImpl: FetchLike,
  apiKey: string | undefined = TEST_KEY,
  gatewayBaseUrl?: string,
): GraphGatewayClient {
  return new GraphGatewayClient({
    apiKey,
    fetchImpl,
    gatewayBaseUrl,
    timeoutMs: 50,
    now: () => new Date(T_NOW * 1000),
  });
}

function responseWithFailingBody(error: unknown): Response {
  const response = new Response('{}', { status: 200 });
  Object.defineProperty(response, 'text', { value: () => Promise.reject(error) });
  return response;
}

describe('GraphGatewayClient', () => {
  it('refuses to construct without a credential', () => {
    expect(() => new GraphGatewayClient({ apiKey: undefined })).toThrowError(
      /GRAPH_API_KEY is missing/,
    );
    expect(() => new GraphGatewayClient({ apiKey: '   ' })).toThrowError(GraphProbeError);
    try {
      new GraphGatewayClient({ apiKey: '' });
    } catch (error) {
      expect((error as GraphProbeError).kind).toBe('credential');
    }
  });

  it('sends the key only as a bearer header, to the subgraph-id path, with the common document', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = clientWith(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ data: validPayload() });
    });
    const reading = await client.queryStandardizedTvl(request);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${DEFAULT_GATEWAY_BASE_URL}/subgraphs/id/${TEST_SUBGRAPH_ID}`);
    expect(call?.url).not.toContain(TEST_KEY);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    const body = JSON.parse(String(call?.init.body)) as {
      query: string;
      variables: { snapshots: number };
    };
    expect(body.query).toBe(STANDARDIZED_TVL_QUERY);
    expect(body.variables.snapshots).toBe(4);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(reading.provenance.origin).toBe('live');
    expect(reading.provenance.provider).toBe('the-graph-gateway');
    expect(reading.provenance.queryDocumentSha256).toBe(queryDocumentSha256());
    expect(reading.provenance.queriedAtUtc).toBe(new Date(T_NOW * 1000).toISOString());
  });

  it('classifies GraphQL errors returned with HTTP 200', async () => {
    const client = clientWith(async () =>
      jsonResponse({ errors: [{ message: 'subgraph not found: no allocations' }] }, 200),
    );
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error?.kind).toBe('graphql');
    expect(error?.message).toMatch(/no allocations/);
  });

  it('classifies a non-2xx provider response', async () => {
    const client = clientWith(async () => new Response('upstream unavailable', { status: 502 }));
    expect((await failure(client.queryStandardizedTvl(request)))?.kind).toBe('http');
  });

  it('classifies an abort during the request as a timeout', async () => {
    const client = clientWith(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error?.kind).toBe('timeout');
    expect(error?.details['phase']).toBe('request');
  });

  it('classifies an AbortError during the response-body read as a timeout', async () => {
    const client = clientWith(async () =>
      responseWithFailingBody(new DOMException('body read aborted', 'AbortError')),
    );
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error?.kind).toBe('timeout');
    expect(error?.details['phase']).toBe('body');
  });

  it('classifies another failure during the response-body read as a network failure', async () => {
    const client = clientWith(async () => responseWithFailingBody(new TypeError('terminated')));
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error?.kind).toBe('network');
    expect(error?.details['phase']).toBe('body');
    expect(error?.message).toMatch(/body read failed/);
  });

  it('classifies a transport failure during the request as network', async () => {
    const client = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(client.queryStandardizedTvl(request)))?.kind).toBe('network');
  });

  it('classifies hasIndexingErrors as an indexing failure', async () => {
    const payload = validPayload({
      _meta: {
        block: { number: 1, hash: '0x1', timestamp: T_NOW },
        deployment: 'Qm1',
        hasIndexingErrors: true,
      },
    });
    const client = clientWith(async () => jsonResponse({ data: payload }));
    expect((await failure(client.queryStandardizedTvl(request)))?.kind).toBe('indexing');
  });

  it('classifies a non-JSON or empty body as a schema failure, never an empty success', async () => {
    const notJson = clientWith(async () => new Response('<html>', { status: 200 }));
    expect((await failure(notJson.queryStandardizedTvl(request)))?.kind).toBe('schema');
    const noData = clientWith(async () => jsonResponse({}));
    expect((await failure(noData.queryStandardizedTvl(request)))?.kind).toBe('schema');
  });

  it('rejects a malformed subgraph id before any request is made', async () => {
    let called = false;
    const client = clientWith(async () => {
      called = true;
      return jsonResponse({ data: validPayload() });
    });
    const error = await failure(
      client.queryStandardizedTvl({ ...request, subgraphId: 'not-an-id' }),
    );
    expect(error?.kind).toBe('validation');
    expect(called).toBe(false);
  });

  it('redacts the credential and credential-bearing URLs from provider error bodies', async () => {
    const client = clientWith(
      async () =>
        new Response(
          `bad key ${TEST_KEY} at https://x/api/${TEST_KEY}/subgraphs/id/Y Bearer ${TEST_KEY}`,
          { status: 401 },
        ),
    );
    const error = await failure(client.queryStandardizedTvl(request));
    const body = String(error?.details['body']);
    expect(body).not.toContain(TEST_KEY);
    expect(body).toContain(REDACTED);
    expect(error?.message).not.toContain(TEST_KEY);
  });

  it('rejects unsafe gateway base URLs at construction', () => {
    for (const bad of [
      'http://gateway.thegraph.com/api',
      `https://user:${TEST_KEY}@gateway.thegraph.com/api`,
      `https://gateway.thegraph.com/api?key=${TEST_KEY}`,
      `https://gateway.thegraph.com/api#${TEST_KEY}`,
    ]) {
      let message = 'accepted';
      try {
        new GraphGatewayClient({ apiKey: TEST_KEY, gatewayBaseUrl: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/gateway base URL rejected/);
      expect(message).not.toContain(TEST_KEY);
    }
  });

  it('records only the sanitized endpoint in provenance and never claims the gateway for another host', async () => {
    const client = clientWith(
      async () => jsonResponse({ data: validPayload() }),
      TEST_KEY,
      'https://custom.example/graph/',
    );
    const reading = await client.queryStandardizedTvl(request);
    expect(reading.provenance.provider).toBe('graph-compatible-https-endpoint');
    expect(reading.provenance.providerBase).toBe('https://custom.example/graph');
    const serialized = JSON.stringify(reading.provenance);
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toMatch(/Bearer/i);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('#');
    expect(serialized).not.toContain('@');
  });

  it('cannot fall back from a live failure to fixture or replay data', async () => {
    const client = clientWith(async () => new Response('down', { status: 503 }));
    await expect(client.queryStandardizedTvl(request)).rejects.toBeInstanceOf(GraphProbeError);
    // Structural proof: the live path has no fixture or replay origin anywhere.
    for (const file of ['./client.ts', './adapter.ts', './probe.ts', './gate.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/['"]fixture['"]/);
      expect(source).not.toMatch(/['"]replay['"]/);
    }
    const adapterSource = readFileSync(new URL('./adapter.ts', import.meta.url), 'utf8');
    expect(adapterSource).toContain("origin: 'live'");
  });
});
