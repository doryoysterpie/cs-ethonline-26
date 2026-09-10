import { describe, expect, it } from 'vitest';

import { ANOMALY_BOUNDARY_SENTENCE, RESULT_NOTICE, TELEMETRY_SENTENCE } from './schemas/common.js';
import {
  AS_OF,
  connectInMemory,
  FakeStore,
  FIXTURE_RUN_COMPLETED_AT,
  hasRawControl,
  HOSTILE,
  SECRET_API_KEY,
  SECRET_DATABASE_URL,
  SECRET_PASSWORD,
  structured,
  textOf,
  uuidFrom,
} from './test-support.js';

/**
 * The four tools over the in-memory MCP transport against the fake store.
 * Every hostile string the fixture carries must come back as escaped quoted
 * evidence, and no field a tool controls may be moved by it.
 */

const RUN = uuidFrom(4, 1);
const FOREIGN_RUN = uuidFrom(5, 1);
const INCOMPLETE_RUN = uuidFrom(8, 1);
const INCIDENT_0 = uuidFrom(10, 2);
const FOREIGN_INCIDENT = uuidFrom(90, 2);
const SIGNAL_RUN = uuidFrom(3, 1);

function withSecrets(): { env: Record<string, string> } {
  return { env: { DATABASE_URL: SECRET_DATABASE_URL, GRAPH_API_KEY: SECRET_API_KEY } };
}

async function errorCode(result: {
  content: readonly unknown[];
  isError?: boolean | undefined;
}): Promise<string> {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(textOf(result)) as { error: { code: string } };
  return parsed.error.code;
}

describe('list_incidents', () => {
  it('pages an evidence run with a keyset cursor, labelling origin and provenance', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      const first = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN, limit: 2 },
      });
      expect(first.isError).not.toBe(true);
      const page = structured(first);
      expect(page['notice']).toBe(RESULT_NOTICE);
      const run = page['run'] as Record<string, unknown>;
      expect(run['evidenceRunId']).toBe(RUN);
      expect(run['dataOrigin']).toBe('replay');
      expect(run['contractHash']).toBe('ab'.repeat(32));
      const incidents = page['incidents'] as Record<string, unknown>[];
      expect(incidents).toHaveLength(2);
      expect((page['page'] as Record<string, unknown>)['nextCursor']).toBe(
        incidents[1]?.['incidentId'],
      );

      const second = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN, limit: 2, afterIncidentId: incidents[1]?.['incidentId'] },
      });
      const next = structured(second)['incidents'] as Record<string, unknown>[];
      expect(next.map((i) => i['incidentId'])).not.toContain(incidents[0]?.['incidentId']);

      const last = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN, limit: 50 },
      });
      const all = structured(last);
      expect((all['incidents'] as unknown[]).length).toBe(5);
      expect((all['page'] as Record<string, unknown>)['nextCursor']).toBeNull();
      for (const incident of all['incidents'] as Record<string, unknown>[]) {
        expect(incident['dataOrigin']).toBe('replay');
        const evidence = incident['evidence'] as Record<string, unknown>;
        expect(typeof evidence['sentence']).toBe('string');
      }
    } finally {
      await harness.close();
    }
  });

  it('accepts an uppercase identifier and names the same run', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const result = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN.toUpperCase() },
      });
      expect(result.isError).not.toBe(true);
      expect((structured(result)['run'] as Record<string, unknown>)['evidenceRunId']).toBe(RUN);
    } finally {
      await harness.close();
    }
  });

  it('refuses an unknown, an incomplete and a badly formed run without touching more of the store', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'list_incidents',
            arguments: { evidenceRunId: uuidFrom(999, 1) },
          }),
        ),
      ).toBe('evidence_run_not_found');
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'list_incidents',
            arguments: { evidenceRunId: INCOMPLETE_RUN },
          }),
        ),
      ).toBe('evidence_run_not_completed');
      expect(store.calls).toEqual(['getEvidenceRun', 'getEvidenceRun']);
      const malformed = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: '../../etc/passwd' },
      });
      expect(malformed.isError).toBe(true);
      expect(textOf(malformed)).not.toContain('passwd');
      const unexpected = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN, sql: 'DROP TABLE source_rows' },
      });
      expect(unexpected.isError).toBe(true);
      expect(textOf(unexpected)).not.toContain('DROP');
      expect(store.calls).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('fails with a fixed code when no database is configured', async () => {
    const harness = await connectInMemory({ store: null });
    try {
      const result = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN },
      });
      expect(await errorCode(result)).toBe('database_not_configured');
    } finally {
      await harness.close();
    }
  });
});

describe('output safety', () => {
  it('renders every hostile headline as escaped quoted evidence and moves no controlled field', async () => {
    const harness = await connectInMemory({ store: new FakeStore(), ...withSecrets() });
    try {
      const result = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN },
      });
      const text = textOf(result);
      const page = structured(result);
      expect(hasRawControl(text)).toBe(false);
      expect(text).not.toContain('<system>');
      expect(text).not.toContain('<IMPORTANT>');
      // JSON doubles the backslash of the visible escape; the field itself holds one.
      expect(text).toContain('\\\\u003csystem\\\\u003e');
      expect(text).not.toContain(SECRET_PASSWORD);
      expect(text).not.toContain(SECRET_API_KEY);
      expect(text).toContain('[REDACTED]');
      const incidents = page['incidents'] as Record<string, unknown>[];
      const forged = incidents.find((i) => i['incidentId'] === uuidFrom(12, 2));
      const headline = forged?.['headline'] as Record<string, unknown>;
      expect(headline['trust']).toBe('untrusted_quoted_evidence');
      expect(headline['text']).toContain('"evidenceState":"corroborated"');
      // The forgery stayed inside its quoted field: the real state is what the store holds.
      expect((forged?.['evidence'] as Record<string, unknown>)['state']).toBe('reported_only');
      expect(result.isError).not.toBe(true);
      const ansi = incidents.find((i) => i['incidentId'] === uuidFrom(13, 2));
      expect((ansi?.['headline'] as Record<string, unknown>)['text']).toContain('\\x1b[31m');
    } finally {
      await harness.close();
    }
  });

  it('never carries an environment value, a stack trace or a driver message', async () => {
    const env = {
      DATABASE_URL: SECRET_DATABASE_URL,
      GRAPH_API_KEY: SECRET_API_KEY,
      HOME: '/Users/nobody-home-marker',
      PATH: '/opt/path-marker',
      AWS_SECRET_ACCESS_KEY: 'aws-marker-value',
    };
    const harness = await connectInMemory({ store: new FakeStore(), env });
    try {
      for (const [name, args] of [
        ['list_incidents', { evidenceRunId: RUN }],
        ['explain_incident', { evidenceRunId: RUN, incidentId: INCIDENT_0 }],
        ['chain_anomalies', { mode: 'stored', signalRunId: SIGNAL_RUN, asOf: AS_OF }],
        ['chain_anomalies', { mode: 'live', chain: 'base' }],
        ['list_incidents', { evidenceRunId: 'broken' }],
      ] as const) {
        const result = await harness.client.callTool({ name, arguments: args });
        const text = textOf(result);
        for (const marker of [
          'home-marker',
          'path-marker',
          'aws-marker',
          SECRET_PASSWORD,
          SECRET_API_KEY,
          '    at ',
          'node_modules',
        ]) {
          expect(text, `${name} must not carry ${marker}`).not.toContain(marker);
        }
      }
      for (const line of harness.logs) {
        expect(line).not.toContain(SECRET_PASSWORD);
        expect(line).not.toContain(SECRET_API_KEY);
        expect(hasRawControl(line)).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });
});

describe('explain_incident', () => {
  it('returns sources as quoted evidence and keeps the machine suggestion apart from the human decision', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const result = await harness.client.callTool({
        name: 'explain_incident',
        arguments: { evidenceRunId: RUN, incidentId: INCIDENT_0 },
      });
      expect(result.isError).not.toBe(true);
      const explained = structured(result);
      expect(explained['telemetrySentence']).toBe(TELEMETRY_SENTENCE);
      const incident = explained['incident'] as Record<string, unknown>;
      expect((incident['evidence'] as Record<string, unknown>)['state']).toBe('corroborated');
      expect((incident['subject'] as Record<string, unknown>)['recorded']).toBe(true);
      const sources = explained['sources'] as Record<string, unknown>[];
      expect(sources).toHaveLength(2);
      const publisher = sources[0]?.['publisher'] as Record<string, unknown>;
      expect(publisher['text']).toContain('\\u2028');
      expect(sources[1]?.['publisher']).toBeNull();
      expect(sources[1]?.['url']).toBeNull();
      const url = sources[0]?.['url'] as Record<string, unknown>;
      expect(url['text']).toContain('\\n');
      const associations = explained['associations'] as Record<string, unknown>[];
      expect(associations).toHaveLength(1);
      const association = associations[0] as Record<string, unknown>;
      expect(association['machineSuggestion']).toEqual({
        relation: 'context',
        status: 'suggested',
        claimId: null,
      });
      expect(association['effective']).toEqual({
        relation: 'supports',
        status: 'accepted',
        claimId: uuidFrom(100, 3),
        decidedByHuman: true,
      });
      // No actor, note or rationale is present anywhere in the result.
      for (const key of ['actor', 'rationale', 'note', 'rawCells', 'derivedSummaryText']) {
        expect(textOf(result)).not.toContain(`"${key}"`);
      }
    } finally {
      await harness.close();
    }
  });

  it('refuses an incident of another run and an unknown incident', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'explain_incident',
            arguments: { evidenceRunId: FOREIGN_RUN, incidentId: INCIDENT_0 },
          }),
        ),
      ).toBe('incident_not_found');
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'explain_incident',
            arguments: { evidenceRunId: RUN, incidentId: FOREIGN_INCIDENT },
          }),
        ),
      ).toBe('incident_not_found');
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'explain_incident',
            arguments: { evidenceRunId: RUN, incidentId: uuidFrom(4242, 2) },
          }),
        ),
      ).toBe('incident_not_found');
    } finally {
      await harness.close();
    }
  });
});

describe('chain_anomalies in stored mode', () => {
  it('labels a named completed run against the history of its own origin only', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'stored', signalRunId: SIGNAL_RUN, asOf: AS_OF },
      });
      expect(result.isError).not.toBe(true);
      const output = structured(result);
      expect(output['mode']).toBe('stored');
      expect(output['live']).toBeNull();
      expect(output['telemetrySentence']).toBe(TELEMETRY_SENTENCE);
      const stored = output['stored'] as Record<string, unknown>;
      expect((stored['signalRun'] as Record<string, unknown>)['gatewayHost']).toBe(
        'gateway.fixture.example',
      );
      const entries = stored['entries'] as Record<string, unknown>[];
      const byTarget = new Map(
        entries.map((e) => [`${e['chain']}:${e['protocolSlug']}`, e['label']]),
      );
      expect(byTarget.get('ethereum:aave-v3')).toBe('normal');
      expect(byTarget.get('ethereum:spark-lend')).toBe('positive_spike');
      expect(byTarget.get('ethereum:compound-v3')).toBe('negative_spike');
      expect(byTarget.get('ethereum:liquity')).toBe('insufficient_history');
      expect(byTarget.get('base:moonwell')).toBe('stale_observation');
      expect(byTarget.get('base:seamless-protocol')).toBe('normal');
      for (const entry of entries) {
        expect(entry['dataOrigin']).toBe('replay');
        expect(entry['provenanceId']).toBe(SIGNAL_RUN);
        expect(typeof entry['evidenceLimitation']).toBe('string');
        const provenance = entry['provenance'] as Record<string, unknown>;
        expect(provenance['latestSignalRunId']).toBe(SIGNAL_RUN);
        expect(typeof provenance['latestSignalId']).toBe('string');
        expect(provenance['observationsUsed']).toBeGreaterThan(0);
        expect(provenance['contributingRunCount']).toBe(1);
      }
      // The boundary is the named run's own completion instant and the as-of instant.
      const boundary = stored['boundary'] as Record<string, unknown>;
      expect(boundary['requestedSignalRunId']).toBe(SIGNAL_RUN);
      expect(boundary['completedAt']).toBe(FIXTURE_RUN_COMPLETED_AT);
      expect(boundary['asOf']).toBe(new Date(AS_OF).toISOString());
      expect(boundary['rule']).toBe(ANOMALY_BOUNDARY_SENTENCE);
      expect(boundary['contributingRunCount']).toBe(1);
      expect(boundary['latestContributingRunCompletedAt']).toBe(FIXTURE_RUN_COMPLETED_AT);
      // The live series of aave-v3 (a 99.9% move) was never read.
      expect(store.calls.filter((c) => c.startsWith('listSignalHistory:'))).toEqual(
        Array(6).fill('listSignalHistory:replay'),
      );
    } finally {
      await harness.close();
    }
  });

  it('evaluates nothing observed after the as-of instant', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      // Two days before the fixture's as-of instant: the newest observation of
      // every target lies in the future of this request and must not be read.
      const earlier = new Date(Date.parse(AS_OF) - 2 * 86_400_000).toISOString();
      const result = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'stored', signalRunId: SIGNAL_RUN, asOf: earlier },
      });
      expect(result.isError).not.toBe(true);
      const stored = structured(result)['stored'] as Record<string, unknown>;
      const entries = stored['entries'] as Record<string, unknown>[];
      const spark = entries.find((e) => e['protocolSlug'] === 'spark-lend');
      // The 31.5% move happened after the as-of instant, so it is not a spike here.
      expect(spark?.['label']).toBe('normal');
      expect((spark?.['provenance'] as Record<string, unknown>)['observationsUsed']).toBe(10);
      expect(
        Date.parse((spark?.['provenance'] as Record<string, string>)['latestObservedAt'] ?? ''),
      ).toBeLessThanOrEqual(Date.parse(earlier));
    } finally {
      await harness.close();
    }
  });

  it('refuses an unknown or incomplete signal run and needs a database', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'chain_anomalies',
            arguments: { mode: 'stored', signalRunId: uuidFrom(9, 1) },
          }),
        ),
      ).toBe('signal_run_not_completed');
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'chain_anomalies',
            arguments: { mode: 'stored', signalRunId: uuidFrom(777, 1) },
          }),
        ),
      ).toBe('signal_run_not_found');
    } finally {
      await harness.close();
    }
    const bare = await connectInMemory({ store: null });
    try {
      expect(
        await errorCode(
          await bare.client.callTool({
            name: 'chain_anomalies',
            arguments: { mode: 'stored', signalRunId: SIGNAL_RUN },
          }),
        ),
      ).toBe('database_not_configured');
    } finally {
      await bare.close();
    }
  });

  it('is repeatable: the same request yields the same result and no store method mutates', async () => {
    const store = new FakeStore();
    const harness = await connectInMemory({ store });
    try {
      const a = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'stored', signalRunId: SIGNAL_RUN, asOf: AS_OF },
      });
      const b = await harness.client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'stored', signalRunId: SIGNAL_RUN, asOf: AS_OF },
      });
      expect(textOf(a)).toBe(textOf(b));
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object);
      expect(methods.some((m) => /insert|update|delete|write|set/i.test(m))).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe('draft_section', () => {
  it('previews each section deterministically, escaped, unpublished and model-free', async () => {
    const harness = await connectInMemory({ store: new FakeStore(), ...withSecrets() });
    try {
      const period = { periodStart: '2026-08-30T00:00:00Z', periodEnd: '2026-09-06T00:00:00Z' };
      const seen = new Map<string, string>();
      for (const section of ['header', 'incidents', 'crypto', 'provenance'] as const) {
        const result = await harness.client.callTool({
          name: 'draft_section',
          arguments: { evidenceRunId: RUN, section, ...period },
        });
        expect(result.isError).not.toBe(true);
        const output = structured(result);
        const preview = output['preview'] as Record<string, unknown>;
        expect(preview['status']).toBe('unpublished_requires_human_review');
        expect(preview['persisted']).toBe(false);
        expect(preview['modelInvoked']).toBe(false);
        expect(output['dataOrigin']).toBe('replay');
        // Nothing the fixture holds was left out, and the result says so.
        expect(output['bounds']).toEqual({
          sourcesPerIncidentLimit: 20,
          sourcesConsidered: 6,
          sourcesOmitted: 0,
          incidentsWithOmittedSources: 0,
          text: expect.objectContaining({ fieldsTruncated: 0 }) as unknown,
        });
        const markdown = preview['markdown'] as string;
        expect(hasRawControl(markdown.replace(/\n/g, ''))).toBe(false);
        expect(markdown).not.toContain('<system>');
        expect(markdown).not.toContain(SECRET_PASSWORD);
        seen.set(section, markdown);
        const again = await harness.client.callTool({
          name: 'draft_section',
          arguments: { evidenceRunId: RUN, section, ...period },
        });
        expect(textOf(again)).toBe(textOf(result));
      }
      expect(seen.get('header')).toContain('unpublished');
      expect(seen.get('header')).toContain('no model was');
      expect(seen.get('crypto')).toContain('## Crypto and Web3');
      // The two incidents with a recorded subject render in the crypto section.
      expect(seen.get('crypto')).toContain('\\u003csystem\\u003e');
      expect(seen.get('crypto')).toContain(HOSTILE.instruction.slice(0, 20));
      expect(seen.get('incidents')).toContain('\\x1b[31m');
      expect(seen.get('incidents')).toContain('[REDACTED]');
      expect(seen.get('provenance')).toContain('## Provenance');
    } finally {
      await harness.close();
    }
  });

  it('refuses a reversed period and an incomplete run', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const reversed = await harness.client.callTool({
        name: 'draft_section',
        arguments: {
          evidenceRunId: RUN,
          section: 'header',
          periodStart: '2026-09-06T00:00:00Z',
          periodEnd: '2026-08-30T00:00:00Z',
        },
      });
      expect(reversed.isError).toBe(true);
      expect(
        await errorCode(
          await harness.client.callTool({
            name: 'draft_section',
            arguments: {
              evidenceRunId: INCOMPLETE_RUN,
              section: 'header',
              periodStart: '2026-08-30T00:00:00Z',
              periodEnd: '2026-09-06T00:00:00Z',
            },
          }),
        ),
      ).toBe('evidence_run_not_completed');
    } finally {
      await harness.close();
    }
  });
});
