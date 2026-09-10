/**
 * The source reference policy: which stored URLs may be shown as a usable
 * reference, and which are withheld with a fixed reason.
 *
 * A canonical URL in the store is retrieved text. This server never fetches
 * it, but a consumer might, and a draft preview that lists `file:`,
 * `javascript:`, a credential-bearing address or a loopback, private,
 * link-local, multicast or reserved target as a source presents an unsafe
 * reference as if it were one. So every reference is classified before it is
 * rendered:
 *
 *   - only `http:` and `https:` are permitted schemes;
 *   - user information (a username or password) is refused;
 *   - a host that is a name is refused when it is `localhost` or under it,
 *     under `.local`, `.internal` or `.arpa`, or is a single label (such names
 *     resolve locally or not at all), and when it is under a reserved
 *     top-level domain (`.test`, `.example`, `.invalid`, `.onion`), which can
 *     never name a public source;
 *   - a host that is an IP literal is refused when it lies in a loopback,
 *     private, link-local, multicast or otherwise reserved block of the IANA
 *     special-purpose registries (RFC 6890 and successors), including IPv4
 *     addresses embedded in IPv6 mapped and NAT64 forms.
 *
 * The WHATWG URL parser canonicalizes hosts before this policy sees them, so
 * `127.1`, `0x7f000001`, `2130706433` and `[::ffff:127.0.0.1]` all arrive as
 * their canonical loopback form. A rejected reference is never echoed by the
 * policy; it is rendered as a fixed reason, and the caller decides whether to
 * show the quoted text beside it.
 */

export const REFERENCE_REJECTIONS = [
  'malformed',
  'scheme_not_permitted',
  'credentials_present',
  'local_name',
  'reserved_name',
  'loopback_address',
  'private_address',
  'link_local_address',
  'multicast_address',
  'reserved_address',
] as const;
export type ReferenceRejection = (typeof REFERENCE_REJECTIONS)[number];

export type ReferenceVerdict =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: ReferenceRejection };

const PERMITTED_SCHEMES = new Set(['http:', 'https:']);
const LOCAL_NAME_SUFFIXES = ['localhost', 'local', 'internal', 'arpa'];
const RESERVED_NAME_SUFFIXES = ['test', 'example', 'invalid', 'onion'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function rejected(reason: ReferenceRejection): ReferenceVerdict {
  return { status: 'rejected', reason };
}

function under(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Classifies a canonical dotted-decimal IPv4 address. `null` means public. */
function classifyIpv4(
  octets: readonly [number, number, number, number],
): ReferenceRejection | null {
  const [a, b, c] = octets;
  if (a === 127) return 'loopback_address';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private_address';
  }
  if (a === 100 && b >= 64 && b <= 127) return 'private_address'; // shared address space
  if (a === 169 && b === 254) return 'link_local_address';
  if (a >= 224 && a <= 239) return 'multicast_address';
  if (a === 0 || a >= 240) return 'reserved_address'; // "this" network, future use, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'reserved_address';
  if (a === 192 && b === 88 && c === 99) return 'reserved_address';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved_address';
  if (a === 198 && b === 51 && c === 100) return 'reserved_address';
  if (a === 203 && b === 0 && c === 113) return 'reserved_address';
  return null;
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const match = IPV4.exec(host);
  if (match === null) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as unknown as readonly [number, number, number, number];
}

/** Expands a bracket-free IPv6 host into eight 16-bit groups. `null` when it is not one. */
function expandIpv6(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(host) || !host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const groups = part.split(':');
    const values = groups.map((group) =>
      group.length >= 1 && group.length <= 4 ? Number.parseInt(group, 16) : Number.NaN,
    );
    return values.some(Number.isNaN) ? null : values;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function embeddedIpv4(groups: readonly number[]): readonly [number, number, number, number] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** Classifies an expanded IPv6 address. `null` means public. */
function classifyIpv6(groups: readonly number[]): ReferenceRejection | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (groups.every((group) => group === 0)) return 'reserved_address'; // unspecified
  if (leadingZero && g5 === 0 && groups[6] === 0 && groups[7] === 1) return 'loopback_address';
  if (leadingZero && g5 === 0xffff) return classifyIpv4(embeddedIpv4(groups)) ?? null; // mapped
  if (leadingZero && g5 === 0) return 'reserved_address'; // deprecated IPv4-compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIpv4(embeddedIpv4(groups)) ?? null; // NAT64 well-known prefix
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'private_address'; // local-use NAT64
  if ((g0 & 0xfe00) === 0xfc00) return 'private_address'; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link_local_address';
  if ((g0 & 0xffc0) === 0xfec0) return 'private_address'; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return 'multicast_address';
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return 'reserved_address'; // discard
  if (g0 === 0x2001 && g1 === 0xdb8) return 'reserved_address'; // documentation
  if (g0 === 0x2001 && g1 <= 0x1ff) return 'reserved_address'; // IETF protocol assignments
  if (g0 === 0x2002) return 'reserved_address'; // deprecated 6to4
  if ((g0 & 0xfff0) === 0x3ff0) return 'reserved_address'; // documentation
  if (g0 === 0x5f00) return 'reserved_address'; // segment routing identifiers
  return null;
}

/** Applies the policy to one stored URL. Never fetches, resolves or echoes it. */
export function classifySourceReference(raw: string): ReferenceVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return rejected('malformed');
  }
  if (!PERMITTED_SCHEMES.has(url.protocol)) return rejected('scheme_not_permitted');
  if (url.username !== '' || url.password !== '') return rejected('credentials_present');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return rejected('malformed');

  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = expandIpv6(host.slice(1, -1));
    if (groups === null) return rejected('malformed');
    const reason = classifyIpv6(groups);
    return reason === null ? { status: 'accepted' } : rejected(reason);
  }
  const octets = parseIpv4(host);
  if (octets !== null) {
    const reason = classifyIpv4(octets);
    return reason === null ? { status: 'accepted' } : rejected(reason);
  }
  if (!host.includes('.') || under(host, LOCAL_NAME_SUFFIXES)) return rejected('local_name');
  if (under(host, RESERVED_NAME_SUFFIXES)) return rejected('reserved_name');
  return { status: 'accepted' };
}
