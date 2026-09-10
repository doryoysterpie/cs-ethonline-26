import { describe, expect, it } from 'vitest';

import { HEADLINE_MAX_CHARACTERS } from './bounds.js';
import { invokeTool } from './runtime.js';
import { createRedactor, REDACTED, secretVariants } from './safety/redact.js';
import { quoteEvidence } from './safety/text.js';
import {
  buildFixture,
  connectInMemory,
  FakeStore,
  fakeFetch,
  ForbiddenStore,
  jsonResponse,
  structured,
  syntheticPayload,
  T_NOW,
  testRuntime,
  textOf,
  uuidFrom,
} from './test-support.js';
import { GraphLiveSignalSource } from './engines/live-graph.js';

/**
 * Credential-form redaction (Track D finding F3): every form a configured
 * secret can take in stored or provider text is removed before any escape or
 * bound can alter it.
 */

const KEY = 'gk+ab/cd=ef%20 ünï€';
const PASSWORD = 'p+w/d=ok%25 ü';
const DATABASE_URL = `postgres://cas:${encodeURIComponent(PASSWORD)}@127.0.0.1:5432/db`;

function forms(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).toLowerCase(),
    encodeURI(secret),
    new URLSearchParams([['v', secret]]).toString().slice(2),
  ];
}

describe('secret variants', () => {
  it('cover raw, decoded, component, URI and form encodings in both escape cases', () => {
    const variants = secretVariants(KEY);
    for (const form of forms(KEY)) expect(variants, form).toContain(form);
    expect(variants).toContain(
      encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    );
    // The decoded form of an already-encoded secret is covered, once.
    const encoded = encodeURIComponent(KEY);
    expect(secretVariants(encoded)).toContain(KEY);
    expect(secretVariants(encoded)).toContain(encodeURIComponent(encoded));
    // Bounded: never more than twenty-six forms, and never a short one.
    expect(variants.length).toBeLessThanOrEqual(26);
    expect(secretVariants('abc')).toEqual([]);
    expect(secretVariants('%zz')).toEqual([]);
  });

  it('are removed wherever they occur, in every case', () => {
    const redact = createRedactor([KEY, DATABASE_URL, PASSWORD]);
    for (const form of [...forms(KEY), ...forms(PASSWORD), DATABASE_URL]) {
      const out = redact(`before ${form} after`);
      expect(out, form).not.toContain(form);
      expect(out).toContain(REDACTED);
    }
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('quoting redacts before escaping and bounding', () => {
  const redact = createRedactor([KEY]);

  it('matches a secret that an escape would otherwise alter', () => {
    const withControl = `${KEY.slice(0, 5)}${String.fromCodePoint(0x1b)}${KEY.slice(5)}`;
    const control = createRedactor([withControl]);
    const quoted = quoteEvidence(`x ${withControl} y`, HEADLINE_MAX_CHARACTERS, control);
    expect(quoted?.text).toBe(`x ${REDACTED} y`);
    const angled = createRedactor(['secret<tag>value']);
    expect(quoteEvidence('a secret<tag>value b', 100, angled)?.text).toBe(`a ${REDACTED} b`);
  });

  it('never splits a secret across the truncation boundary', () => {
    for (const offset of [-3, -1, 0, 1, 3]) {
      const prefix = 'a'.repeat(HEADLINE_MAX_CHARACTERS + offset - 2);
      const quoted = quoteEvidence(
        `${prefix}${encodeURIComponent(KEY)} tail`,
        HEADLINE_MAX_CHARACTERS,
        redact,
      );
      expect(quoted).not.toBeNull();
      for (const form of forms(KEY)) {
        expect(quoted?.text).not.toContain(form.slice(0, 6));
      }
      const marker = quoted?.text.includes(REDACTED) || quoted?.truncated;
      expect(marker).toBe(true);
    }
  });
});

describe('every output path', () => {
  const RUN = uuidFrom(4, 1);

  function hostileFixture(): ReturnType<typeof buildFixture> {
    const fixture = buildFixture();
    const first = fixture.incidents[0]!;
    const incidents = [
      {
        ...first,
        summary: {
          ...first.summary,
          headline: `k ${encodeURIComponent(KEY)} p ${forms(PASSWORD)[4]}`,
        },
        sources: [
          {
            ...first.sources[0]!,
            title: `t ${encodeURI(KEY)}`,
            publisher: `pub ${encodeURIComponent(PASSWORD).toLowerCase()}`,
            url: `https://seed.example/x?key=${encodeURIComponent(KEY)}&pw=${PASSWORD}`,
          },
        ],
      },
      ...fixture.incidents.slice(1),
    ];
    return { ...fixture, incidents };
  }

  it('redacts every form in stored text across list, explain and draft', async () => {
    const harness = await connectInMemory({
      store: new FakeStore(hostileFixture()),
      env: { DATABASE_URL, GRAPH_API_KEY: KEY },
    });
    try {
      const outputs = await Promise.all([
        harness.client.callTool({ name: 'list_incidents', arguments: { evidenceRunId: RUN } }),
        harness.client.callTool({
          name: 'explain_incident',
          arguments: { evidenceRunId: RUN, incidentId: uuidFrom(10, 2) },
        }),
        harness.client.callTool({
          name: 'draft_section',
          arguments: {
            evidenceRunId: RUN,
            section: 'crypto',
            periodStart: '2026-08-30T00:00:00Z',
            periodEnd: '2026-09-06T00:00:00Z',
          },
        }),
      ]);
      for (const output of outputs) {
        expect(output.isError).not.toBe(true);
        const text = textOf(output) + JSON.stringify(structured(output));
        for (const form of [...forms(KEY), ...forms(PASSWORD)]) {
          expect(text, form).not.toContain(form.slice(0, 8));
        }
        expect(text).toContain(REDACTED);
      }
      for (const line of harness.logs) {
        for (const form of [...forms(KEY), ...forms(PASSWORD)])
          expect(line).not.toContain(form.slice(0, 8));
      }
    } finally {
      await harness.close();
    }
  });

  it('redacts every form in provider identity and deployment fields', async () => {
    const fetchImpl = fakeFetch(async (target) =>
      jsonResponse({
        data: syntheticPayload(target, {
          _meta: {
            block: { number: 1, hash: encodeURIComponent(KEY), timestamp: T_NOW },
            deployment: encodeURI(KEY),
            hasIndexingErrors: false,
          },
          protocols: [
            {
              ...(syntheticPayload(target)['protocols'] as Record<string, unknown>[])[0],
              name: `n ${encodeURIComponent(KEY).toLowerCase()} ${forms(KEY)[4]}`,
              subgraphVersion: encodeURIComponent(KEY),
            },
          ],
        }),
      }),
    );
    const live = new GraphLiveSignalSource({
      apiKey: KEY,
      fetchImpl,
      now: () => new Date(T_NOW * 1000),
    });
    const harness = await connectInMemory({
      store: new ForbiddenStore(),
      live,
      env: { GRAPH_API_KEY: KEY },
      now: () => new Date(T_NOW * 1000),
    });
    try {
      const output = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'base' },
      });
      expect(output.isError).not.toBe(true);
      const text = textOf(output) + JSON.stringify(structured(output));
      for (const form of forms(KEY)) expect(text, form).not.toContain(form.slice(0, 8));
      expect(text).toContain(REDACTED);
    } finally {
      await harness.close();
    }
  });

  it('redacts every form in error text and stderr records', async () => {
    const { runtime, logs } = testRuntime({
      store: new FakeStore(),
      env: { DATABASE_URL, GRAPH_API_KEY: KEY },
    });
    runtime.log(`probe ${encodeURIComponent(KEY)} ${forms(PASSWORD)[4]} ${DATABASE_URL}`);
    expect(logs[0]).not.toContain(encodeURIComponent(KEY).slice(0, 8));
    expect(logs[0]).not.toContain('postgres://');
    expect(logs[0]).not.toContain(PASSWORD.slice(0, 6));
    const outcome = await invokeTool(runtime, 'list_incidents', { evidenceRunId: 'nope' });
    expect(outcome.ok).toBe(false);
    for (const form of [...forms(KEY), ...forms(PASSWORD)]) {
      expect(runtime.redact(`err ${form} end`)).toBe(`err ${REDACTED} end`);
    }
  });
});
