import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ETHEREUM_LENDING_TARGETS } from '@cas/graph-evidence';
import { describe, expect, it } from 'vitest';

import { GraphLiveSignalSource } from './engines/live-graph.js';
import { createRuntime } from './runtime.js';
import {
  connectInMemory,
  fakeFetch,
  ForbiddenStore,
  hasRawControl,
  HOSTILE,
  jsonResponse,
  SECRET_API_KEY,
  structured,
  syntheticPayload,
  T_NOW,
  textOf,
  validResponder,
} from './test-support.js';

/**
 * Live mode through the real Sprint 1 client with a synthetic provider. No
 * socket is opened: the fetch implementation is injected, every payload is
 * invented, and the store is one that throws if it is ever reached.
 */

const NOW = () => new Date(T_NOW * 1000);

function liveSource(
  fetchImpl: ReturnType<typeof fakeFetch>,
  apiKey = SECRET_API_KEY,
): GraphLiveSignalSource {
  return new GraphLiveSignalSource({ apiKey, fetchImpl, now: NOW });
}

describe('chain_anomalies in live mode', () => {
  it('returns provider, block and query provenance for every valid target and never reads the store', async () => {
    const fetchImpl = fakeFetch(validResponder);
    const harness = await connectInMemory({
      store: new ForbiddenStore(),
      live: liveSource(fetchImpl),
      now: NOW,
    });
    try {
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'ethereum' },
      });
      expect(result.isError).not.toBe(true);
      const output = structured(result);
      expect(output['mode']).toBe('live');
      expect(output['stored']).toBeNull();
      const live = output['live'] as Record<string, unknown>;
      expect(live['provider']).toBe('the-graph-gateway');
      expect(live['providerBase']).toBe('https://gateway.thegraph.com/api');
      expect(live['targetsConfigured']).toBe(ETHEREUM_LENDING_TARGETS.length);
      expect(live['targetsValid']).toBe(ETHEREUM_LENDING_TARGETS.length);
      const targets = live['targets'] as Record<string, unknown>[];
      for (const target of targets) {
        expect(target['outcome']).toBe('valid');
        const provenance = target['provenance'] as Record<string, unknown>;
        expect(provenance['origin']).toBe('live');
        expect(provenance['provider']).toBe('the-graph-gateway');
        expect((provenance['block'] as Record<string, unknown>)['number']).toBe(25_000_000);
        expect(provenance['queriedAtUtc']).toBe(NOW().toISOString());
        expect(typeof provenance['queryDocumentSha256']).toBe('string');
        expect((provenance['deploymentId'] as Record<string, unknown>)['trust']).toBe(
          'untrusted_quoted_evidence',
        );
        const anomaly = target['anomaly'] as Record<string, unknown>;
        expect(anomaly['label']).toBe('insufficient_history');
        expect(anomaly['reasonCodes']).toEqual(['insufficient_history']);
        const signal = target['signal'] as Record<string, unknown>;
        expect(signal['deltaPercent']).toBe('5.050000');
      }
      // Every request carried the key only as a bearer header, never in the URL.
      expect(fetchImpl.requests).toHaveLength(ETHEREUM_LENDING_TARGETS.length);
      for (const request of fetchImpl.requests) {
        expect(request.url).not.toContain(SECRET_API_KEY);
        const headers = request.init.headers as Record<string, string>;
        expect(headers['authorization']).toBe(`Bearer ${SECRET_API_KEY}`);
      }
      expect(textOf(result)).not.toContain(SECRET_API_KEY);
    } finally {
      await harness.close();
    }
  });

  it('fails with a fixed code when the credential is absent and substitutes nothing', async () => {
    const harness = await connectInMemory({ store: new ForbiddenStore(), live: null });
    try {
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'base' },
      });
      expect(result.isError).toBe(true);
      const error = JSON.parse(textOf(result)) as { error: { code: string; message: string } };
      expect(error.error.code).toBe('graph_credential_missing');
      expect(error.error.message).toContain('no replay or fixture data is substituted');
    } finally {
      await harness.close();
    }
  });

  it('constructs no live source from an empty credential', () => {
    const runtime = createRuntime({
      env: { GRAPH_API_KEY: '   ' },
      log: () => undefined,
      store: null,
    });
    expect(runtime.live).toBeNull();
  });

  it('refuses a bad gateway URL at startup without echoing it', () => {
    const marker = 'https://user:pass@evil.example/api?leak=1';
    let message = '';
    try {
      createRuntime({
        env: { GRAPH_API_KEY: SECRET_API_KEY, GRAPH_GATEWAY_URL: marker },
        log: () => undefined,
        store: null,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('gateway base URL rejected');
    expect(message).not.toContain('evil.example');
    expect(message).not.toContain('pass');
  });

  it('reports each provider failure by kind with a fixed sentence and no provider text', async () => {
    const apiKeyEcho = SECRET_API_KEY;
    const fetchImpl = fakeFetch(async (target) => {
      switch (target.expectedProviderSlug) {
        case 'aave-v3':
          return jsonResponse({ error: `boom ${HOSTILE.instruction} ${apiKeyEcho}` }, 500);
        case 'spark-lend':
          return jsonResponse({ errors: [{ message: `${HOSTILE.tag} ${apiKeyEcho}` }] });
        case 'makerdao':
          throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
            name: 'TypeError',
          });
        case 'compound-v3':
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        default:
          return jsonResponse({
            data: syntheticPayload(target, {
              _meta: {
                block: { number: 1, hash: null, timestamp: T_NOW },
                deployment: 'QmX',
                hasIndexingErrors: true,
              },
            }),
          });
      }
    });
    const harness = await connectInMemory({
      store: new ForbiddenStore(),
      live: liveSource(fetchImpl),
      now: NOW,
    });
    try {
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'ethereum' },
      });
      expect(result.isError).not.toBe(true);
      const live = structured(result)['live'] as Record<string, unknown>;
      expect(live['targetsValid']).toBe(0);
      const kinds = new Map(
        (live['targets'] as Record<string, unknown>[]).map((t) => [
          (t['target'] as Record<string, unknown>)['configuredSlug'],
          (t['failure'] as Record<string, unknown>)['kind'],
        ]),
      );
      expect(kinds.get('aave-v3-ethereum')).toBe('http');
      expect(kinds.get('spark-lend-ethereum')).toBe('graphql');
      expect(kinds.get('makerdao-ethereum')).toBe('network');
      expect(kinds.get('compound-v3-ethereum')).toBe('timeout');
      expect(kinds.get('liquity-ethereum')).toBe('indexing');
      const text = textOf(result);
      expect(text).not.toContain('boom');
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('ignore previous');
      expect(text).not.toContain('<system>');
      expect(text).not.toContain(SECRET_API_KEY);
      expect(structured(result)['stored']).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('escapes and redacts provider-controlled identity fields', async () => {
    const fetchImpl = fakeFetch(async (target) =>
      jsonResponse({
        data: syntheticPayload(target, {
          protocols: [
            {
              ...(syntheticPayload(target)['protocols'] as Record<string, unknown>[])[0],
              name: `${HOSTILE.ansi} ${SECRET_API_KEY} ${HOSTILE.tag}`,
            },
          ],
        }),
      }),
    );
    const harness = await connectInMemory({
      store: new ForbiddenStore(),
      live: liveSource(fetchImpl),
      now: NOW,
    });
    try {
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'base' },
      });
      expect(result.isError).not.toBe(true);
      const text = textOf(result);
      expect(hasRawControl(text)).toBe(false);
      expect(text).not.toContain(SECRET_API_KEY);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('\\x1b[31m');
      expect(text).not.toContain('<system>');
    } finally {
      await harness.close();
    }
  });

  it('refuses a stored run in a live request and a chain in a stored one', async () => {
    const harness = await connectInMemory({
      store: new ForbiddenStore(),
      live: liveSource(fakeFetch(validResponder)),
      now: NOW,
    });
    try {
      const mixed = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: {
          mode: 'live',
          chain: 'base',
          signalRunId: '00000001-0000-4000-8000-000000000003',
        },
      });
      expect(mixed.isError).toBe(true);
      const other = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: {
          mode: 'stored',
          signalRunId: '00000001-0000-4000-8000-000000000003',
          chain: 'base',
        },
      });
      expect(other.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('has no fallback path in its source: the live module names no store, replay or fixture', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./engines/live-graph.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/store/i);
    expect(code).not.toMatch(/['"]replay['"]/);
    expect(code).not.toMatch(/['"]fixture['"]/);
    expect(code).not.toMatch(/readFile|fs\//);
  });
});
