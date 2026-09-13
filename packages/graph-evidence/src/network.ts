import type { ChainId } from '@cas/contracts';

/**
 * Documented network aliases. The Messari standardized schema reports the
 * network as an uppercase enum value; only the two values the project reads
 * are mapped, exactly as the provider returns them. Anything else, including
 * case variants and unlisted networks, is unrecognized and must fail
 * validation rather than be guessed at.
 */
export const NETWORK_ALIASES: Readonly<Record<string, ChainId>> = {
  MAINNET: 'ethereum',
  BASE: 'base',
};

export function normalizeNetwork(raw: string): ChainId | null {
  return Object.prototype.hasOwnProperty.call(NETWORK_ALIASES, raw)
    ? (NETWORK_ALIASES[raw] ?? null)
    : null;
}
