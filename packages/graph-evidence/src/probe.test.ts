import { describe, expect, it } from 'vitest';

import type { FetchLike } from './client.js';
import type { DeploymentTarget } from './gate.js';
import { runProbe } from './probe.js';
import { TEST_KEY, T_NOW, jsonResponse, validPayload } from './test-support.js';

/**
 * Exit-code and output contract of the probe, with a synthetic provider. No
 * network, no secret: the key here is a unit-test constant.
 */

function syntheticId(index: number): string {
  return `Syn${String.fromCharCode(65 + index)}${'a'.repeat(40)}`;
}

function target(index: number, chain: 'ethereum' | 'base'): DeploymentTarget {
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
  };
}

const ETHEREUM = [0, 1, 2, 3, 4].map((i) => target(i, 'ethereum'));
const BASE = [5, 6].map((i) => target(i, 'base'));
const ALL = [...ETHEREUM, ...BASE];

type Override = { network?: string; status?: number };

/** Synthetic provider keyed by subgraph ID; identity mirrors the target it stands for. */
function syntheticFetch(overrides: Record<string, Override> = {}): FetchLike {
  return async (url) => {
    const id = url.slice(url.lastIndexOf('/') + 1);
    const t = ALL.find((x) => x.subgraphId === id);
    if (t === undefined) return new Response('unknown subgraph', { status: 404 });
    const over = overrides[t.label] ?? {};
    if (over.status !== undefined)
      return new Response('synthetic failure', { status: over.status });
    const payload = validPayload();
    const protocols = payload['protocols'] as Record<string, unknown>[];
    payload['protocols'] = [
      {
        ...protocols[0],
        name: t.protocol,
        slug: t.expectedProviderSlug,
        network: over.network ?? t.expected.network,
      },
    ];
    payload['_meta'] = {
      ...(payload['_meta'] as Record<string, unknown>),
      deployment: `QmDeployment${t.label}`,
    };
    return jsonResponse({ data: payload });
  };
}

async function run(
  fetchImpl: FetchLike,
  env: Record<string, string | undefined> = { GRAPH_API_KEY: TEST_KEY },
  targets: { ethereum?: readonly DeploymentTarget[]; base?: readonly DeploymentTarget[] } = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const result = await runProbe({
    env,
    fetchImpl,
    now: () => new Date(T_NOW * 1000),
    ethereumTargets: targets.ethereum ?? ETHEREUM,
    baseTargets: targets.base ?? BASE,
    writeDetails: false,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  return { result, lines, errors, output: [...lines, ...errors].join('\n') };
}

describe('runProbe exit codes and output', () => {
  it('exits 2 without a credential and prints a redacted reason', async () => {
    const { result, output } = await run(syntheticFetch(), { GRAPH_API_KEY: undefined });
    expect(result.code).toBe(2);
    expect(output).toMatch(/GRAPH_API_KEY is missing/);
  });

  it('exits 2 when the registry is not unique', async () => {
    const dup = { ...target(1, 'ethereum'), label: 'ethereum-dup' };
    const { result, output } = await run(
      syntheticFetch(),
      { GRAPH_API_KEY: TEST_KEY },
      { ethereum: [...ETHEREUM, dup] },
    );
    expect(result.code).toBe(2);
    expect(output).toMatch(/same subgraph ID twice/);
  });

  it('exits 2 when the registry is inconsistent, before any request', async () => {
    let called = false;
    const wrongFamily = {
      ...target(0, 'ethereum'),
      expected: { network: 'MAINNET', protocolType: 'EXCHANGE', schemaVersion: '3.1.0' },
    };
    const { result, output } = await run(
      async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
      { GRAPH_API_KEY: TEST_KEY },
      { ethereum: [wrongFamily] },
    );
    expect(result.code).toBe(2);
    expect(called).toBe(false);
    expect(output).toMatch(/inconsistent with the declared schema family/);
  });

  it('exits 0 when five verified Ethereum identities pass, and reports Base PASS/KEEP truthfully', async () => {
    const { result, output } = await run(syntheticFetch());
    expect(result.code).toBe(0);
    expect(result.ethereum?.passed).toBe(true);
    expect(result.base?.passed).toBe(true);
    expect(output).toMatch(/Ethereum gate: PASS/);
    expect(output).toMatch(/Base secondary: PASS\/KEEP/);
    expect(output).not.toContain(TEST_KEY);
  });

  it('exits 1 when an Ethereum target reports Base, with a structured mismatch line', async () => {
    const { result, output } = await run(syntheticFetch({ 'ethereum-2': { network: 'BASE' } }));
    expect(result.code).toBe(1);
    expect(result.ethereum?.passed).toBe(false);
    expect(output).toMatch(/mismatch field=protocol\.network expected=MAINNET received=BASE/);
    expect(output).toMatch(/Ethereum gate: FAIL/);
  });

  it('keeps exit 0 but prints Base FAIL/DROP when only one Base target succeeds', async () => {
    const { result, output } = await run(syntheticFetch({ 'base-6': { status: 503 } }));
    expect(result.code).toBe(0);
    expect(result.base?.passed).toBe(false);
    expect(output).toMatch(/Base secondary: FAIL\/DROP/);
    expect(output).toMatch(/1 of 2 configured targets verified; all are required/);
  });

  it('prints Base FAIL/DROP when a Base target reports Ethereum mainnet', async () => {
    const { result, output } = await run(syntheticFetch({ 'base-5': { network: 'MAINNET' } }));
    expect(result.code).toBe(0);
    expect(result.base?.passed).toBe(false);
    expect(output).toMatch(/mismatch field=protocol\.network expected=BASE received=MAINNET/);
  });
});
