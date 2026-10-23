import { classifySourceReference } from '@cas/contracts';

import { ReadError } from './errors.js';

/**
 * A fetch target checked under rules R1 to R6: the URL classified by the
 * shared policy (R1 to R4), the port fixed by the scheme (R6), the name
 * resolved and every address classified before any connection (R5). The
 * connection is then made to `address` and nowhere else.
 */
export interface CheckedTarget {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a name to every address it has; injected, so the policy layer opens no socket. */
export interface Resolver {
  resolve(host: string): Promise<readonly string[]>;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

function classifyAddress(address: string): void {
  const literal = address.includes(':') ? `[${address}]` : address;
  const verdict = classifySourceReference(`http://${literal}/`);
  if (verdict.status === 'rejected') {
    throw new ReadError('resolved_address_refused', 'the name resolved to a refused address');
  }
}

export async function checkTarget(raw: string, resolver: Resolver): Promise<CheckedTarget> {
  const verdict = classifySourceReference(raw);
  if (verdict.status === 'rejected') {
    throw new ReadError(verdict.reason, 'the URL is refused by the reference policy');
  }
  const url = new URL(raw);
  const tls = url.protocol === 'https:';
  const port = url.port === '' ? (tls ? 443 : 80) : Number(url.port);
  if (port !== (tls ? 443 : 80)) {
    throw new ReadError('port_not_permitted', 'only the default port of the scheme is permitted');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (host.startsWith('[') && host.endsWith(']')) {
    return { url, host, port, tls, address: host.slice(1, -1), family: 6 };
  }
  if (IPV4.test(host)) return { url, host, port, tls, address: host, family: 4 };
  let addresses: readonly string[];
  try {
    addresses = await resolver.resolve(host);
  } catch {
    throw new ReadError('resolution_failed', 'the name did not resolve');
  }
  if (addresses.length === 0) throw new ReadError('resolution_failed', 'the name did not resolve');
  for (const address of addresses) classifyAddress(address);
  const address = addresses[0] as string;
  return { url, host, port, tls, address, family: address.includes(':') ? 6 : 4 };
}
