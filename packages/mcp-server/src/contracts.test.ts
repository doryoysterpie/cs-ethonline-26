import { fromJsonSchema } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { advertisedInputSchema, JSON_SCHEMA_TARGET, toolCatalogue } from './definitions.js';
import { exactUtcInstant, ISO_INSTANT_PATTERN } from './schemas/common.js';
import {
  chainAnomaliesInput,
  chainAnomaliesLiveInput,
  chainAnomaliesStoredInput,
  draftSectionInput,
} from './schemas/input.js';
import { CallLimiter } from './runtime.js';
import { AS_OF, connectInMemory, FakeStore, uuidFrom } from './test-support.js';
import { validateArguments } from './validation.js';

/**
 * One accepted/rejected matrix, run through every validator that can see a
 * request: the runtime boundary (`validateArguments` over the Zod schema),
 * the SDK's own JSON Schema validator over the advertised `tools/list`
 * schema, Zod's JSON Schema reader over the same document, and the wire
 * itself. Every validator must agree with every other on every case.
 */

const RUN = uuidFrom(3, 1);

interface Case {
  readonly label: string;
  readonly args: Record<string, unknown>;
  readonly accepted: boolean;
}

const stored = (asOf: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'stored',
  signalRunId: RUN,
  asOf,
  ...extra,
});

/** Instants and the verdict each must receive. */
export const INSTANT_MATRIX: readonly (readonly [instant: string, accepted: boolean])[] = [
  // Leap and non-leap February.
  ['2024-02-29T00:00:00Z', true],
  ['2023-02-29T00:00:00Z', false],
  ['2000-02-29T00:00:00Z', true],
  ['1900-02-29T00:00:00Z', false],
  ['2100-02-29T00:00:00Z', false],
  ['2026-02-28T23:59:59Z', true],
  ['2026-02-30T00:00:00Z', false],
  // Thirty- and thirty-one-day months.
  ['2026-01-31T00:00:00Z', true],
  ['2026-04-30T00:00:00Z', true],
  ['2026-04-31T00:00:00Z', false],
  ['2026-06-31T00:00:00Z', false],
  ['2026-09-31T00:00:00Z', false],
  ['2026-11-31T00:00:00Z', false],
  ['2026-12-31T23:59:59.999Z', true],
  ['2026-13-01T00:00:00Z', false],
  ['2026-00-10T00:00:00Z', false],
  ['2026-09-00T00:00:00Z', false],
  ['2026-09-32T00:00:00Z', false],
  // Clock fields.
  ['2026-09-04T24:00:00Z', false],
  ['2026-09-04T23:60:00Z', false],
  ['2026-09-04T23:59:60Z', false],
  ['2026-09-04T23:59:59Z', true],
  ['2026-09-04T00:00:00Z', true],
  // Fraction forms.
  ['2026-09-04T09:11:23.1Z', true],
  ['2026-09-04T09:11:23.12Z', true],
  ['2026-09-04T09:11:23.123Z', true],
  ['2026-09-04T09:11:23.1234Z', false],
  ['2026-09-04T09:11:23.Z', false],
  ['2026-09-04T09:11:23,123Z', false],
  // The UTC suffix and separators.
  ['2026-09-04T09:11:23', false],
  ['2026-09-04T09:11:23+00:00', false],
  ['2026-09-04T09:11:23-00:00', false],
  ['2026-09-04T09:11:23UTC', false],
  ['2026-09-04t09:11:23z', false],
  ['2026-09-04 09:11:23Z', false],
  ['2026-9-4T09:11:23Z', false],
  ['20260904T091123Z', false],
  ['10000-01-01T00:00:00Z', false],
  ['0000-01-01T00:00:00Z', true],
  ['9999-12-31T23:59:59.999Z', true],
];

export const MODE_MATRIX: readonly Case[] = [
  { label: 'stored, complete', args: stored(AS_OF), accepted: true },
  {
    label: 'stored, uppercase id',
    args: stored(AS_OF, { signalRunId: RUN.toUpperCase() }),
    accepted: true,
  },
  { label: 'stored, no asOf', args: { mode: 'stored', signalRunId: RUN }, accepted: false },
  { label: 'stored, no signalRunId', args: { mode: 'stored', asOf: AS_OF }, accepted: false },
  { label: 'stored, only mode', args: { mode: 'stored' }, accepted: false },
  { label: 'stored, with chain', args: stored(AS_OF, { chain: 'base' }), accepted: false },
  {
    label: 'stored, malformed id',
    args: stored(AS_OF, { signalRunId: 'not-a-uuid' }),
    accepted: false,
  },
  { label: 'stored, unknown key', args: stored(AS_OF, { limit: 1 }), accepted: false },
  { label: 'live, complete', args: { mode: 'live', chain: 'base' }, accepted: true },
  { label: 'live, ethereum', args: { mode: 'live', chain: 'ethereum' }, accepted: true },
  { label: 'live, no chain', args: { mode: 'live' }, accepted: false },
  {
    label: 'live, with signalRunId',
    args: { mode: 'live', chain: 'base', signalRunId: RUN },
    accepted: false,
  },
  { label: 'live, with asOf', args: { mode: 'live', chain: 'base', asOf: AS_OF }, accepted: false },
  {
    label: 'live, with both',
    args: { mode: 'live', chain: 'base', signalRunId: RUN, asOf: AS_OF },
    accepted: false,
  },
  { label: 'live, unknown chain', args: { mode: 'live', chain: 'solana' }, accepted: false },
  { label: 'live, unknown key', args: { mode: 'live', chain: 'base', limit: 1 }, accepted: false },
  {
    label: 'mode replay',
    args: { mode: 'replay', signalRunId: RUN, asOf: AS_OF },
    accepted: false,
  },
  {
    label: 'mode uppercase',
    args: { mode: 'STORED', signalRunId: RUN, asOf: AS_OF },
    accepted: false,
  },
  { label: 'mode number', args: { mode: 1, chain: 'base' }, accepted: false },
  { label: 'no mode', args: { signalRunId: RUN, asOf: AS_OF }, accepted: false },
  { label: 'empty', args: {}, accepted: false },
  ...INSTANT_MATRIX.map(([instant, accepted]) => ({
    label: `stored, asOf ${instant}`,
    args: stored(instant),
    accepted,
  })),
];

type Verdicts = Record<string, boolean>;

function runtimeAccepts(schema: z.ZodType, args: unknown): boolean {
  try {
    validateArguments(schema, args);
    return true;
  } catch {
    return false;
  }
}

function sdkValidator(schema: Record<string, unknown>): (args: unknown) => boolean {
  const standard = fromJsonSchema(schema as Parameters<typeof fromJsonSchema>[0]);
  return (args) => {
    const result = standard['~standard'].validate(args);
    if (result instanceof Promise) throw new Error('the validator must be synchronous');
    return !('issues' in result);
  };
}

function zodReader(schema: Record<string, unknown>): (args: unknown) => boolean {
  const reader = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  return (args) => reader.safeParse(args).success;
}

function advertised(name: string): Record<string, unknown> {
  const entry = toolCatalogue().find((tool) => tool.name === name);
  if (entry === undefined) throw new Error(`no tool ${name}`);
  return entry.inputSchema;
}

describe('the advertised chain_anomalies schema', () => {
  it('is a root object whose oneOf branches are the two strict Zod alternatives', () => {
    const schema = advertised('chain_anomalies');
    expect(schema['type']).toBe('object');
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const branches = schema['oneOf'] as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    const strip = (json: Record<string, unknown>): Record<string, unknown> => {
      const rest = { ...json };
      delete rest['$schema'];
      return rest;
    };
    expect(branches[0]).toEqual(
      strip(z.toJSONSchema(chainAnomaliesStoredInput, { io: 'input', target: JSON_SCHEMA_TARGET })),
    );
    expect(branches[1]).toEqual(
      strip(z.toJSONSchema(chainAnomaliesLiveInput, { io: 'input', target: JSON_SCHEMA_TARGET })),
    );
    for (const branch of branches) {
      expect(branch['type']).toBe('object');
      expect(branch['additionalProperties']).toBe(false);
    }
    expect(branches[0]?.['required']).toEqual(['mode', 'signalRunId', 'asOf']);
    expect(branches[1]?.['required']).toEqual(['mode', 'chain']);
    const properties = (branch: number): Record<string, Record<string, unknown>> =>
      branches[branch]?.['properties'] as Record<string, Record<string, unknown>>;
    expect(properties(0)['mode']?.['const']).toBe('stored');
    expect(properties(1)['mode']?.['const']).toBe('live');
    expect(properties(0)['asOf']?.['pattern']).toBe(ISO_INSTANT_PATTERN.source);
    // The same document the SDK derives at registration.
    expect(advertisedInputSchema(chainAnomaliesInput)).toEqual(schema);
  });

  it('is what the wire serves', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const listed = await harness.client.listTools();
      const tool = listed.tools.find((entry) => entry.name === 'chain_anomalies');
      expect(tool?.inputSchema).toEqual(advertised('chain_anomalies'));
    } finally {
      await harness.close();
    }
  });
});

describe('the mode and instant matrix', () => {
  it('receives the same verdict from the runtime, the SDK validator, the Zod reader and the expectation', () => {
    const schema = advertised('chain_anomalies');
    const sdk = sdkValidator(schema);
    const reader = zodReader(schema);
    const disagreements: string[] = [];
    for (const entry of MODE_MATRIX) {
      const verdicts: Verdicts = {
        expected: entry.accepted,
        runtime: runtimeAccepts(chainAnomaliesInput, entry.args),
        sdk: sdk(entry.args),
        reader: reader(entry.args),
      };
      const distinct = new Set(Object.values(verdicts));
      if (distinct.size !== 1) disagreements.push(`${entry.label}: ${JSON.stringify(verdicts)}`);
    }
    expect(disagreements).toEqual([]);
    expect(MODE_MATRIX.length).toBeGreaterThan(50);
  });

  it('receives the same verdict from the wire', async () => {
    // One call per matrix entry, and the matrix is longer than the server's
    // sixty-per-ten-seconds window: the limiter under test here is the
    // argument boundary, not the rate limit, which has its own cases.
    const harness = await connectInMemory({
      store: new FakeStore(),
      limiter: new CallLimiter({ calls: 10_000, windowMs: 10_000, concurrent: 4 }),
    });
    try {
      for (const entry of MODE_MATRIX) {
        let accepted: boolean;
        try {
          const result = await harness.client.callTool({
            name: 'chain_anomalies',
            arguments: entry.args,
          });
          // A stored call that reaches the store succeeds against the fixture;
          // a live call fails with the credential code, which is past validation.
          const text = (result.content[0] as { text?: string }).text ?? '';
          accepted = result.isError !== true || text.includes('graph_credential_missing');
        } catch {
          accepted = false;
        }
        expect(accepted, entry.label).toBe(entry.accepted);
      }
    } finally {
      await harness.close();
    }
  });

  it('agrees with the calendar grammar of z.iso.datetime for every instant with at most three fraction digits', () => {
    const zodDatetime = z.iso.datetime();
    for (const [instant, accepted] of INSTANT_MATRIX) {
      const fractionDigits = /\.(\d+)Z$/.exec(instant)?.[1]?.length ?? 0;
      if (fractionDigits > 3) continue;
      expect(ISO_INSTANT_PATTERN.test(instant), instant).toBe(
        zodDatetime.safeParse(instant).success,
      );
      expect(ISO_INSTANT_PATTERN.test(instant), instant).toBe(accepted);
      // The round trip never contradicts the grammar; it is the second lock on the same door.
      expect(exactUtcInstant(instant), instant).toBe(accepted);
    }
  });

  it('refuses through the round trip what a normalizing parser would accept', () => {
    for (const impossible of [
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2023-02-29T00:00:00Z',
      '2026-09-04T24:00:00Z',
    ]) {
      expect(Number.isFinite(Date.parse(impossible)), impossible).toBe(true);
      expect(exactUtcInstant(impossible), impossible).toBe(false);
    }
  });
});

describe('the draft_section period', () => {
  const period = (start: string, end: string): Record<string, unknown> => ({
    evidenceRunId: uuidFrom(4, 1),
    section: 'header',
    periodStart: start,
    periodEnd: end,
  });

  it('holds both instants to the same grammar in the runtime and the advertised schema', () => {
    const schema = advertised('draft_section');
    const sdk = sdkValidator(schema);
    const reader = zodReader(schema);
    const disagreements: string[] = [];
    // The partner instant lies beyond every matrix entry, so ordering, which is
    // tested separately, never decides a verdict here.
    const LAST = '9999-12-31T23:59:59.999Z';
    const FIRST = '0000-01-01T00:00:00Z';
    for (const [instant, accepted] of INSTANT_MATRIX) {
      const variants: (readonly [Record<string, unknown>, string])[] = [];
      if (instant !== LAST) variants.push([period(instant, LAST), `start ${instant}`]);
      if (instant !== FIRST) variants.push([period(FIRST, instant), `end ${instant}`]);
      for (const [args, label] of variants) {
        const verdicts: Verdicts = {
          expected: accepted,
          runtime: runtimeAccepts(draftSectionInput, args),
          sdk: sdk(args),
          reader: reader(args),
        };
        if (new Set(Object.values(verdicts)).size !== 1) {
          disagreements.push(`${label}: ${JSON.stringify(verdicts)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('is ordered by the runtime alone, the one rule JSON Schema cannot state', () => {
    const schema = advertised('draft_section');
    const sdk = sdkValidator(schema);
    const reversed = period('2026-09-06T00:00:00Z', '2026-08-30T00:00:00Z');
    const equal = period('2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z');
    for (const args of [reversed, equal]) {
      expect(sdk(args)).toBe(true);
      expect(runtimeAccepts(draftSectionInput, args)).toBe(false);
    }
    const ordered = period('2026-08-30T00:00:00Z', '2026-09-06T00:00:00Z');
    expect(sdk(ordered)).toBe(true);
    expect(runtimeAccepts(draftSectionInput, ordered)).toBe(true);
    const description = (
      (schema['properties'] as Record<string, Record<string, unknown>>)['periodEnd'] as Record<
        string,
        unknown
      >
    )['description'];
    expect(String(description)).toContain('cannot be expressed in the advertised JSON Schema');
  });
});
