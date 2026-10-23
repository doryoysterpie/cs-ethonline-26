import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { isDashboardError } from '../errors.ts';
import {
  canonicalEntries,
  DONATION_ENTRIES_DIGEST,
  DONATION_POLICY_VERSION,
  entriesDigest,
  loadDonationPolicy,
  pinnedDonationPolicy,
  type DonationEntry,
} from './donations.ts';

const POLICY_FILE = new URL('../../../../../data/policy/donation-addresses.json', import.meta.url);

const SAMPLE: DonationEntry[] = [
  {
    chain: 'bitcoin',
    label: 'Bitcoin',
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    tokens: ['BTC'],
    verifiedOn: '2026-10-22',
    note: '',
  },
  {
    chain: 'ethereum',
    label: 'Ethereum mainnet',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    tokens: ['ETH', 'USDC'],
    verifiedOn: '2026-10-22',
    note: 'USDC on mainnet.',
  },
  {
    chain: 'base',
    label: 'Base',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    tokens: ['ETH', 'USDC'],
    verifiedOn: '2026-10-22',
    note: 'Same string as mainnet; verified by its own transfer.',
  },
];

function code(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    return isDashboardError(error) ? `${error.kind}:${error.code}` : 'other';
  }
  return 'none';
}

describe('the donation policy', () => {
  it('reads the committed file, which matches the digest pinned in code', async () => {
    const text = await readFile(POLICY_FILE, 'utf8');
    const parsed: unknown = JSON.parse(text);
    expect(loadDonationPolicy(parsed)).toEqual(loadDonationPolicy(pinnedDonationPolicy()));
    // When this fails, the received value is the digest to pin in DONATION_ENTRIES_DIGEST,
    // in the same commit as the file change (runbook, section 11).
    expect(
      entriesDigest(loadDonationPolicy(parsed)),
      'pin the received digest in DONATION_ENTRIES_DIGEST in the same commit',
    ).toBe(DONATION_ENTRIES_DIGEST);
  });

  it("pins the digest of the empty list while the owner's file has not arrived", () => {
    expect(entriesDigest([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
    expect(canonicalEntries([])).toBe('[]');
  });

  it('accepts a well-formed list against its own digest, in a canonical key order', () => {
    const digest = entriesDigest(SAMPLE);
    const shuffled = SAMPLE.map((entry) => ({
      verifiedOn: entry.verifiedOn,
      note: entry.note,
      tokens: entry.tokens,
      address: entry.address,
      label: entry.label,
      chain: entry.chain,
    }));
    expect(
      loadDonationPolicy({ version: DONATION_POLICY_VERSION, entries: shuffled }, digest),
    ).toEqual(SAMPLE);
  });

  it('refuses drift: an entry changed without the pinned digest changing', () => {
    const digest = entriesDigest(SAMPLE);
    const edited = SAMPLE.map((entry, index) =>
      index === 0 ? { ...entry, verifiedOn: '2026-10-23' } : entry,
    );
    expect(
      code(() => loadDonationPolicy({ version: DONATION_POLICY_VERSION, entries: edited }, digest)),
    ).toBe('configuration:donation_policy_drift');
    expect(
      code(() => loadDonationPolicy({ version: DONATION_POLICY_VERSION, entries: SAMPLE })),
    ).toBe('configuration:donation_policy_drift');
  });

  it('refuses every malformed shape with one fixed code, before any digest is compared', () => {
    const digest = entriesDigest(SAMPLE);
    const at = (entries: unknown, version: unknown = DONATION_POLICY_VERSION) =>
      code(() => loadDonationPolicy({ version, entries }, digest));
    const withFirst = (patch: Record<string, unknown>) => [
      { ...SAMPLE[0], ...patch },
      ...SAMPLE.slice(1),
    ];
    expect(at(SAMPLE, 'donation-addresses@2')).toBe('configuration:donation_policy_malformed');
    expect(at('nope')).toBe('configuration:donation_policy_malformed');
    expect(at(withFirst({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5' }))).toBe(
      'configuration:donation_policy_malformed',
    );
    expect(at(withFirst({ chain: 'solana' }))).toBe('configuration:donation_policy_malformed');
    expect(at(withFirst({ tokens: ['ETH'] }))).toBe('configuration:donation_policy_malformed');
    expect(at(withFirst({ tokens: [] }))).toBe('configuration:donation_policy_malformed');
    expect(at(withFirst({ verifiedOn: '22/10/2026' }))).toBe(
      'configuration:donation_policy_malformed',
    );
    expect(at(withFirst({ note: 'x'.repeat(201) }))).toBe(
      'configuration:donation_policy_malformed',
    );
    expect(at(withFirst({ label: '<b>' }))).toBe('configuration:donation_policy_malformed');
    expect(at(withFirst({ extra: 1 }))).toBe('configuration:donation_policy_malformed');
    expect(at([...SAMPLE, SAMPLE[1]])).toBe('configuration:donation_policy_malformed');
    expect(at([SAMPLE[1], { ...SAMPLE[1], address: SAMPLE[1]?.address.toLowerCase() }])).toBe(
      'configuration:donation_policy_malformed',
    );
    expect(
      code(() =>
        loadDonationPolicy(
          { version: DONATION_POLICY_VERSION, entries: SAMPLE, extra: true },
          digest,
        ),
      ),
    ).toBe('configuration:donation_policy_malformed');
    expect(code(() => loadDonationPolicy(null, digest))).toBe(
      'configuration:donation_policy_malformed',
    );
    expect(
      code(() =>
        loadDonationPolicy(
          { $comment: 'not a list', version: DONATION_POLICY_VERSION, entries: SAMPLE },
          digest,
        ),
      ),
    ).toBe('configuration:donation_policy_malformed');
    expect(
      loadDonationPolicy(
        { $comment: ['a note'], version: DONATION_POLICY_VERSION, entries: SAMPLE },
        digest,
      ),
    ).toEqual(SAMPLE);
  });
});
