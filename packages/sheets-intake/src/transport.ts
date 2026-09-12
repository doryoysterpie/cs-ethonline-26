import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';

/**
 * The transport boundary.
 *
 * Everything this connector sends leaves through this module, and four
 * properties are enforced here rather than at each call site:
 *
 *   1. **Two origins, and no others.** Every request URL is parsed and its
 *      origin compared with a frozen allowlist before the socket is opened.
 *      A URL built from workbook content, a tab name or an API response
 *      cannot reach a host this list does not name.
 *   2. **No redirect is ever followed.** `redirect: 'manual'` means a 3xx is
 *      returned rather than chased, and this module then refuses it. A
 *      redirect is the one mechanism that could move a request from an
 *      allowed origin to any other, so it is not merely re-validated: it is
 *      declined outright.
 *   3. **Responses are bounded while they are read.** The body is consumed in
 *      chunks against a byte ceiling, so an oversized response fails after a
 *      bounded read rather than after buffering all of it.
 *   4. **Retries are bounded, delayed, and cancellable.** Only an idempotent
 *      read is retried, only for a transient condition, a fixed number of
 *      times, with exponential delay; and an aborted signal ends the attempt
 *      loop immediately rather than after the next sleep.
 *
 * No response body ever reaches an error message. A provider's body is
 * attacker-influenced text; the status code and a fixed sentence carry
 * everything an operator needs.
 */

/** The only origins this connector may contact. */
export const ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  'https://sheets.googleapis.com',
  'https://oauth2.googleapis.com',
]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  readonly limits: SheetsLimits;
  readonly fetchImpl?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Injected delay, so a test can advance retries without waiting. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface TransportRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  /** Retry only where the caller knows the request is safe to repeat. */
  readonly idempotent: boolean;
}

export interface TransportResponse {
  readonly status: number;
  readonly text: string;
}

/** Parses and authorizes a URL's origin. Throws before any socket is opened. */
export function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fail.policy('request_url_invalid', 'the request URL is not a valid absolute URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw fail.policy(
      'request_url_userinfo',
      'the request URL carries credentials in its authority',
    );
  }
  if (!ALLOWED_ORIGINS.includes(parsed.origin)) {
    throw fail.policy(
      'request_origin_not_allowed',
      'the request names an origin outside the Google API allowlist; no request was made',
      { allowed: ALLOWED_ORIGINS },
    );
  }
  return parsed;
}

/**
 * Reads the signal's current state through a call, so the checker does not
 * narrow it to a constant. `aborted` is mutable state that changes underneath
 * this loop; treating it as a fixed value is exactly the bug this avoids.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isAbortName(name: string): boolean {
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Transient conditions worth one more attempt. Everything else fails at once. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw fail.structural(
          'response_too_large',
          'the API response exceeded the permitted size and was abandoned',
          { maximumBytes },
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Performs one request with the guards above applied.
 *
 * Returns the status and body text for the caller to interpret. A non-success
 * status is not an error here: the caller decides, because a 404 on a metadata
 * probe and a 404 on a range read mean different things.
 */
export async function request(
  spec: TransportRequest,
  options: TransportOptions,
): Promise<TransportResponse> {
  const url = assertAllowedUrl(spec.url);
  const { limits } = options;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const maximumAttempts = spec.idempotent ? Math.max(1, limits.maximumAttempts) : 1;

  let lastRetryableStatus = 0;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (aborted(options.signal)) {
      throw fail.timeout('request_cancelled', 'the request was cancelled before it was attempted');
    }
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: spec.method,
        headers: { ...spec.headers },
        ...(spec.body === undefined ? {} : { body: spec.body }),
        // Declined, never chased. See property 2 above.
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      if (aborted(options.signal)) {
        throw fail.timeout('request_cancelled', 'the request was cancelled');
      }
      if (isAbortName(name)) {
        if (attempt < maximumAttempts) {
          await sleep(
            Math.min(limits.retryBaseDelayMs * 2 ** (attempt - 1), limits.retryMaximumDelayMs),
          );
          continue;
        }
        throw fail.timeout('request_timeout', 'the request exceeded its deadline', {
          timeoutMs: limits.requestTimeoutMs,
          attempts: attempt,
        });
      }
      if (attempt < maximumAttempts) {
        await sleep(
          Math.min(limits.retryBaseDelayMs * 2 ** (attempt - 1), limits.retryMaximumDelayMs),
        );
        continue;
      }
      // The transport error's own message may name a host or a proxy; it is
      // not carried through.
      throw fail.network('request_failed', 'the request could not be completed', {
        attempts: attempt,
      });
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw fail.policy(
        'redirect_refused',
        'the API answered with a redirect, which is never followed; no second request was made',
        { status: response.status },
      );
    }

    if (isRetryableStatus(response.status) && attempt < maximumAttempts) {
      lastRetryableStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (aborted(options.signal)) {
        throw fail.timeout('request_cancelled', 'the request was cancelled');
      }
      await sleep(
        Math.min(limits.retryBaseDelayMs * 2 ** (attempt - 1), limits.retryMaximumDelayMs),
      );
      continue;
    }

    const text = await readBounded(response, limits.maximumResponseBytes);
    return { status: response.status, text };
  }

  // Unreachable by construction: the final attempt cannot take the retry
  // branch, so it returns or throws inside the loop. Kept as a typed failure
  // rather than an assertion, so a future edit to the loop bounds degrades
  // into a refusal instead of returning undefined.
  throw fail.http(
    'request_exhausted',
    'the API did not answer successfully within the retry bound',
    {
      attempts: maximumAttempts,
      lastStatus: lastRetryableStatus,
    },
  );
}
