import { describe, expect, it } from 'vitest';

import { STORY_CARD_FIELDS, StoryCardShapeError, toPublicStoryCard } from './story-card.js';

const valid = {
  id: 'AbCdEfGhIjKlMnOpQrSt_-',
  output: 'roundup',
  category: 'cyberattack',
  weekStart: '2026-10-18T03:59:00.000Z',
  weekEnd: '2026-10-25T03:59:00+00:00',
  revision: 2,
  headline: 'Harborline Port halts terminal operations after ransomware intrusion',
  publishers: ['news.example.org', 'wire.example.net'],
};

function shapeError(input: Record<string, unknown>): string | null {
  try {
    toPublicStoryCard(input);
    return null;
  } catch (error) {
    return error instanceof StoryCardShapeError ? error.field : 'other';
  }
}

describe('the public story card contract (D6, D48)', () => {
  it('serializes exactly the allowlisted fields and drops everything else on a hostile input', () => {
    const hostile = {
      ...valid,
      summary: 'The model wrote a summary that must never reach a public address.',
      sources: ['https://news.example.org/story/1'],
      citations: ['3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e61'],
      note: 'an editor note',
      title: 'A third-party headline',
      createdBy: '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab',
      views: 12,
      __proto__: { polluted: true },
    };
    const card = toPublicStoryCard(hostile);
    expect(Object.keys(card)).toEqual([...STORY_CARD_FIELDS]);
    expect(JSON.stringify(card)).not.toMatch(
      /summary|https?:|citation|note|third-party|createdBy|views|polluted/u,
    );
    expect(card.publishers).not.toBe(valid.publishers);
  });

  it('refuses each field of the wrong shape instead of coercing it', () => {
    expect(shapeError(valid)).toBeNull();
    expect(shapeError({ ...valid, id: 'short' })).toBe('id');
    expect(shapeError({ ...valid, output: 'draft' })).toBe('output');
    expect(shapeError({ ...valid, category: 'Cyber Attack' })).toBe('category');
    expect(shapeError({ ...valid, weekStart: 'last week' })).toBe('weekStart');
    expect(shapeError({ ...valid, weekEnd: 5 })).toBe('weekEnd');
    expect(shapeError({ ...valid, revision: -1 })).toBe('revision');
    expect(shapeError({ ...valid, revision: 1.5 })).toBe('revision');
    expect(shapeError({ ...valid, headline: '' })).toBe('headline');
    expect(shapeError({ ...valid, headline: 'x'.repeat(301) })).toBe('headline');
    expect(shapeError({ ...valid, headline: `ok ${String.fromCodePoint(0x202e)} reversed` })).toBe(
      'headline',
    );
    expect(shapeError({ ...valid, headline: 'line\nbreak' })).toBe('headline');
    expect(shapeError({ ...valid, publishers: ['https://news.example.org/x'] })).toBe('publishers');
    expect(shapeError({ ...valid, publishers: ['UPPER.example'] })).toBe('publishers');
    expect(
      shapeError({ ...valid, publishers: Array.from({ length: 13 }, (_, i) => `p${i}.example`) }),
    ).toBe('publishers');
    expect(shapeError({ ...valid, publishers: 'news.example.org' })).toBe('publishers');
  });
});
