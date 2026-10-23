import type { CheckedTarget } from './target.js';

/**
 * The one boundary to the network. The policy layer sends a request to a
 * checked target with fixed headers and reads the response as a stream; it
 * never names a module that opens a socket. Implemented once over Node's HTTP
 * clients (`node-transport.ts`) and in every test with recorded pages.
 */
export interface RawRequest {
  readonly target: CheckedTarget;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface RawResponse {
  readonly status: number;
  /** Header names lower-cased; repeated headers joined with a comma. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface RawTransport {
  request(request: RawRequest): Promise<RawResponse>;
}

export interface RecordedPage {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | AsyncIterable<Uint8Array>;
}

export interface RecordedTransport extends RawTransport {
  /** Every request made, as `METHOD url` with the address connected to, in order. */
  readonly calls: readonly string[];
}

async function* once(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  yield chunk;
}

/**
 * A transport that answers from recorded pages keyed by URL: the test seam.
 * A URL with no recording answers 404 with an empty body. A page may be a
 * function of the request, for a response that depends on the attempt.
 */
export function recordedTransport(
  pages: Readonly<Record<string, RecordedPage | ((request: RawRequest) => RecordedPage)>>,
): RecordedTransport {
  const calls: string[] = [];
  return {
    calls,
    async request(request) {
      const key = request.target.url.href;
      calls.push(`GET ${key} @ ${request.target.address}`);
      const entry = pages[key];
      const page =
        entry === undefined
          ? { status: 404 }
          : typeof entry === 'function'
            ? entry(request)
            : entry;
      const raw = page.body ?? '';
      const body =
        typeof raw === 'string'
          ? once(new TextEncoder().encode(raw))
          : raw instanceof Uint8Array
            ? once(raw)
            : raw;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(page.headers ?? {}))
        headers[name.toLowerCase()] = value;
      if (headers['content-type'] === undefined && page.status === undefined) {
        headers['content-type'] = 'text/html; charset=utf-8';
      }
      return { status: page.status ?? 200, headers, body };
    },
  };
}
