import { describe, expect, it } from 'vitest';

import { hasProhibitedText } from '@cas/contracts';

import { quoteEvidence } from './safety/text.js';
import {
  connectInMemory,
  deepHasRawControl,
  FakeStore,
  hasRawControl,
  structured,
  textOf,
  uuidFrom,
} from './test-support.js';

/**
 * The display escape and JSON's escaping stack (D50, point 3, as amended on 1
 * November 2026). The display escape is applied to content before
 * serialisation, for whoever reads the decoded string; JSON's own escaping
 * serves its parser and covers only the quotation mark, the backslash and
 * U+0000 to U+001F. `\u{202E}` is not a JSON escape (JSON's `\u` takes exactly
 * four digits), so the serialiser doubles its backslash, and a client that
 * parses the result reads what the other four displays show.
 */
const char = (code: number): string => String.fromCodePoint(code);
const RUN = uuidFrom(4, 1);
const INCIDENT_0 = uuidFrom(10, 2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe('the display escape under JSON serialisation (D50 amendment)', () => {
  it('a client that parses the JSON reads the display-escaped text, with nothing the rule names and no raw control', () => {
    const evidence = `Head ${char(0x202e)}line ${char(0x200b)}zero ${char(0x85)}next${char(0x0a)}break`;
    const quoted = quoteEvidence(evidence, 300);
    expect(quoted).not.toBeNull();
    const wire = JSON.stringify({ headline: quoted });
    // The raw JSON carries the doubled backslash: the serialiser at work, not a second escape.
    expect(wire).toContain('\\\\u{202E}');
    const decoded = (JSON.parse(wire) as { headline: { text: string } }).headline.text;
    expect(decoded).toBe(quoted?.text);
    expect(decoded).toBe('Head \\u{202E}line \\u{200B}zero \\u{0085}next\\u{000A}break');
    expect(hasProhibitedText(decoded)).toBe(false);
    expect(hasRawControl(decoded)).toBe(false);
  });

  it('every string a tool returns is escaped, in the text block and in structuredContent alike; identifiers are not', async () => {
    const harness = await connectInMemory({ store: new FakeStore() });
    try {
      const calls = [
        { name: 'list_incidents', arguments: { evidenceRunId: RUN, limit: 50 } },
        { name: 'explain_incident', arguments: { evidenceRunId: RUN, incidentId: INCIDENT_0 } },
      ];
      for (const call of calls) {
        const result = await harness.client.callTool(call);
        expect(result.isError, call.name).not.toBe(true);
        const content = structured(result);
        // The text block is the structured content serialised; parsed, the two are one value.
        expect(JSON.parse(textOf(result)), call.name).toEqual(content);
        expect(deepHasRawControl(content), call.name).toBe(false);
        const run = content['run'] as Record<string, unknown>;
        expect(run['evidenceRunId'], call.name).toBe(RUN);
      }
      const page = structured(
        await harness.client.callTool({
          name: 'list_incidents',
          arguments: { evidenceRunId: RUN, limit: 50 },
        }),
      );
      for (const incident of page['incidents'] as Record<string, unknown>[]) {
        expect(incident['incidentId']).toMatch(UUID);
      }
    } finally {
      await harness.close();
    }
  });
});
