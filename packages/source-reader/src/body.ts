import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { ReadError } from './errors.js';
import type { RawResponse } from './transport.js';

/**
 * Rule R10: the body is read as a stream and stops at the bound, counted on
 * the decompressed side when the server compressed it despite
 * `Accept-Encoding: identity`. A page past the bound is cut, not refused
 * (docs/CAS-005-REPORT.md, section 1.10), and the caller records it as partly
 * read with `body_limit`. An encoding the reader cannot bound is refused.
 */
export interface BoundedBody {
  readonly bytes: Uint8Array;
  readonly cut: boolean;
}

function decompressor(encoding: string) {
  switch (encoding) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      throw new ReadError('content_encoding_not_permitted', 'the body encoding cannot be bounded');
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

/** Resolves with the next chunk, or rejects as soon as the signal aborts, whichever first. */
function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('read failed'));
      },
    );
  });
}

export async function readBounded(
  response: RawResponse,
  bound: number,
  signal: AbortSignal,
): Promise<BoundedBody> {
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
  const inflate = decompressor(encoding);
  const source = Readable.from(response.body);
  const stream: AsyncIterable<Uint8Array> = inflate === null ? source : source.pipe(inflate);
  const iterator = stream[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    for (;;) {
      const result = await nextOrAbort(iterator, signal);
      if (result.done) break;
      const chunk: Uint8Array = result.value;
      if (total + chunk.length >= bound) {
        chunks.push(chunk.subarray(0, bound - total));
        total = bound;
        cut = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    // Stop reading whether the body ended, was cut or failed. The return is
    // not awaited: a body that hangs would hang it too, and the transport's
    // signal has already closed the socket in that case.
    iterator.return?.().catch(() => undefined);
    source.destroy();
    inflate?.destroy();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, cut };
}

/** The charset the response declares, or UTF-8; an unknown label falls back to UTF-8. */
export function decodeText(bytes: Uint8Array, contentType: string): string {
  const match = /charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/iu.exec(contentType);
  const label = match?.[1] ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}
