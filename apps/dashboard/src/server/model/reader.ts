import 'server-only';

import { lookup } from 'node:dns/promises';

import type { RawTransport, Resolver } from '@cas/source-reader';

/**
 * The source reader's runtime pieces (CAS-005): the one Node transport, the
 * real resolver (every address of a name, so rule R5 classifies them all),
 * and the fixed user agent of O-3, which needs the live dashboard address.
 * Without that address there is no reader, and the reading stage fails
 * closed with a fixed code before any request.
 */
export const PUBLIC_URL_VARIABLE = 'DASHBOARD_PUBLIC_URL';
/** The version the user agent carries; the dashboard's own, bumped by hand with the product. */
export const READER_VERSION = '0.1';

export interface ReaderConfig {
  readonly publicUrl: string;
}

export interface SourceReaderDeps {
  readonly transport: RawTransport;
  readonly resolver: Resolver;
  readonly userAgent: string;
}

export function loadReaderConfig(
  env: Readonly<Record<string, string | undefined>>,
): ReaderConfig | null {
  const value = env[PUBLIC_URL_VARIABLE];
  if (value === undefined) return null;
  const publicUrl = value.trim();
  if (publicUrl.length === 0) return null;
  return { publicUrl };
}

export function createNodeReader(
  config: ReaderConfig,
  sourceReader: {
    readonly nodeTransport: () => RawTransport;
    readonly userAgent: (version: string, address: string) => string;
  },
): SourceReaderDeps {
  return {
    transport: sourceReader.nodeTransport(),
    resolver: {
      async resolve(host: string): Promise<readonly string[]> {
        const addresses = await lookup(host, { all: true });
        return addresses.map((entry) => entry.address);
      },
    },
    userAgent: sourceReader.userAgent(READER_VERSION, config.publicUrl),
  };
}
