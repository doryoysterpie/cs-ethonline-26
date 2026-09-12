import { GraphProbeError } from './errors.js';

/**
 * Reading a provider response body under a byte limit, while it streams.
 *
 * The limit is applied to the decoded bytes as they arrive, never after an
 * unbounded body has been buffered. A declared `Content-Length` is used only
 * to refuse early: a declared length above the limit is refused before a
 * byte is read, and a declared length below the limit is not trusted, because
 * the count of bytes actually received is what decides. An absent, negative,
 * non-numeric or otherwise malformed header is treated as absent. The live
 * gateway sends chunked, brotli-encoded responses with no length at all, so
 * the streaming count is the normal path, not the fallback.
 *
 * Two overrun policies exist. `reject` is for a body the caller will parse as
 * evidence: crossing the limit cancels the stream and fails with a fixed
 * message carrying counts only. `truncate` is for a non-2xx error body that
 * is only ever shown as a redacted snippet: the read stops at the limit, the
 * rest is discarded, and the result says it was cut. No canonical evidence is
 * ever truncated.
 */

export interface BoundedBody {
  readonly text: string;
  /** Decoded bytes kept. */
  readonly bytes: number;
  /** True only under the `truncate` policy when the body exceeded the limit. */
  readonly truncated: boolean;
  /** The parsed `Content-Length`, or `null` when absent or malformed. */
  readonly declaredLength: number | null;
}

export type OverrunPolicy = 'reject' | 'truncate';

const CONTENT_LENGTH = /^[0-9]{1,15}$/u;

/** A well-formed non-negative `Content-Length`, else `null`. Never trusted for the upper bound. */
export function parseContentLength(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (!CONTENT_LENGTH.test(value)) return null;
  return Number(value);
}

function limitError(reason: 'declared_length' | 'stream_overrun', details: Record<string, number>) {
  return new GraphProbeError('limit', 'gateway response body exceeds the byte limit', {
    reason,
    phase: 'body',
    ...details,
  });
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stream is being abandoned; a failure to cancel changes nothing.
  }
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads at most `maxBytes` of the body. Transport failures while reading
 * (an abort, a reset) are rethrown untouched so the caller can classify them;
 * a limit failure and an encoding failure are `GraphProbeError`s.
 */
export async function readBodyBounded(
  response: Response,
  maxBytes: number,
  policy: OverrunPolicy = 'reject',
): Promise<BoundedBody> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new GraphProbeError('validation', 'body byte limit must be a positive integer');
  }
  const declaredLength = parseContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes && policy === 'reject') {
    throw limitError('declared_length', { limit: maxBytes, declaredBytes: declaredLength });
  }
  const body = response.body;
  if (body === null) return { text: '', bytes: 0, truncated: false, declaredLength };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (received + value.byteLength > maxBytes) {
      if (policy === 'reject') {
        await cancelQuietly(reader);
        throw limitError('stream_overrun', {
          limit: maxBytes,
          receivedBytes: received + value.byteLength,
        });
      }
      chunks.push(value.subarray(0, maxBytes - received));
      received = maxBytes;
      truncated = true;
      await cancelQuietly(reader);
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(concatenate(chunks, received));
  } catch {
    throw new GraphProbeError('schema', 'gateway response is not valid UTF-8', {
      bytes: received,
    });
  }
  return { text, bytes: received, truncated, declaredLength };
}
