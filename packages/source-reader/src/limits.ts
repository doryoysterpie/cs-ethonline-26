/**
 * The numeric bounds of the fetch policy, fixed at CAS-005's S0 from a
 * measurement of sixteen real feed pages (docs/CAS-005-REPORT.md, section
 * 1.3). Versioned so a revision is visible on every reading it governs.
 */
export const READER_LIMITS_VERSION = 'source-reader@1';

export interface ReaderLimits {
  readonly version: string;
  /** Decompressed body bytes read per page; a page past it is cut and partly read (R10). */
  readonly bodyBytes: number;
  /** Extracted characters kept per source; cut at a paragraph boundary (R14). */
  readonly textCharsPerSource: number;
  /** Extracted characters kept per reading, in selection order; a source past it is not read. */
  readonly textCharsPerReading: number;
  /** Milliseconds for one fetch, from the request to the last byte (R11). */
  readonly fetchTimeoutMs: number;
  /** Milliseconds for the whole reading stage (R11). */
  readonly stageTimeoutMs: number;
  /** Fetches in flight at once (R12). */
  readonly concurrency: number;
  /** Redirects followed for one source, each re-checked (R7). */
  readonly redirectLimit: number;
  /** Bytes read of a robots.txt file. */
  readonly robotsBytes: number;
  /** Milliseconds for a robots.txt fetch. */
  readonly robotsTimeoutMs: number;
}

export const READER_LIMITS: ReaderLimits = Object.freeze({
  version: READER_LIMITS_VERSION,
  bodyBytes: 2 * 1024 * 1024,
  textCharsPerSource: 60_000,
  textCharsPerReading: 600_000,
  fetchTimeoutMs: 15_000,
  stageTimeoutMs: 300_000,
  concurrency: 4,
  redirectLimit: 3,
  robotsBytes: 64 * 1024,
  robotsTimeoutMs: 5_000,
});

/** The product's user-agent token, the name robots.txt groups are matched on (O-3). */
export const USER_AGENT_TOKEN = 'LatestInCyber';

/** The fixed user agent of O-3: the product, a version, and the live dashboard address. */
export function userAgent(version: string, dashboardAddress: string): string {
  if (!/^[0-9A-Za-z.-]{1,32}$/u.test(version)) throw new RangeError('user agent version');
  const address = new URL(dashboardAddress);
  if (address.protocol !== 'https:' || address.username !== '' || address.password !== '') {
    throw new RangeError('user agent address');
  }
  return `${USER_AGENT_TOKEN}/${version} (+${address.origin})`;
}

/** R8: HTML and plain text only. */
export const ACCEPT = 'text/html, application/xhtml+xml, text/plain';
