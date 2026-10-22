import { RoundupError } from './errors.js';
import type { RoundupInput } from './input.js';
import { RoundupSlotsSchema, type RoundupSlots } from './schema.js';
import { sectionOf, type RundownTemplate } from './template.js';

/**
 * A model response is accepted only when it is the selection, reformatted:
 * the same incidents in the same order, each entry citing exactly its rows
 * and listing exactly their URLs, the flagged entries and the marker echoed
 * unchanged. Anything else rejects the whole response; nothing partial is
 * kept. Messages carry codes and counts, never the response's text.
 */
export function validateResponse(
  raw: unknown,
  input: RoundupInput,
  template: RundownTemplate,
): RoundupSlots {
  const parsed = RoundupSlotsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RoundupError('response_invalid', 'the response does not match the slot schema', {
      issues: parsed.error.issues.length,
    });
  }
  const slots = parsed.data;
  if (slots.rundown.length !== input.incidents.length) {
    throw new RoundupError(
      'response_entry_count',
      'the response holds a different number of entries than the selection',
      {
        expected: input.incidents.length,
        received: slots.rundown.length,
      },
    );
  }
  const allowed = new Set(
    input.incidents.flatMap((incident) => incident.rows.map((row) => row.sourceRowId)),
  );
  for (const [index, entry] of slots.rundown.entries()) {
    const incident = input.incidents[index];
    if (incident === undefined)
      throw new RoundupError('response_entry_count', 'entry without incident');
    const expectedIds = incident.rows.map((row) => row.sourceRowId);
    for (const citation of entry.citations) {
      if (!allowed.has(citation)) {
        throw new RoundupError(
          'response_citation_outside_selection',
          'an entry cites a row outside the selection',
          {
            entry: index,
          },
        );
      }
    }
    if (
      entry.citations.length !== expectedIds.length ||
      entry.citations.some((id, i) => id !== expectedIds[i])
    ) {
      throw new RoundupError(
        'response_order',
        'an entry does not cite exactly its incident’s rows in order',
        {
          entry: index,
        },
      );
    }
    const expectedUrls = incident.rows.map((row) => row.url);
    if (
      entry.sources.length !== expectedUrls.length ||
      entry.sources.some((url, i) => url !== expectedUrls[i])
    ) {
      throw new RoundupError(
        'response_sources_differ',
        'an entry’s sources are not exactly its rows’ URLs in order',
        {
          entry: index,
        },
      );
    }
  }
  if (
    slots.flagged.length !== input.flagged.length ||
    slots.flagged.some(
      (entry, i) =>
        entry.headline !== input.flagged[i]?.headline ||
        entry.reason !== input.flagged[i]?.reason ||
        entry.disposition !== input.flagged[i]?.disposition,
    )
  ) {
    throw new RoundupError(
      'response_flagged_differs',
      'the flagged entries were not echoed unchanged',
    );
  }
  const marker = sectionOf(template, 'extras').marker ?? '';
  if (slots.extras !== marker) {
    throw new RoundupError('response_extras_differs', 'the extras marker was not echoed unchanged');
  }
  return slots;
}
