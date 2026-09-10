import { RESOURCE_LIMITS, type GraphLimits } from '@cas/contracts';
import { describe, expect, it } from 'vitest';

import { parseContentLength, readBodyBounded } from './bounded-body.js';
import { GraphGatewayClient, resolveGraphLimits, type FetchLike } from './client.js';
import { GraphProbeError } from './errors.js';
import { assertJsonShape, parseJsonBounded, scanJsonDepth } from './json-shape.js';
import { TEST_KEY, TEST_SUBGRAPH_ID, T_NOW, jsonResponse, validPayload } from './test-support.js';

/**
 * Adversarial tests of the Graph response limits (`RESOURCE_LIMITS.graph`).
 *
 * The body limit is exercised at the exact bound and one byte either side,
 * against an endless stream that must stop being pulled, against a
 * Content-Length that lies in both directions, and against one that is
 * missing or malformed. The JSON limits are exercised at their bounds through
 * the client. Every refusal carries the fixed message and numeric details;
 * the marker planted in every hostile body must appear nowhere in an error.
 */

const MARKER = 'SECRET-BODY-MARKER';
const request = {
  subgraphId: TEST_SUBGRAPH_ID,
  targetChain: 'ethereum',
  targetSlug: 'synthetic-lending',
} as const;
const encoder = new TextEncoder();

function clientWith(fetchImpl: FetchLike, limits?: Partial<GraphLimits>): GraphGatewayClient {
  return new GraphGatewayClient({
    apiKey: TEST_KEY,
    fetchImpl,
    timeoutMs: 5_000,
    now: () => new Date(T_NOW * 1000),
    limits,
  });
}

async function failure(promise: Promise<unknown>): Promise<GraphProbeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphProbeError) return error;
    throw error;
  }
  throw new Error('expected a GraphProbeError');
}

function expectNonReflecting(error: GraphProbeError): void {
  expect(error.message).not.toContain(MARKER);
  expect(JSON.stringify(error.details)).not.toContain(MARKER);
  for (const [key, value] of Object.entries(error.details)) {
    if (key === 'subgraphId') continue;
    expect(['number', 'string']).toContain(typeof value);
    if (typeof value === 'string') expect(value).toMatch(/^[a-z_]+$/u);
  }
}

/**
 * A response whose body arrives as the given chunks, one per pull. The zero
 * high-water mark means a pull happens only when the reader asks, so the pull
 * count is the number of reads the client actually made.
 */
function chunked(
  chunks: readonly Uint8Array[],
  init: ResponseInit = { status: 200 },
): { response: Response; pulls: () => number } {
  let pulls = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const next = chunks[index];
        index += 1;
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, init), pulls: () => pulls };
}

/** A response that never ends: the same hostile chunk on every pull. */
function endless(
  chunk: Uint8Array,
  init: ResponseInit = { status: 200 },
): { response: Response; pulls: () => number } {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, init), pulls: () => pulls };
}

/** A valid standardized payload padded with trailing whitespace to exactly `bytes` bytes. */
function exactBody(bytes: number): string {
  const base = JSON.stringify({ data: validPayload() });
  const length = Buffer.byteLength(base, 'utf8');
  if (length > bytes) throw new Error(`payload is ${length} bytes, above ${bytes}`);
  return `${base}${' '.repeat(bytes - length)}`;
}

describe('resolveGraphLimits', () => {
  it('defaults to the versioned limits and refuses a non-positive override', () => {
    expect(resolveGraphLimits()).toEqual(RESOURCE_LIMITS.graph);
    expect(resolveGraphLimits({ responseBodyBytes: 10 }).responseBodyBytes).toBe(10);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveGraphLimits({ jsonMaxDepth: bad })).toThrowError(GraphProbeError);
    }
    expect(clientWith(async () => jsonResponse({})).limits).toEqual(RESOURCE_LIMITS.graph);
  });
});

describe('parseContentLength', () => {
  it('accepts a plain non-negative integer and treats everything else as absent', () => {
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength(' 4446 ')).toBe(4446);
    expect(parseContentLength(null)).toBeNull();
    for (const bad of ['', '-1', '1e3', '12 34', 'abc', '4446, 4446', '0x10', '1.0']) {
      expect(parseContentLength(bad), bad).toBeNull();
    }
  });
});

describe('response body limit', () => {
  it('accepts a body of exactly the limit and refuses one byte more', async () => {
    const limit = Buffer.byteLength(JSON.stringify({ data: validPayload() })) + 16;
    for (const bytes of [limit - 1, limit]) {
      const client = clientWith(async () => new Response(exactBody(bytes)), {
        responseBodyBytes: limit,
      });
      const reading = await client.queryStandardizedTvl(request);
      expect(reading.provenance.origin).toBe('live');
    }
    const over = clientWith(async () => new Response(exactBody(limit + 1)), {
      responseBodyBytes: limit,
    });
    const error = await failure(over.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.message).toBe('gateway response body exceeds the byte limit');
    expect(error.details['reason']).toBe('stream_overrun');
    expect(error.details['limit']).toBe(limit);
    expect(error.details['receivedBytes']).toBe(limit + 1);
    expectNonReflecting(error);
  });

  it('stops pulling an endless stream once the limit is crossed', async () => {
    const chunk = encoder.encode(`${MARKER}-`.padEnd(1024, 'x'));
    const source = endless(chunk);
    const client = clientWith(async () => source.response, { responseBodyBytes: 4096 });
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('stream_overrun');
    expect(error.details['receivedBytes']).toBe(5 * 1024);
    // Four chunks fit, the fifth crosses; the stream is cancelled there.
    expect(source.pulls()).toBeLessThanOrEqual(6);
    expectNonReflecting(error);
  });

  it('refuses a declared Content-Length above the limit before reading a byte', async () => {
    const source = chunked([encoder.encode(MARKER)], {
      status: 200,
      headers: { 'content-length': '5000' },
    });
    const client = clientWith(async () => source.response, { responseBodyBytes: 4096 });
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('declared_length');
    expect(error.details['declaredBytes']).toBe(5000);
    expect(error.details['limit']).toBe(4096);
    expect(source.pulls()).toBe(0);
    expectNonReflecting(error);
  });

  it('does not trust a declared Content-Length below the limit', async () => {
    const chunk = encoder.encode(MARKER.padEnd(2048, 'y'));
    const source = chunked([chunk, chunk, chunk], {
      status: 200,
      headers: { 'content-length': '10' },
    });
    const client = clientWith(async () => source.response, { responseBodyBytes: 4096 });
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('stream_overrun');
    expectNonReflecting(error);
  });

  it('treats a missing or malformed Content-Length as absent and reads under the limit', async () => {
    for (const header of [null, 'abc', '-1', '1e3', '12 34', '']) {
      const headers: Record<string, string> = {};
      if (header !== null) headers['content-length'] = header;
      const client = clientWith(
        async () =>
          new Response(JSON.stringify({ data: validPayload() }), { status: 200, headers }),
      );
      const reading = await client.queryStandardizedTvl(request);
      expect(reading.provenance.origin, String(header)).toBe('live');
    }
  });

  it('never turns an absent body into an empty success', async () => {
    const client = clientWith(async () => new Response(null, { status: 200 }));
    expect((await failure(client.queryStandardizedTvl(request))).kind).toBe('schema');
  });

  it('refuses a body that is not UTF-8 as a schema failure', async () => {
    const client = clientWith(async () => new Response(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])));
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('schema');
    expect(error.message).toBe('gateway response is not valid UTF-8');
  });

  it('cuts a non-2xx body at the snippet bound and discards the rest unread', async () => {
    const chunk = encoder.encode(`${MARKER}`.padEnd(256, 'e'));
    const source = endless(chunk, { status: 502 });
    const client = clientWith(async () => source.response, { httpErrorSnippetBytes: 512 });
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('http');
    expect(error.details['status']).toBe(502);
    expect(error.details['bodyTruncated']).toBe(true);
    expect(String(error.details['body']).length).toBeLessThanOrEqual(300);
    expect(source.pulls()).toBeLessThanOrEqual(4);
  });

  it('readBodyBounded reports the truncation under the truncate policy and keeps exactly the limit', async () => {
    const chunk = encoder.encode('abcdefgh');
    const source = chunked([chunk, chunk, chunk]);
    const body = await readBodyBounded(source.response, 12, 'truncate');
    expect(body).toEqual({
      text: 'abcdefghabcd',
      bytes: 12,
      truncated: true,
      declaredLength: null,
    });
    const whole = await readBodyBounded(chunked([chunk]).response, 8, 'reject');
    expect(whole).toEqual({ text: 'abcdefgh', bytes: 8, truncated: false, declaredLength: null });
  });

  it('a transport failure while reading the body is still classified, not swallowed by the limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException('body read aborted', 'AbortError');
      },
    });
    const client = clientWith(async () => new Response(stream));
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('timeout');
    expect(error.details['phase']).toBe('body');
  });
});

describe('JSON shape limits', () => {
  it('measures depth without building the tree, ignoring brackets inside strings', () => {
    expect(scanJsonDepth('[[[]]]', 3)).toBe(3);
    expect(scanJsonDepth('{"a":"[[[[[[[[[["}', 1)).toBe(1);
    expect(scanJsonDepth('{"a":"\\"[","b":[]}', 2)).toBe(2);
    expect(scanJsonDepth('', 1)).toBe(0);
    expect(() => scanJsonDepth('[[[]]]', 2)).toThrowError(GraphProbeError);
  });

  it('walks a parsed value with an explicit stack and counts collections and sizes', () => {
    const shape = assertJsonShape(
      { a: [1, { b: [] }], c: {} },
      {
        maxDepth: 8,
        maxCollectionSize: 8,
        maxCollections: 8,
      },
    );
    expect(shape).toEqual({ depth: 4, collections: 5, largestCollection: 2 });
    expect(() =>
      assertJsonShape(
        { a: [1, { b: [] }], c: {} },
        {
          maxDepth: 8,
          maxCollectionSize: 8,
          maxCollections: 4,
        },
      ),
    ).toThrowError(/collection count limit/u);
    expect(() =>
      assertJsonShape([[1, 2, 3]], { maxDepth: 8, maxCollectionSize: 2, maxCollections: 8 }),
    ).toThrowError(/collection size limit/u);
  });

  it('depth: accepts the exact bound and refuses one level more, through the client', async () => {
    const depth = RESOURCE_LIMITS.graph.jsonMaxDepth;
    // {"data": [[[...]]]} with the root object at depth 1.
    const nested = (levels: number) => `{"data":${'['.repeat(levels)}${']'.repeat(levels)}}`;
    const exact = clientWith(async () => new Response(nested(depth - 1)));
    // The depth check passes; the adapter then refuses the shape as a schema failure.
    expect((await failure(exact.queryStandardizedTvl(request))).kind).toBe('schema');
    const over = clientWith(async () => new Response(nested(depth)));
    const error = await failure(over.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('depth');
    expect(error.details['limit']).toBe(depth);
    expect(error.message).toBe('gateway response exceeds the JSON nesting depth limit');
    // The scan refuses long before anything is parsed: a megabyte of brackets is cheap.
    const deep = clientWith(async () => new Response(nested(100_000)));
    expect((await failure(deep.queryStandardizedTvl(request))).details['reason']).toBe('depth');
  });

  it('collection size: accepts the exact bound and refuses one element more', async () => {
    const body = (n: number) =>
      `{"data":{"protocols":[${Array.from({ length: n }, () => '1').join(',')}]}}`;
    const exact = clientWith(async () => new Response(body(8)), { jsonMaxCollectionSize: 8 });
    expect((await failure(exact.queryStandardizedTvl(request))).kind).toBe('schema');
    const over = clientWith(async () => new Response(body(9)), { jsonMaxCollectionSize: 8 });
    const error = await failure(over.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('collection_size');
    expect(error.details['limit']).toBe(8);
    const keys = clientWith(
      async () =>
        new Response(`{"data":{${Array.from({ length: 9 }, (_, i) => `"k${i}":1`).join(',')}}}`),
      { jsonMaxCollectionSize: 8 },
    );
    expect((await failure(keys.queryStandardizedTvl(request))).details['reason']).toBe(
      'collection_size',
    );
  });

  it('collection count: accepts the exact bound and refuses one collection more', async () => {
    // root, data, a, then n empty objects.
    const body = (n: number) =>
      `{"data":{"a":[${Array.from({ length: n }, () => '{}').join(',')}]}}`;
    const exact = clientWith(async () => new Response(body(2)), { jsonMaxCollections: 5 });
    expect((await failure(exact.queryStandardizedTvl(request))).kind).toBe('schema');
    const over = clientWith(async () => new Response(body(3)), { jsonMaxCollections: 5 });
    const error = await failure(over.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.details['reason']).toBe('collections');
    expect(error.details['limit']).toBe(5);
  });

  it('parseJsonBounded rethrows a syntax error as itself and a limit as a GraphProbeError', () => {
    const limits = { maxDepth: 4, maxCollectionSize: 4, maxCollections: 4 };
    expect(() => parseJsonBounded('{', limits)).toThrowError(SyntaxError);
    expect(() => parseJsonBounded('[[[[[]]]]]', limits)).toThrowError(GraphProbeError);
    expect(parseJsonBounded('{"a":[1,2]}', limits)).toEqual({ a: [1, 2] });
  });
});

describe('concurrent request limit', () => {
  it('refuses the request past the bound before any fetch, and admits one again afterwards', async () => {
    const releases: (() => void)[] = [];
    let calls = 0;
    let gated = true;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (!gated) return Promise.resolve(jsonResponse({ data: validPayload() }));
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(jsonResponse({ data: validPayload() })));
      });
    };
    const client = clientWith(fetchImpl, { concurrentRequests: 2 });
    const first = client.queryStandardizedTvl(request);
    const second = client.queryStandardizedTvl(request);
    expect(client.inFlight).toBe(2);
    const error = await failure(client.queryStandardizedTvl(request));
    expect(error.kind).toBe('limit');
    expect(error.message).toBe('gateway request refused: too many concurrent requests');
    expect(error.details['limit']).toBe(2);
    expect(error.details['inFlight']).toBe(2);
    expect(calls).toBe(2);
    for (const release of releases) release();
    await first;
    await second;
    expect(client.inFlight).toBe(0);
    gated = false;
    const reading = await client.queryStandardizedTvl(request);
    expect(reading.provenance.origin).toBe('live');
    expect(calls).toBe(3);
  });

  it('releases the slot when a request fails, so a failure cannot exhaust the bound', async () => {
    const client = clientWith(
      async () => {
        throw new TypeError('fetch failed');
      },
      { concurrentRequests: 1 },
    );
    expect((await failure(client.queryStandardizedTvl(request))).kind).toBe('network');
    expect((await failure(client.queryStandardizedTvl(request))).kind).toBe('network');
    expect(client.inFlight).toBe(0);
  });
});
