import { describe, expect, it } from 'vitest';

import { adaptStandardizedTvl, type StandardizedTvlReading } from './adapter.js';
import { GraphProbeError } from './errors.js';
import {
  assertUniqueTargets,
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  validateLiveIdentity,
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
    slug: `protocol-${index}`,
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

function reading(t: DeploymentTarget, over: ReadingOverrides = {}): StandardizedTvlReading {
  const payload = validPayload();
  const protocols = payload['protocols'] as Record<string, unknown>[];
  payload['protocols'] = [
    { ...protocols[0], name: t.protocol, slug: t.slug, ...(over.protocol ?? {}) },
  ];
  if (over.meta) {
    payload['_meta'] = { ...(payload['_meta'] as Record<string, unknown>), ...over.meta };
  } else {
    payload['_meta'] = {
      ...(payload['_meta'] as Record<string, unknown>),
      deployment: `QmDeployment${t.label}`,
    };
  }
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

function baseTarget(index: number): DeploymentTarget {
  return target(
    {
      chain: 'base',
      expected: { network: 'BASE', protocolType: 'LENDING', schemaVersion: '3.1.0' },
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
    const t = target({ slug: 'registry-slug' });
    const e = evaluate(t, { protocol: { slug: 'provider-slug' } });
    expect(e.valid).toBe(true);
    expect(e.signal?.protocol.slug).toBe('provider-slug');
    expect(e.reading?.provenance.targetSlug).toBe('registry-slug');
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

  it('fails when the provider deployment identity is missing', () => {
    const t = target();
    const e = evaluate(t, {
      meta: {
        block: { number: 1, hash: '0x1', timestamp: T_NOW },
        deployment: null,
        hasIndexingErrors: false,
      },
    });
    expect(e.valid).toBe(false);
    expect(e.mismatches.map((m) => m.field)).toContain('_meta.deployment');
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

describe('evaluateChainGate distinctness', () => {
  it('does not count two configured labels that resolve to one provider identity as two', () => {
    const a = target({}, 0);
    const b = target({}, 1);
    // Both providers return the same protocol identity and the same deployment.
    const shared = { name: 'Shared Protocol', slug: 'shared-protocol' };
    const ea = evaluateTarget(
      a,
      reading(a, { protocol: shared, meta: { deployment: 'QmSame' } }),
      T_NOW,
      redact,
    );
    const eb = evaluateTarget(
      b,
      reading(b, { protocol: shared, meta: { deployment: 'QmSame' } }),
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
    expect(() => assertUniqueTargets([a, b])).toThrowError(/same subgraph ID twice/);
    const gate = evaluateChainGate([evaluate(a), evaluate(b)], { ...ETHEREUM_GATE, minimum: 2 });
    expect(gate.distinctSubgraphIds).toBe(1);
    expect(gate.passed).toBe(false);
  });

  it('rejects a registry that declares the same label twice', () => {
    expect(() => assertUniqueTargets([target({}, 0), target({ label: 'target-0' }, 1)])).toThrow(
      /same label twice/,
    );
  });

  it('cannot pass the five-protocol gate with four distinct identities plus one duplicate', () => {
    const targets = [0, 1, 2, 3].map((i) => target({}, i));
    const evaluations = targets.map((t) => evaluate(t));
    const duplicate = target({}, 4);
    const dupOf = targets[0];
    if (dupOf === undefined) throw new Error('fixture');
    evaluations.push(
      evaluateTarget(
        duplicate,
        reading(duplicate, {
          protocol: { name: dupOf.protocol, slug: dupOf.slug },
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
    // A Base-configured, Base-reporting target cannot count toward the Ethereum gate.
    const evaluations = [0, 1, 2, 3].map((i) => evaluate(target({}, i)));
    evaluations.push(evaluate(baseTarget(4), { protocol: { network: 'BASE' } }));
    const gate = evaluateChainGate(evaluations, ETHEREUM_GATE);
    expect(gate.valid).toBe(4);
    expect(gate.passed).toBe(false);
  });

  it('records Base as FAIL/DROP when only one of two Base targets succeeds', () => {
    const ok = evaluate(baseTarget(0), { protocol: { network: 'BASE' } });
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
    const a = evaluate(baseTarget(0), { protocol: { network: 'BASE' } });
    const b = evaluate(baseTarget(1), { protocol: { network: 'BASE' } });
    const gate = evaluateChainGate([a, b], BASE_GATE);
    expect(gate).toMatchObject({ passed: true, valid: 2, distinctIdentities: 2, reasons: [] });
    // Same identity twice on Base is not two.
    const dup = evaluateTarget(
      baseTarget(1),
      reading(baseTarget(1), {
        protocol: { network: 'BASE', name: 'Protocol 0', slug: 'protocol-0' },
        meta: { deployment: 'QmDeploymenttarget-0' },
      }),
      T_NOW,
      redact,
    );
    expect(evaluateChainGate([a, dup], BASE_GATE).passed).toBe(false);
  });
});
