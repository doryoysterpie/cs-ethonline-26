/**
 * URL canonicalization for matching only. The source URL is preserved
 * byte-for-byte by the caller; the canonical form is a key that links rows
 * about the same page and never replaces the original. Nothing here performs
 * a network request or follows a redirect.
 *
 * Rules: scheme and host lowercase (the WHATWG parser does this), default
 * port removed, fragment removed, userinfo removed, known tracking
 * parameters removed, remaining query parameters sorted by name then value,
 * path and trailing-slash distinctions preserved.
 */

export const TRACKING_PARAMETER_PREFIXES = ['utm_'] as const;

export const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'yclid',
  'ttclid',
  'twclid',
  'li_fat_id',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  's_kwcid',
]);

export type UrlFailureCode = 'url_missing' | 'url_invalid' | 'url_scheme_not_allowed';

export type UrlCanonicalization =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly code: UrlFailureCode };

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMETERS.has(lower)) return true;
  return TRACKING_PARAMETER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function canonicalizeUrl(raw: string): UrlCanonicalization {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, code: 'url_missing' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'url_invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'url_scheme_not_allowed' };
  }
  if (url.hostname.length === 0) return { ok: false, code: 'url_invalid' };
  url.hash = '';
  url.username = '';
  url.password = '';
  const kept: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (!isTracking(name)) kept.push([name, value]);
  }
  kept.sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  url.search = kept.length === 0 ? '' : `?${new URLSearchParams(kept).toString()}`;
  return { ok: true, canonical: url.toString() };
}
