import type { GraphProvider } from '@cas/contracts';

import { GraphProbeError } from './errors.js';

/**
 * Structural validation of the gateway base URL with `new URL()`.
 *
 * Accepted: `https:` only; no username or password; no query string; no
 * fragment; a non-empty hostname. The result is normalized to
 * `origin + pathname` with trailing slashes removed, so it never carries
 * authorization data, user information, query parameters or fragments into
 * provenance. Rejected URLs are never echoed, because they may contain
 * credentials; the error names only the rule that failed.
 *
 * Any validated HTTPS endpoint is accepted, so provenance claims The Graph's
 * gateway only when the host is the official one.
 */
export const OFFICIAL_GATEWAY_HOST = 'gateway.thegraph.com';
export const DEFAULT_GATEWAY_BASE_URL = 'https://gateway.thegraph.com/api';

export interface ParsedGatewayBase {
  /** Sanitized `origin + path`, no trailing slash. Safe for provenance. */
  readonly base: string;
  readonly host: string;
  readonly provider: GraphProvider;
}

function reject(reason: string): never {
  throw new GraphProbeError('validation', `gateway base URL rejected: ${reason}`, { reason });
}

export function parseGatewayBaseUrl(raw: string | undefined): ParsedGatewayBase {
  const candidate = (raw ?? DEFAULT_GATEWAY_BASE_URL).trim();
  if (candidate.length === 0) reject('empty value');
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    reject('not a parseable absolute URL');
  }
  if (url.protocol !== 'https:') reject('protocol must be https');
  if (url.username !== '' || url.password !== '') reject('must not contain credentials');
  if (url.search !== '' || candidate.includes('?')) reject('must not contain a query string');
  if (url.hash !== '' || candidate.includes('#')) reject('must not contain a fragment');
  if (url.hostname.length === 0) reject('hostname missing');

  const path = url.pathname.replace(/\/+$/, '');
  const base = `${url.origin}${path}`;
  const provider: GraphProvider =
    url.hostname === OFFICIAL_GATEWAY_HOST
      ? 'the-graph-gateway'
      : 'graph-compatible-https-endpoint';
  return { base, host: url.hostname, provider };
}
