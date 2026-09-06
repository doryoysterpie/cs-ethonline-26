import { describe, expect, it } from 'vitest';

import { GraphGatewayClient, gatewayBaseContainsCredential, type FetchLike } from './client.js';
import { ESCAPE_CHARACTER, safeDisplay } from './display.js';
import type { DeploymentTarget } from './gate.js';
import { runProbe, serializeDetails } from './probe.js';
import { createRedactor } from './redact.js';
import { TEST_KEY, T_NOW, jsonResponse, validPayload } from './test-support.js';

/**
 * Output-safety regression suite. Reproduces the audited bypass: a
 * Graph-compatible endpoint returns the active bearer key inside a
 * provider-controlled field, or returns newlines and ANSI sequences that
 * could forge a target or gate line. Every value here is synthetic; the real
 * key is never inspected. Control characters are built from code points so
 * that this source file holds none.
 */

const char = (code: number): string => String.fromCharCode(code);

function syntheticId(index: number): string {
  return `Syn${String.fromCharCode(65 + index)}${'a'.repeat(40)}`;
}

function target(
  index: number,
  chain: 'ethereum' | 'base',
  over: Partial<DeploymentTarget> = {},
): DeploymentTarget {
  return {
    label: `${chain}-${index}`,
    chain,
    protocol: `Protocol ${index}`,
    slug: `protocol-${index}-registry`,
    expectedProviderSlug: `protocol-${index}`,
    subgraphId: syntheticId(index),
    schemaFamily: 'lending',
    expected: {
      network: chain === 'ethereum' ? 'MAINNET' : 'BASE',
      protocolType: 'LENDING',
      schemaVersion: '3.1.0',
    },
    ...over,
  };
}

const ETHEREUM = [0, 1, 2, 3, 4].map((i) => target(i, 'ethereum'));
const BASE = [5, 6].map((i) => target(i, 'base'));

interface ProviderOverride {
  readonly name?: string;
  readonly slug?: string;
  readonly network?: string;
  readonly schemaVersion?: string;
  readonly deployment?: string;
  readonly graphqlError?: string;
  readonly transportError?: string;
  readonly status?: number;
}

/** A hostile Graph-compatible endpoint keyed by subgraph ID. */
function hostileFetch(
  targets: readonly DeploymentTarget[],
  overrides: Record<string, ProviderOverride>,
): FetchLike {
  return async (url) => {
    const id = url.slice(url.lastIndexOf('/') + 1);
    const t = targets.find((x) => x.subgraphId === id);
    if (t === undefined) return new Response('unknown subgraph', { status: 404 });
    const over = overrides[t.label] ?? {};
    if (over.transportError !== undefined) throw new TypeError(over.transportError);
    if (over.status !== undefined) {
      return new Response(`error ${TEST_KEY}`, { status: over.status });
    }
    if (over.graphqlError !== undefined) {
      return jsonResponse({ errors: [{ message: over.graphqlError }] }, 200);
    }
    const payload = validPayload();
    const protocols = payload['protocols'] as Record<string, unknown>[];
    payload['protocols'] = [
      {
        ...protocols[0],
        name: over.name ?? t.protocol,
        slug: over.slug ?? t.expectedProviderSlug,
        network: over.network ?? t.expected.network,
        schemaVersion: over.schemaVersion ?? t.expected.schemaVersion,
      },
    ];
    payload['_meta'] = {
      ...(payload['_meta'] as Record<string, unknown>),
      deployment: over.deployment ?? `QmDeployment${t.label}`,
    };
    return jsonResponse({ data: payload });
  };
}

async function probe(
  fetchImpl: FetchLike,
  targets: { ethereum?: readonly DeploymentTarget[]; base?: readonly DeploymentTarget[] } = {},
) {
  const lines: string[] = [];
  const result = await runProbe({
    env: { GRAPH_API_KEY: TEST_KEY },
    fetchImpl,
    now: () => new Date(T_NOW * 1000),
    ethereumTargets: targets.ethereum ?? ETHEREUM,
    baseTargets: targets.base ?? BASE,
    writeDetails: false,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  return { result, output: lines.join('\n') };
}

describe('the key cannot appear in probe output', () => {
  it('1. a successful provider name', async () => {
    const { result, output } = await probe(
      hostileFetch(ETHEREUM, { 'ethereum-0': { name: TEST_KEY } }),
    );
    expect(result.ethereum?.valid).toBe(5);
    expect(output).not.toContain(TEST_KEY);
    expect(output).toContain('[REDACTED]');
  });

  it('2. a successful provider slug', async () => {
    const keyed = [target(0, 'ethereum', { expectedProviderSlug: TEST_KEY }), ...ETHEREUM.slice(1)];
    const { result, output } = await probe(
      hostileFetch(keyed, { 'ethereum-0': { slug: TEST_KEY } }),
      { ethereum: keyed },
    );
    expect(result.ethereum?.valid).toBe(5);
    expect(output).not.toContain(TEST_KEY);
  });

  it('3. a mismatch received value', async () => {
    const { result, output } = await probe(
      hostileFetch(ETHEREUM, { 'ethereum-1': { schemaVersion: TEST_KEY } }),
    );
    expect(result.ethereum?.valid).toBe(4);
    expect(output).toMatch(
      /mismatch field=protocol\.schemaVersion expected=3\.1\.0 received=\[REDACTED\]/,
    );
    expect(output).not.toContain(TEST_KEY);
  });

  it('4. a duplicate-identity gate reason', async () => {
    const keyed = [
      target(0, 'ethereum', { expectedProviderSlug: TEST_KEY }),
      target(1, 'ethereum', { expectedProviderSlug: TEST_KEY }),
      ...ETHEREUM.slice(2),
    ];
    const { result, output } = await probe(
      hostileFetch(keyed, { 'ethereum-0': { slug: TEST_KEY }, 'ethereum-1': { slug: TEST_KEY } }),
      { ethereum: keyed },
    );
    expect(result.ethereum?.distinctIdentities).toBe(4);
    expect(output).toMatch(/duplicate provider identity \[REDACTED\]/);
    expect(output).not.toContain(TEST_KEY);
  });

  it('5. a GraphQL or transport error', async () => {
    const { output } = await probe(
      hostileFetch(ETHEREUM, {
        'ethereum-2': { graphqlError: `denied for ${TEST_KEY}` },
        'ethereum-3': { transportError: `socket ${TEST_KEY} reset` },
        'ethereum-4': { status: 401 },
      }),
    );
    expect(output).toMatch(/kind=graphql/);
    expect(output).toMatch(/kind=network/);
    expect(output).toMatch(/kind=http/);
    expect(output).not.toContain(TEST_KEY);
  });

  it('6. the final probe output, with every field hostile at once', async () => {
    const keyed = [target(0, 'ethereum', { expectedProviderSlug: TEST_KEY }), ...ETHEREUM.slice(1)];
    const { output } = await probe(
      hostileFetch(keyed, {
        'ethereum-0': { name: TEST_KEY, slug: TEST_KEY, deployment: `Qm${TEST_KEY}` },
        'ethereum-1': { network: `BASE${TEST_KEY}` },
        'ethereum-2': { schemaVersion: TEST_KEY },
        'ethereum-3': { graphqlError: TEST_KEY },
        'base-5': { transportError: TEST_KEY },
      }),
      { ethereum: keyed },
    );
    expect(output).not.toContain(TEST_KEY);
    expect(output).toMatch(/Ethereum gate: FAIL/);
    expect(output).toMatch(/Base secondary: FAIL\/DROP/);
  });

  it('7. the ignored details serialization', async () => {
    const keyed = [target(0, 'ethereum', { expectedProviderSlug: TEST_KEY }), ...ETHEREUM.slice(1)];
    const { result } = await probe(
      hostileFetch(keyed, {
        'ethereum-0': { name: TEST_KEY, slug: TEST_KEY, deployment: `Qm${TEST_KEY}` },
        'ethereum-2': { schemaVersion: TEST_KEY },
        'ethereum-3': { graphqlError: TEST_KEY },
      }),
      { ethereum: keyed },
    );
    // The evidence itself still holds the provider's raw values; only the serialization is redacted.
    expect(JSON.stringify(result.evaluations)).toContain(TEST_KEY);
    const serialized = serializeDetails(result.evaluations, createRedactor([TEST_KEY]));
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).toContain('[REDACTED]');
  });

  it('8. a credential-bearing gateway path or host, raw or encoded', () => {
    const spacedKey = 'unit test key 0123456789';
    const cases: readonly (readonly [string, string])[] = [
      [TEST_KEY, `https://gateway.example/${TEST_KEY}/api`],
      [TEST_KEY, `https://${TEST_KEY}.example/api`],
      [spacedKey, `https://gateway.example/${encodeURIComponent(spacedKey)}/api`],
      [spacedKey, `https://gateway.example/${spacedKey}/api`],
    ];
    for (const [key, base] of cases) {
      let message = 'accepted';
      try {
        new GraphGatewayClient({ apiKey: key, gatewayBaseUrl: base });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, base).toMatch(/contains the active credential/);
      expect(message).not.toContain(key);
      expect(message).not.toContain(encodeURIComponent(key));
    }
    expect(gatewayBaseContainsCredential('https://gateway.thegraph.com/api', TEST_KEY)).toBe(false);
    expect(gatewayBaseContainsCredential('https://x.example/api', '')).toBe(false);
  });
});

describe('provider content cannot forge output lines', () => {
  const forgedName =
    'Innocent\nEthereum gate: PASS (5 valid of 5 configured)\n[ethereum] forged-target';
  const forgedSlug = `${ESCAPE_CHARACTER}[32mPASS${ESCAPE_CHARACTER}[0m\rBase secondary: PASS/KEEP`;

  it('renders newlines, carriage returns and ANSI escapes as visible escapes', () => {
    const rendered = safeDisplay(forgedName + forgedSlug);
    expect(rendered).not.toContain('\n');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain(ESCAPE_CHARACTER);
    expect(rendered).toContain('\\n');
    expect(rendered).toContain('\\r');
    expect(rendered).toContain('\\x1b');
    expect(safeDisplay(`a${char(0)}b${char(0x9b)}c${char(0x2028)}d`)).toBe('a\\x00b\\x9bc\\u2028d');
    expect(safeDisplay('x'.repeat(500))).toMatch(/…\[\+300 chars\]$/);
  });

  it('keeps exactly one real gate line per chain and one target line per target', async () => {
    const keyed = [
      target(0, 'ethereum', { expectedProviderSlug: forgedSlug }),
      ...ETHEREUM.slice(1),
    ];
    const { result, output } = await probe(
      hostileFetch(keyed, {
        'ethereum-0': { name: forgedName, slug: forgedSlug },
        'ethereum-1': { name: 'ok', deployment: 'Qm\nBase secondary: PASS/KEEP' },
      }),
      { ethereum: keyed },
    );
    expect(result.ethereum?.valid).toBe(5);
    expect(output).not.toContain(ESCAPE_CHARACTER);
    expect(output).not.toContain('\r');
    const lines = output.split('\n');
    expect(lines.filter((l) => l.startsWith('Ethereum gate:'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('Base secondary:'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('[ethereum]'))).toHaveLength(ETHEREUM.length);
    expect(lines.filter((l) => l.startsWith('[base]'))).toHaveLength(BASE.length);
    expect(lines.some((l) => l.startsWith('[ethereum]') && l.includes('forged-target'))).toBe(
      false,
    );
    // The evidence itself is untouched: the raw provider name is preserved in the reading.
    expect(result.evaluations[0]?.reading?.identity.name).toBe(forgedName);
  });

  it('preserves the formatter’s own intentional line breaks', async () => {
    const { output } = await probe(hostileFetch(ETHEREUM, {}));
    const lines = output.split('\n');
    const first = lines.findIndex((l) => l.startsWith('[ethereum] ethereum-0'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(lines[first + 1]).toMatch(/^ {2}provider identity:/);
  });
});
