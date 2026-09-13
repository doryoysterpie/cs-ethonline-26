import type { FetchLike } from '@cas/graph-evidence';

import {
  GATEWAY_HOST_MAX_CHARACTERS,
  GATEWAY_PATH_MAX_CHARACTERS,
  GATEWAY_URL_MAX_CHARACTERS,
} from '../bounds.js';
import { combineSignals } from '../safety/cancellation.js';

/**
 * The transport policy every live Graph request passes through (Track D
 * finding F2). It sits between the Sprint 1 client and the network, owned by
 * this server, and enforces what the client alone does not:
 *
 *   - the request may address only the configured gateway: `https:`, no
 *     credentials, query or fragment, bounded host and path lengths, and a
 *     path under the validated gateway base; anything else is refused before
 *     a socket is opened;
 *   - redirects are never followed: the fetch runs with `redirect: "manual"`
 *     and every 3xx answer is a fixed failure with zero requests to the
 *     destination, so a provider cannot move a request to HTTP, to a private
 *     or loopback address, to a credential-bearing location or down a chain;
 *   - the call's abort signal is combined with the client's own request
 *     timeout, so cancelling the call aborts the socket.
 *
 * Provenance therefore always names the endpoint that was contacted, because
 * no other endpoint can be. The `Location` a refused redirect carried is
 * classified for the log only and is never echoed.
 */

export const DESTINATION_CLASSES = [
  'loopback',
  'private',
  'link_local',
  'multicast',
  'reserved',
  'unspecified',
  'ipv6_local',
  'local_name',
  'public_address',
  'public_name',
  'unparseable',
] as const;
export type DestinationClass = (typeof DESTINATION_CLASSES)[number];

export type GatewayRefusal = 'url_refused' | 'redirect_refused';

export class GatewayPolicyError extends Error {
  readonly refusal: GatewayRefusal;
  readonly destinationClass: DestinationClass | null;
  readonly downgrade: boolean;
  readonly credentials: boolean;

  constructor(
    refusal: GatewayRefusal,
    detail: {
      destinationClass?: DestinationClass;
      downgrade?: boolean;
      credentials?: boolean;
    } = {},
  ) {
    super(
      refusal === 'url_refused' ? 'gateway request refused by policy' : 'gateway redirect refused',
    );
    this.name = 'GatewayPolicyError';
    this.refusal = refusal;
    this.destinationClass = detail.destinationClass ?? null;
    this.downgrade = detail.downgrade ?? false;
    this.credentials = detail.credentials ?? false;
  }
}

export function isGatewayPolicyError(value: unknown): value is GatewayPolicyError {
  return value instanceof GatewayPolicyError;
}

const DECIMAL_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Parses every IPv4 spelling the URL parser normalizes: dotted decimal,
 * shortened dotted forms, a single decimal integer, and octal or hexadecimal
 * parts. `new URL()` already canonicalizes these to dotted decimal, so the
 * decimal case is the one that matters after parsing; the others are kept so
 * a caller classifying a raw string gets the same answer.
 */
function ipv4Number(hostname: string): number | null {
  const dotted = DECIMAL_OCTETS.exec(hostname);
  if (dotted !== null) {
    const parts = dotted.slice(1, 5).map(Number);
    if (parts.some((part) => part > 255)) return null;
    return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
  }
  const pieces = hostname.split('.');
  if (pieces.length === 0 || pieces.length > 4) return null;
  const values: number[] = [];
  for (const piece of pieces) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(piece)) value = Number.parseInt(piece.slice(2), 16);
    else if (/^0[0-7]+$/.test(piece)) value = Number.parseInt(piece.slice(1), 8);
    else if (/^\d+$/.test(piece)) value = Number.parseInt(piece, 10);
    else return null;
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  const last = values[values.length - 1]!;
  const limit = 2 ** (8 * (5 - values.length));
  if (last >= limit || values.slice(0, -1).some((v) => v > 255)) return null;
  let number = 0;
  for (let i = 0; i < values.length - 1; i += 1) number = number * 256 + values[i]!;
  return number * 256 ** (5 - values.length) + last;
}

function classifyIpv4(number: number): DestinationClass {
  const a = number >>> 24;
  const b = (number >>> 16) & 0xff;
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if (a === 192 && b === 0 && ((number >>> 8) & 0xff) === 0) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  return 'public_address';
}

function expandIpv6(hostname: string): number[] | null {
  let text = hostname.toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  let embedded: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4Number(text.slice(lastColon + 1));
    if (v4 === null) return null;
    embedded = [v4 >>> 16, v4 & 0xffff];
    text = `${text.slice(0, lastColon)}:0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (embedded.length === 2) {
    groups[6] = embedded[0]!;
    groups[7] = embedded[1]!;
  }
  return groups.length === 8 ? groups : null;
}

function classifyIpv6(groups: number[]): DestinationClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroButLast =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0;
  if (allZeroButLast && g7 === 1) return 'loopback';
  if (allZeroButLast && g7 === 0) return 'unspecified';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return classifyIpv4(((g6 << 16) >>> 0) + g7);
  }
  if ((g0 & 0xffc0) === 0xfe80) return 'ipv6_local';
  if ((g0 & 0xfe00) === 0xfc00) return 'ipv6_local';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
  return 'public_address';
}

/**
 * Classifies a hostname as the URL parser presents it. Names are classified by
 * their reserved suffixes; addresses by their range, after every spelling the
 * parser accepts is normalized.
 */
export function classifyDestination(hostname: string): DestinationClass {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return 'unparseable';
  if (host.startsWith('[') || host.includes(':')) {
    const groups = expandIpv6(host);
    return groups === null ? 'unparseable' : classifyIpv6(groups);
  }
  const v4 = ipv4Number(host);
  if (v4 !== null) return classifyIpv4(v4);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.in-addr.arpa') ||
    host.endsWith('.ip6.arpa')
  ) {
    return 'local_name';
  }
  return 'public_name';
}

export interface GatewayPolicyOptions {
  /** The validated gateway base the Sprint 1 client was built with: origin plus path, no trailing slash. */
  readonly gatewayBase: string;
  /** The call's abort signal; combined with the client's own request timeout. */
  readonly signal?: AbortSignal | undefined;
  /** Receives one fixed line per refusal. Never a URL. */
  readonly log?: ((line: string) => void) | undefined;
}

/** Structural check of the request target: only the configured gateway, only well-formed. */
export function assertGatewayTarget(url: string, gatewayBase: string): URL {
  if (url.length > GATEWAY_URL_MAX_CHARACTERS) throw new GatewayPolicyError('url_refused');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GatewayPolicyError('url_refused');
  }
  if (parsed.protocol !== 'https:')
    throw new GatewayPolicyError('url_refused', { downgrade: true });
  if (parsed.username !== '' || parsed.password !== '') {
    throw new GatewayPolicyError('url_refused', { credentials: true });
  }
  if (parsed.search !== '' || parsed.hash !== '' || url.includes('?') || url.includes('#')) {
    throw new GatewayPolicyError('url_refused');
  }
  if (parsed.hostname.length === 0 || parsed.hostname.length > GATEWAY_HOST_MAX_CHARACTERS) {
    throw new GatewayPolicyError('url_refused');
  }
  if (parsed.pathname.length > GATEWAY_PATH_MAX_CHARACTERS)
    throw new GatewayPolicyError('url_refused');
  const base = `${parsed.origin}${parsed.pathname}`;
  if (base !== gatewayBase && !base.startsWith(`${gatewayBase}/`)) {
    throw new GatewayPolicyError('url_refused');
  }
  return parsed;
}

/** Describes a refused redirect's destination for the log. Never the URL itself. */
export function classifyRedirect(
  location: string | null,
  from: URL,
): { destinationClass: DestinationClass; downgrade: boolean; credentials: boolean } {
  if (location === null)
    return { destinationClass: 'unparseable', downgrade: false, credentials: false };
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return { destinationClass: 'unparseable', downgrade: false, credentials: false };
  }
  return {
    destinationClass: classifyDestination(target.hostname),
    downgrade: target.protocol !== 'https:',
    credentials: target.username !== '' || target.password !== '',
  };
}

/** Wraps a base fetch in the policy. The result is handed to the Sprint 1 client as its `fetchImpl`. */
export function createPolicyFetch(base: FetchLike, options: GatewayPolicyOptions): FetchLike {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const target = assertGatewayTarget(url, options.gatewayBase);
    const signal = combineSignals(init.signal ?? undefined, options.signal);
    const response = await base(target.href, {
      ...init,
      redirect: 'manual',
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status >= 300 && response.status < 400) {
      const detail = classifyRedirect(response.headers.get('location'), target);
      // Drain nothing: the body of a refused redirect is never read.
      options.log?.(
        `cas-mcp-server gateway_redirect_refused status=${response.status} destination=${detail.destinationClass} downgrade=${detail.downgrade} credentials=${detail.credentials}`,
      );
      throw new GatewayPolicyError('redirect_refused', detail);
    }
    return response;
  };
}
