import { describe, expect, it } from 'vitest';

import { adaptStandardizedTvl, type StandardizedTvlReading } from './adapter.js';
import { BASE_LENDING_TARGETS, ETHEREUM_LENDING_TARGETS } from './deployments.js';
import { GraphProbeError } from './errors.js';
import {
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  presentDeploymentId,
  protocolIdentityKey,
  validateLiveIdentity,
  validateRegistry,
  type DeploymentTarget,
  type TargetEvaluation,
} from './gate.js';
import { T_NOW, validPayload } from './test-support.js';

const redact = (s: string): string => s;

/** Synthetic base58-shaped subgraph IDs, distinct per index. */
function syntheticId(index: number): string {
  return `Syn${String.fromCharCode(65 + index)}${'a'.repeat(40)}`;
}

function target(over: Partial<DeploymentTarget> = {}, index = 0): DeploymentTarget {
  return {
    label: `target-${index}`,
    chain: 'ethereum',
    protocol: `Protocol ${index}`,
    slug: `protocol-${index}-registry`,
    expectedProviderSlug: `protocol-${index}`,
    subgraphId: syntheticId(index),
    schemaFamily: 'lending',
    expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
    ...over,
  };
}

interface ReadingOverrides {
  readonly protocol?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

/** A provider reading whose identity mirrors the target's expectations unless overridden. */
function reading(t: DeploymentTarget, over: ReadingOverrides = {}): StandardizedTvlReading {
  const payload = validPayload();
  const protocols = payload['protocols'] as Record<string, unknown>[];
  payload['protocols'] = [
    {
      ...protocols[0],
      name: t.protocol,
      slug: t.expectedProviderSlug,
      network: t.expected.network,
      type: t.expected.protocolType,
      schemaVersion: t.expected.schemaVersion,
      ...(over.protocol ?? {}),
    },
  ];
  payload['_meta'] = {
    ...(payload['_meta'] as Record<string, unknown>),
    deployment: `QmDeployment${t.label}`,
    ...(over.meta ?? {}),
  };
  return adaptStandardizedTvl(payload, {
    subgraphId: t.subgraphId,
    targetChain: t.chain,
    targetSlug: t.slug,
    queriedAtUtc: new Date(T_NOW * 1000).toISOString(),
    queryDocumentSha256: 'deadbeef',
    provider: 'the-graph-gateway',
    providerBase: 'https://gateway.thegraph.com/api',
  });
}

function evaluate(t: DeploymentTarget, over: ReadingOverrides = {}): TargetEvaluation {
  return evaluateTarget(t, reading(t, over), T_NOW, redact);
}

const ETHEREUM_GATE = { chain: 'ethereum', minimum: 5, requireAll: false } as const;
const BASE_GATE = { chain: 'base', minimum: 2, requireAll: true } as const;

function baseTarget(index: number, over: Partial<DeploymentTarget> = {}): DeploymentTarget {
  return target(
    {
      chain: 'base',
      expected: { network: 'BASE', protocolType: 'LENDING', schemaVersion: '3.1.0' },
      ...over,
    },
    index,
  );
}

describe('validateLiveIdentity and evaluateTarget', () => {
  it('fails an Ethereum-labelled target whose provider reports Base', () => {
    const t = target();
    const e = evaluate(t, { protocol: { network: 'BASE' } });
    expect(e.valid).toBe(false);
    expect(e.mismatches).toContainEqual({
      targetLabel: t.label,
      field: 'protocol.network',
      expected: 'MAINNET',
      received: 'BASE',
      subgraphId: t.subgraphId,
    });
    expect(e.failure?.kind).toBe('validation');
    const gate = evaluateChainGate([e], ETHEREUM_GATE);
    expect(gate.valid).toBe(0);
    expect(gate.passed).toBe(false);
  });

  it('fails a Base-labelled target whose provider reports Ethereum mainnet', () => {
    const t = baseTarget(0);
    const e = evaluate(t, { protocol: { network: 'MAINNET' } });
    expect(e.valid).toBe(false);
    expect(e.mismatches.map((m) => m.field)).toContain('protocol.network');
    expect(evaluateChainGate([e], BASE_GATE).passed).toBe(false);
  });

  it('fails when the provider slug is missing', () => {
    const t = target();
    expect(() => reading(t, { protocol: { slug: '' } })).toThrowError(GraphProbeError);
    try {
      reading(t, { protocol: { slug: undefined } });
    } catch (error) {
      expect((error as GraphProbeError).kind).toBe('schema');
    }
  });

  it('preserves the provider slug in the signal instead of the registry slug', () => {
    const t = target({ slug: 'registry-slug', expectedProviderSlug: 'provider-slug' });
    const e = evaluate(t, { protocol: { slug: 'provider-slug' } });
    expect(e.valid).toBe(true);
    expect(e.signal?.protocol.slug).toBe('provider-slug');
    expect(e.reading?.provenance.targetSlug).toBe('registry-slug');
  });

  it('fails when the provider slug differs from the expected provider slug', () => {
    const t = target({ expectedProviderSlug: 'expected-lending' });
    const e = evaluate(t, { protocol: { slug: 'another-unique-lending' } });
    expect(e.valid).toBe(false);
    expect(e.mismatches).toContainEqual(
      expect.objectContaining({
        field: 'protocol.slug',
        expected: 'expected-lending',
        received: 'another-unique-lending',
      }),
    );
    expect(evaluateChainGate([e], { ...ETHEREUM_GATE, minimum: 1 }).passed).toBe(false);
  });

  it('fails on the wrong protocol type or family', () => {
    const t = target();
    const e = evaluate(t, { protocol: { type: 'EXCHANGE' } });
    expect(e.valid).toBe(false);
    expect(e.mismatches).toContainEqual(
      expect.objectContaining({
        field: 'protocol.type',
        expected: 'LENDING',
        received: 'EXCHANGE',
      }),
    );
  });

  it('fails when the schema version is missing', () => {
    const t = target();
    expect(() => reading(t, { protocol: { schemaVersion: undefined } })).toThrowError(
      GraphProbeError,
    );
  });

  it('fails on a schema-version mismatch with a structured, sanitized message', () => {
    const t = target();
    const e = evaluate(t, { protocol: { schemaVersion: '2.0.1' } });
    expect(e.valid).toBe(false);
    expect(e.mismatches).toContainEqual(
      expect.objectContaining({
        targetLabel: t.label,
        field: 'protocol.schemaVersion',
        expected: '3.1.0',
        received: '2.0.1',
        subgraphId: t.subgraphId,
      }),
    );
    expect(e.failure?.details).toMatchObject({ targetLabel: t.label, subgraphId: t.subgraphId });
  });

  it('fails when the provider deployment identity is missing or whitespace-only', () => {
    const t = target();
    for (const deployment of [null, '', '   ', '\t\n']) {
      const e = evaluate(t, {
        meta: {
          block: { number: 1, hash: '0x1', timestamp: T_NOW },
          deployment,
          hasIndexingErrors: false,
        },
      });
      expect(e.valid, `deployment=${JSON.stringify(deployment)}`).toBe(false);
      expect(e.mismatches.map((m) => m.field)).toContain('_meta.deployment');
    }
    expect(presentDeploymentId(null)).toBeNull();
    expect(presentDeploymentId('  ')).toBeNull();
    expect(presentDeploymentId(' QmX ')).toBe('QmX');
  });

  it('reports no mismatch for a matching reading', () => {
    const t = target();
    expect(validateLiveIdentity(t, reading(t))).toEqual([]);
    expect(evaluate(t).valid).toBe(true);
  });

  it('records a query failure as an invalid evaluation with its kind', () => {
    const e = evaluateFailedTarget(target(), new GraphProbeError('http', 'HTTP 503'), redact);
    expect(e.valid).toBe(false);
    expect(e.failure).toMatchObject({ kind: 'http', message: 'HTTP 503' });
  });
});

describe('canonical protocol identity', () => {
  it('is the normalized chain plus the provider slug, without the name', () => {
    const t = target();
    const key = protocolIdentityKey(reading(t, { protocol: { name: 'Any Display Name' } }));
    expect(key).toBe('ethereum:protocol-0');
    expect(key).not.toContain('Any Display Name');
  });

  it('counts the same chain and slug once when only the name differs', () => {
    const shared = 'same-protocol';
    const a = target({ expectedProviderSlug: shared }, 0);
    const b = target({ expectedProviderSlug: shared }, 1);
    const ea = evaluateTarget(
      a,
      reading(a, { protocol: { slug: shared, name: 'Same Protocol' } }),
      T_NOW,
      redact,
    );
    const eb = evaluateTarget(
      b,
      reading(b, { protocol: { slug: shared, name: 'Same Protocol v3' } }),
      T_NOW,
      redact,
    );
    const gate = evaluateChainGate([ea, eb], { ...ETHEREUM_GATE, minimum: 2 });
    expect(gate.valid).toBe(2);
    expect(gate.distinctIdentities).toBe(1);
    expect(gate.counted).toEqual([a.label]);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/duplicate provider identity same-protocol/);
  });

  it('does not let a provider name change manufacture distinctness across five targets', () => {
    const shared = 'renamed-protocol';
    const evaluations = [0, 1, 2, 3, 4].map((i) => {
      const t = target({ expectedProviderSlug: shared }, i);
      return evaluateTarget(
        t,
        reading(t, { protocol: { slug: shared, name: `Renamed ${i}` } }),
        T_NOW,
        redact,
      );
    });
    const gate = evaluateChainGate(evaluations, ETHEREUM_GATE);
    expect(gate.valid).toBe(5);
    expect(gate.distinctIdentities).toBe(1);
    expect(gate.passed).toBe(false);
  });

  it('keeps the five current Ethereum provider slugs distinct', () => {
    const slugs = ETHEREUM_LENDING_TARGETS.map((t) => t.expectedProviderSlug);
    expect(new Set(slugs).size).toBe(5);
    expect(slugs).toEqual(['aave-v3', 'spark-lend', 'makerdao', 'compound-v3', 'liquity']);
  });

  it('keeps the two current Base provider slugs distinct', () => {
    const slugs = BASE_LENDING_TARGETS.map((t) => t.expectedProviderSlug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toEqual(['seamless-protocol', 'moonwell']);
  });
});

describe('validateRegistry', () => {
  it('accepts the shipped registry', () => {
    expect(() =>
      validateRegistry([...ETHEREUM_LENDING_TARGETS, ...BASE_LENDING_TARGETS]),
    ).not.toThrow();
  });

  it('rejects an empty or whitespace expected provider slug', () => {
    expect(() => validateRegistry([target({ expectedProviderSlug: '' })])).toThrow(
      /empty expected provider slug/,
    );
    expect(() => validateRegistry([target({ expectedProviderSlug: '   ' })])).toThrow(
      /empty expected provider slug/,
    );
  });

  it('rejects an expected network that does not normalize to the configured chain', () => {
    expect(() =>
      validateRegistry([
        target({ expected: { network: 'BASE', protocolType: 'LENDING', schemaVersion: '3.1.0' } }),
      ]),
    ).toThrow(/does not normalize to the configured chain/);
    expect(() =>
      validateRegistry([
        target({
          expected: { network: 'ARBITRUM_ONE', protocolType: 'LENDING', schemaVersion: '3.1.0' },
        }),
      ]),
    ).toThrow(/does not normalize to the configured chain/);
    expect(() =>
      validateRegistry([
        baseTarget(0, {
          expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
        }),
      ]),
    ).toThrow(/does not normalize to the configured chain/);
  });

  it('rejects an expected protocol type inconsistent with the lending schema family', () => {
    expect(() =>
      validateRegistry([
        target({
          expected: { network: 'MAINNET', protocolType: 'EXCHANGE', schemaVersion: '3.1.0' },
        }),
      ]),
    ).toThrow(/inconsistent with the declared schema family/);
  });

  it('rejects duplicate labels and duplicate subgraph IDs', () => {
    expect(() => validateRegistry([target({}, 0), target({ label: 'target-0' }, 1)])).toThrow(
      /same label twice/,
    );
    const a = target({}, 0);
    expect(() => validateRegistry([a, target({ subgraphId: a.subgraphId }, 1)])).toThrow(
      /same subgraph ID twice/,
    );
  });
});

describe('evaluateChainGate distinctness', () => {
  it('does not count two configured labels that resolve to one provider identity as two', () => {
    const shared = 'shared-protocol';
    const a = target({ expectedProviderSlug: shared }, 0);
    const b = target({ expectedProviderSlug: shared }, 1);
    const ea = evaluateTarget(
      a,
      reading(a, { protocol: { slug: shared }, meta: { deployment: 'QmSame' } }),
      T_NOW,
      redact,
    );
    const eb = evaluateTarget(
      b,
      reading(b, { protocol: { slug: shared }, meta: { deployment: 'QmSame' } }),
      T_NOW,
      redact,
    );
    const gate = evaluateChainGate([ea, eb], { ...ETHEREUM_GATE, minimum: 2 });
    expect(gate.valid).toBe(2);
    expect(gate.distinctIdentities).toBe(1);
    expect(gate.counted).toEqual([a.label]);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/duplicate provider identity/);
  });

  it('does not count two targets using the same subgraph ID as two', () => {
    const a = target({}, 0);
    const b = target({ subgraphId: a.subgraphId }, 1);
    const gate = evaluateChainGate([evaluate(a), evaluate(b)], { ...ETHEREUM_GATE, minimum: 2 });
    expect(gate.distinctSubgraphIds).toBe(1);
    expect(gate.passed).toBe(false);
  });

  it('cannot pass the five-protocol gate with four distinct identities plus one duplicate', () => {
    const targets = [0, 1, 2, 3].map((i) => target({}, i));
    const evaluations = targets.map((t) => evaluate(t));
    const dupOf = targets[0];
    if (dupOf === undefined) throw new Error('fixture');
    const duplicate = target({ expectedProviderSlug: dupOf.expectedProviderSlug }, 4);
    evaluations.push(
      evaluateTarget(
        duplicate,
        reading(duplicate, {
          protocol: { name: dupOf.protocol, slug: dupOf.expectedProviderSlug },
          meta: { deployment: `QmDeployment${dupOf.label}` },
        }),
        T_NOW,
        redact,
      ),
    );
    const gate = evaluateChainGate(evaluations, ETHEREUM_GATE);
    expect(gate.valid).toBe(5);
    expect(gate.distinctIdentities).toBe(4);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/4 distinct verified identities, minimum 5/);
  });

  it('passes the Ethereum gate with five distinct verified identities', () => {
    const evaluations = [0, 1, 2, 3, 4].map((i) => evaluate(target({}, i)));
    const gate = evaluateChainGate(evaluations, ETHEREUM_GATE);
    expect(gate).toMatchObject({
      passed: true,
      valid: 5,
      distinctIdentities: 5,
      distinctSubgraphIds: 5,
      distinctDeploymentIds: 5,
      reasons: [],
    });
  });

  it('never counts a target whose provider reports another chain, even when otherwise valid', () => {
    const evaluations = [0, 1, 2, 3].map((i) => evaluate(target({}, i)));
    evaluations.push(evaluate(baseTarget(4)));
    const gate = evaluateChainGate(evaluations, ETHEREUM_GATE);
    expect(gate.valid).toBe(4);
    expect(gate.passed).toBe(false);
  });

  it('records Base as FAIL/DROP when only one of two Base targets succeeds', () => {
    const ok = evaluate(baseTarget(0));
    const failed = evaluateFailedTarget(
      baseTarget(1),
      new GraphProbeError('graphql', 'no allocations'),
      redact,
    );
    const gate = evaluateChainGate([ok, failed], BASE_GATE);
    expect(gate.valid).toBe(1);
    expect(gate.passed).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/1 of 2 configured targets verified; all are required/);
  });

  it('requires two valid, distinct Base targets for Base PASS/KEEP', () => {
    const a = evaluate(baseTarget(0));
    const b = evaluate(baseTarget(1));
    const gate = evaluateChainGate([a, b], BASE_GATE);
    expect(gate).toMatchObject({ passed: true, valid: 2, distinctIdentities: 2, reasons: [] });
    const dupTarget = baseTarget(1, { expectedProviderSlug: 'protocol-0' });
    const dup = evaluateTarget(
      dupTarget,
      reading(dupTarget, {
        protocol: { name: 'Protocol 0 renamed', slug: 'protocol-0' },
        meta: { deployment: 'QmDeploymenttarget-0' },
      }),
      T_NOW,
      redact,
    );
    expect(evaluateChainGate([a, dup], BASE_GATE).passed).toBe(false);
  });
});
