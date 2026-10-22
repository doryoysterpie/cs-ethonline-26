import 'server-only';

import { createHash } from 'node:crypto';

import { DashboardError } from '../errors.ts';
import { isBitcoinMainnetAddress, isChecksummedEvmAddress } from './addresses.ts';
import pinnedPolicy from '../../../../../data/policy/donation-addresses.json' with { type: 'json' };

/**
 * The donation policy (CAS-008, D46): `data/policy/donation-addresses.json`,
 * read at build time and checked at render time against the digest pinned
 * below. The file and this constant change in one reviewed commit or the
 * page refuses with `donation_policy_drift`; a test reads the committed file
 * and fails when the two disagree. Each entry's address is verified by its
 * own checksum (`addresses.ts`). The file ships with an empty list until the
 * owner's file arrives, by file and never in chat.
 */
export const DONATION_POLICY_VERSION = 'donation-addresses@1';
/** SHA-256 of the canonical entry list the committed file holds; `[]` until the owner's entries land. */
export const DONATION_ENTRIES_DIGEST =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

export const DONATION_CHAINS = ['bitcoin', 'ethereum', 'base'] as const;
export type DonationChain = (typeof DONATION_CHAINS)[number];

const TOKENS: Readonly<Record<DonationChain, readonly string[]>> = {
  bitcoin: ['BTC'],
  ethereum: ['ETH', 'USDC'],
  base: ['ETH', 'USDC'],
};
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ().,'-]{0,39}$/u;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const NOTE_MAX = 200;
const ENTRIES_MAX = 8;
/** The file's own commentary, as the other policy files carry it; read for shape, never rendered. */
const COMMENT_LINES_MAX = 40;
const COMMENT_LINE_MAX = 200;

export interface DonationEntry {
  readonly chain: DonationChain;
  readonly label: string;
  readonly address: string;
  readonly tokens: readonly string[];
  readonly verifiedOn: string;
  readonly note: string;
}

function malformed(detail: string): DashboardError {
  return new DashboardError(
    'configuration',
    'donation_policy_malformed',
    `donation policy rejected: ${detail}`,
  );
}

/** The canonical text the digest covers: entries in file order, keys in a fixed order. */
export function canonicalEntries(entries: readonly DonationEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      address: entry.address,
      chain: entry.chain,
      label: entry.label,
      note: entry.note,
      tokens: [...entry.tokens],
      verifiedOn: entry.verifiedOn,
    })),
  );
}

export function entriesDigest(entries: readonly DonationEntry[]): string {
  return createHash('sha256').update(canonicalEntries(entries), 'utf8').digest('hex');
}

function entry(value: unknown, index: number): DonationEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(`entry ${index} is not an object`);
  }
  const raw = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'address,chain,label,note,tokens,verifiedOn') {
    throw malformed(`entry ${index} has unexpected keys`);
  }
  const chain = raw['chain'];
  if (typeof chain !== 'string' || !(DONATION_CHAINS as readonly string[]).includes(chain)) {
    throw malformed(`entry ${index} names an unknown chain`);
  }
  const typedChain = chain as DonationChain;
  const label = raw['label'];
  if (typeof label !== 'string' || !LABEL.test(label)) throw malformed(`entry ${index} label`);
  const address = raw['address'];
  if (typeof address !== 'string') throw malformed(`entry ${index} address`);
  const valid =
    typedChain === 'bitcoin' ? isBitcoinMainnetAddress(address) : isChecksummedEvmAddress(address);
  if (!valid) throw malformed(`entry ${index} address fails its checksum`);
  const tokens = raw['tokens'];
  if (
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    tokens.length > TOKENS[typedChain].length ||
    new Set(tokens).size !== tokens.length ||
    !tokens.every((token) => typeof token === 'string' && TOKENS[typedChain].includes(token))
  ) {
    throw malformed(`entry ${index} tokens`);
  }
  const verifiedOn = raw['verifiedOn'];
  if (typeof verifiedOn !== 'string' || !DATE.test(verifiedOn)) {
    throw malformed(`entry ${index} verifiedOn`);
  }
  const note = raw['note'];
  if (typeof note !== 'string' || note.length > NOTE_MAX) throw malformed(`entry ${index} note`);
  return {
    chain: typedChain,
    label,
    address,
    tokens: tokens.map(String),
    verifiedOn,
    note,
  };
}

/**
 * The entries of a policy value, or a fixed refusal: `donation_policy_malformed`
 * for any shape failure, `donation_policy_drift` when the entries do not match
 * the pinned digest.
 */
export function loadDonationPolicy(
  value: unknown,
  pinnedDigest: string = DONATION_ENTRIES_DIGEST,
): readonly DonationEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed('not an object');
  }
  const raw = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'entries,version' && keys !== '$comment,entries,version') {
    throw malformed('unexpected keys');
  }
  const comment = raw['$comment'];
  if (
    comment !== undefined &&
    (!Array.isArray(comment) ||
      comment.length > COMMENT_LINES_MAX ||
      !comment.every((line) => typeof line === 'string' && line.length <= COMMENT_LINE_MAX))
  ) {
    throw malformed('comment');
  }
  if (raw['version'] !== DONATION_POLICY_VERSION) throw malformed('version');
  const list = raw['entries'];
  if (!Array.isArray(list) || list.length > ENTRIES_MAX) throw malformed('entries');
  const entries = list.map((item, index) => entry(item, index));
  const seen = new Set<string>();
  for (const item of entries) {
    const key = `${item.chain}:${item.address}`;
    if (seen.has(key)) throw malformed('duplicate chain and address');
    seen.add(key);
  }
  if (entriesDigest(entries) !== pinnedDigest) {
    throw new DashboardError(
      'configuration',
      'donation_policy_drift',
      'the donation policy file does not match the digest pinned in code',
    );
  }
  return entries;
}

/** The committed policy, as the build read it. */
export function pinnedDonationPolicy(): unknown {
  return pinnedPolicy;
}
