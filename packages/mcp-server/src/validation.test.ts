import { describe, expect, it } from 'vitest';

import { ARGUMENT_STRING_MAX_CHARACTERS } from './bounds.js';
import { ToolError } from './safety/errors.js';
import {
  chainAnomaliesInput,
  draftSectionInput,
  explainIncidentInput,
  listIncidentsInput,
} from './schemas/input.js';
import { AS_OF, HOSTILE, uuidFrom } from './test-support.js';
import { ARGUMENT_REJECTIONS, allowedArgumentNames, validateArguments } from './validation.js';

/**
 * The hardened argument boundary. Every rejection is checked for its reason
 * code and for the absence of the offending value from the error.
 */

const RUN = uuidFrom(4, 1);
const INCIDENT = uuidFrom(10, 2);

function rejection(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function serialized(error: ToolError): string {
  return JSON.stringify({ message: error.message, code: error.code, details: error.details });
}

describe('the argument allowlists', () => {
  it('are read from the schemas, including the refined ones and the union of both anomaly modes', () => {
    expect([...allowedArgumentNames(listIncidentsInput)]).toEqual([
      'evidenceRunId',
      'afterIncidentId',
      'limit',
    ]);
    expect([...allowedArgumentNames(explainIncidentInput)]).toEqual([
      'evidenceRunId',
      'incidentId',
    ]);
    expect([...allowedArgumentNames(chainAnomaliesInput)]).toEqual([
      'mode',
      'signalRunId',
      'asOf',
      'chain',
    ]);
    expect([...allowedArgumentNames(draftSectionInput)]).toEqual([
      'evidenceRunId',
      'section',
      'periodStart',
      'periodEnd',
      'maximumIncidents',
    ]);
  });
});

describe('the hardened boundary', () => {
  it('accepts a plain object and a null-prototype object, applying defaults and lowercasing nothing', () => {
    expect(validateArguments(listIncidentsInput, { evidenceRunId: RUN })).toEqual({
      evidenceRunId: RUN,
      limit: 20,
    });
    const bare = Object.create(null) as Record<string, unknown>;
    bare['evidenceRunId'] = RUN;
    bare['limit'] = 5;
    expect(validateArguments(listIncidentsInput, bare)).toEqual({ evidenceRunId: RUN, limit: 5 });
  });

  it('refuses anything that is not a plain object', () => {
    for (const value of [null, undefined, 'x', 42, [], [RUN], () => undefined, new Date()]) {
      const error = rejection(() => validateArguments(listIncidentsInput, value));
      expect(error.code).toBe('invalid_arguments');
      expect([ARGUMENT_REJECTIONS.notPlainObject, ARGUMENT_REJECTIONS.prototypeNotPlain]).toContain(
        error.details['reason'],
      );
    }
  });

  it('refuses a foreign prototype', () => {
    class Arguments {
      evidenceRunId = RUN;
    }
    const error = rejection(() => validateArguments(listIncidentsInput, new Arguments()));
    expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.prototypeNotPlain);
    const inherited = Object.create({ evidenceRunId: RUN }) as object;
    expect(
      rejection(() => validateArguments(listIncidentsInput, inherited)).details['reason'],
    ).toBe(ARGUMENT_REJECTIONS.prototypeNotPlain);
  });

  it('refuses a symbol key', () => {
    const value = { evidenceRunId: RUN, [Symbol('hidden')]: 1 };
    expect(rejection(() => validateArguments(listIncidentsInput, value)).details['reason']).toBe(
      ARGUMENT_REJECTIONS.symbolKey,
    );
  });

  it('refuses an unexpected key, an own __proto__ key and a non-enumerable key', () => {
    const extra = rejection(() =>
      validateArguments(listIncidentsInput, { evidenceRunId: RUN, sql: 'DROP TABLE x' }),
    );
    expect(extra.details['reason']).toBe(ARGUMENT_REJECTIONS.unexpectedKey);
    expect(serialized(extra)).not.toContain('DROP');
    expect(serialized(extra)).not.toContain('sql');

    const proto = JSON.parse(`{"evidenceRunId":"${RUN}","__proto__":{"polluted":true}}`) as object;
    expect(rejection(() => validateArguments(listIncidentsInput, proto)).details['reason']).toBe(
      ARGUMENT_REJECTIONS.unexpectedKey,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const hidden: Record<string, unknown> = { evidenceRunId: RUN };
    Object.defineProperty(hidden, 'limit_override', { value: 1000, enumerable: false });
    expect(rejection(() => validateArguments(listIncidentsInput, hidden)).details['reason']).toBe(
      ARGUMENT_REJECTIONS.unexpectedKey,
    );
  });

  it('refuses an accessor before it can run', () => {
    let invoked = 0;
    const trap: Record<string, unknown> = {};
    Object.defineProperty(trap, 'evidenceRunId', {
      enumerable: true,
      get: () => {
        invoked += 1;
        return RUN;
      },
    });
    const error = rejection(() => validateArguments(listIncidentsInput, trap));
    expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.accessorProperty);
    expect(invoked).toBe(0);
  });

  it('refuses nested objects and arrays', () => {
    for (const value of [{ id: RUN }, [RUN], new Map()]) {
      const error = rejection(() =>
        validateArguments(listIncidentsInput, { evidenceRunId: value as unknown }),
      );
      expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.nonPrimitiveValue);
    }
  });

  it('refuses oversized strings and control, separator and bidirectional characters before the schema sees them', () => {
    const long = rejection(() =>
      validateArguments(listIncidentsInput, {
        evidenceRunId: 'a'.repeat(ARGUMENT_STRING_MAX_CHARACTERS + 1),
      }),
    );
    expect(long.details['reason']).toBe(ARGUMENT_REJECTIONS.stringTooLong);
    for (const hostile of [
      HOSTILE.ansi,
      HOSTILE.newline,
      HOSTILE.separator,
      HOSTILE.nul,
      HOSTILE.bidi,
    ]) {
      const error = rejection(() =>
        validateArguments(listIncidentsInput, { evidenceRunId: hostile }),
      );
      expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.controlCharacter);
      expect(serialized(error)).not.toContain('FAKE');
      expect(serialized(error)).not.toContain('evil');
    }
  });

  it('refuses malformed identifiers, traversal strings and query-looking values without echoing them', () => {
    for (const bad of [
      '../../etc/passwd',
      '..%2f..%2fetc',
      "' OR 1=1 --",
      'SELECT * FROM source_rows',
      'https://evil.example/x',
      RUN.slice(0, 35),
      `${RUN}0`,
      RUN.replace('-', ''),
      RUN.replace('4', 'g'),
      '00000000000000000000000000000000',
      '{00000000-0000-4000-8000-000000000001}',
    ]) {
      const error = rejection(() => validateArguments(listIncidentsInput, { evidenceRunId: bad }));
      expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.schemaViolation);
      expect(error.details['argument']).toBe('evidenceRunId');
      expect(serialized(error)).not.toContain(bad.slice(0, 8));
    }
  });

  it('accepts an uppercase identifier and leaves case handling to the tool', () => {
    expect(
      validateArguments(explainIncidentInput, {
        evidenceRunId: RUN.toUpperCase(),
        incidentId: INCIDENT,
      }),
    ).toEqual({ evidenceRunId: RUN.toUpperCase(), incidentId: INCIDENT });
  });

  it('bounds the page size and refuses non-integers and numeric strings', () => {
    for (const limit of [0, 51, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', true]) {
      const error = rejection(() =>
        validateArguments(listIncidentsInput, { evidenceRunId: RUN, limit }),
      );
      expect(error.details['reason']).toBe(ARGUMENT_REJECTIONS.schemaViolation);
      expect(error.details['argument']).toBe('limit');
    }
    expect(validateArguments(listIncidentsInput, { evidenceRunId: RUN, limit: 50 }).limit).toBe(50);
  });

  it('enforces the mode alternatives of chain_anomalies, naming the argument at fault', () => {
    const stored = validateArguments(chainAnomaliesInput, {
      mode: 'stored',
      signalRunId: RUN,
      asOf: AS_OF,
    });
    expect(stored).toEqual({ mode: 'stored', signalRunId: RUN, asOf: AS_OF });
    const live = validateArguments(chainAnomaliesInput, { mode: 'live', chain: 'base' });
    expect(live).toEqual({ mode: 'live', chain: 'base' });

    const cases: [Record<string, unknown>, string][] = [
      [{ mode: 'stored', signalRunId: RUN }, 'asOf'],
      [{ mode: 'stored', asOf: AS_OF }, 'signalRunId'],
      [{ mode: 'stored' }, 'signalRunId'],
      [{ mode: 'stored', signalRunId: RUN, asOf: AS_OF, chain: 'base' }, 'chain'],
      [{ mode: 'live' }, 'chain'],
      [{ mode: 'live', chain: 'base', signalRunId: RUN }, 'signalRunId'],
      [{ mode: 'live', chain: 'base', asOf: AS_OF }, 'asOf'],
      [{ mode: 'replay', signalRunId: RUN, asOf: AS_OF }, 'mode'],
      [{ signalRunId: RUN, asOf: AS_OF }, 'mode'],
      [{ mode: 'live', chain: 'solana' }, 'chain'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-09-04 09:11:23' }, 'asOf'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-13-40T09:11:23Z' }, 'asOf'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-02-30T00:00:00Z' }, 'asOf'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-04-31T00:00:00Z' }, 'asOf'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-09-04T09:11:23' }, 'asOf'],
      [{ mode: 'stored', signalRunId: RUN, asOf: '2026-09-04T09:11:23.1234Z' }, 'asOf'],
    ];
    for (const [args, argument] of cases) {
      const error = rejection(() => validateArguments(chainAnomaliesInput, args));
      expect(error.details['reason'], JSON.stringify(args)).toBe(
        ARGUMENT_REJECTIONS.schemaViolation,
      );
      expect(error.details['argument'], JSON.stringify(args)).toBe(argument);
      expect(serialized(error)).not.toContain('solana');
      expect(serialized(error)).not.toContain('2026-');
    }
  });

  it('enforces an explicit, ordered, exact period and a bounded incident count for draft_section', () => {
    const good = validateArguments(draftSectionInput, {
      evidenceRunId: RUN,
      section: 'crypto',
      periodStart: '2026-08-09T00:00:00Z',
      periodEnd: '2026-08-16T00:00:00Z',
    });
    expect(good.maximumIncidents).toBe(25);
    const reversed = rejection(() =>
      validateArguments(draftSectionInput, {
        evidenceRunId: RUN,
        section: 'crypto',
        periodStart: '2026-08-16T00:00:00Z',
        periodEnd: '2026-08-09T00:00:00Z',
      }),
    );
    expect(reversed.details['argument']).toBe('periodEnd');
    expect(reversed.details['rule']).toBe('must be after periodStart');
    const impossible = rejection(() =>
      validateArguments(draftSectionInput, {
        evidenceRunId: RUN,
        section: 'crypto',
        periodStart: '2026-02-30T00:00:00Z',
        periodEnd: '2026-03-16T00:00:00Z',
      }),
    );
    expect(impossible.details['argument']).toBe('periodStart');
    const section = rejection(() =>
      validateArguments(draftSectionInput, {
        evidenceRunId: RUN,
        section: 'footer',
        periodStart: '2026-08-09T00:00:00Z',
        periodEnd: '2026-08-16T00:00:00Z',
      }),
    );
    expect(section.details['argument']).toBe('section');
    const count = rejection(() =>
      validateArguments(draftSectionInput, {
        evidenceRunId: RUN,
        section: 'header',
        periodStart: '2026-08-09T00:00:00Z',
        periodEnd: '2026-08-16T00:00:00Z',
        maximumIncidents: 101,
      }),
    );
    expect(count.details['argument']).toBe('maximumIncidents');
  });

  it('carries fixed messages only', () => {
    const error = rejection(() => validateArguments(listIncidentsInput, { evidenceRunId: 'nope' }));
    expect(error.message).toBe('the arguments were rejected');
    expect(Object.keys(error.details).sort()).toEqual(['argument', 'problem', 'reason']);
  });
});
