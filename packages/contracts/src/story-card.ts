/**
 * The public story card (D6, D48): the strict allowlist of what a card
 * serializes to anyone who holds its address. A field not named here is
 * never serialized; a value of the wrong shape is refused rather than
 * coerced. The published headline and the publishers' host names are the
 * card's whole text: no summary, no URL, no citation, no stored title.
 */
export const STORY_CARD_CONTRACT = 'story-card@1';

export const STORY_CARD_FIELDS = [
  'id',
  'output',
  'category',
  'weekStart',
  'weekEnd',
  'revision',
  'headline',
  'publishers',
] as const;

export const STORY_CARD_LIMITS = {
  headlineCharacters: 300,
  publishers: 12,
  publisherCharacters: 253,
} as const;

export interface PublicStoryCard {
  readonly id: string;
  readonly output: 'roundup' | 'article';
  readonly category: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly revision: number;
  readonly headline: string;
  readonly publishers: readonly string[];
}

const ID = /^[A-Za-z0-9_-]{22}$/u;
const CATEGORY = /^[a-z][a-z0-9_]{1,31}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
// Controls, separators and bidirectional overrides never reach a card's text.
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

export class StoryCardShapeError extends Error {
  constructor(readonly field: (typeof STORY_CARD_FIELDS)[number]) {
    super(`story card field ${field} has the wrong shape`);
    this.name = 'StoryCardShapeError';
  }
}

function text(value: unknown, field: (typeof STORY_CARD_FIELDS)[number], max: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    FORBIDDEN.test(value)
  ) {
    throw new StoryCardShapeError(field);
  }
  return value;
}

/** Copies exactly the allowlisted fields, each checked; anything else on the input is dropped. */
export function toPublicStoryCard(value: Readonly<Record<string, unknown>>): PublicStoryCard {
  const id = value['id'];
  if (typeof id !== 'string' || !ID.test(id)) throw new StoryCardShapeError('id');
  const output = value['output'];
  if (output !== 'roundup' && output !== 'article') throw new StoryCardShapeError('output');
  const category = value['category'];
  if (typeof category !== 'string' || !CATEGORY.test(category)) {
    throw new StoryCardShapeError('category');
  }
  const weekStart = value['weekStart'];
  if (typeof weekStart !== 'string' || !INSTANT.test(weekStart)) {
    throw new StoryCardShapeError('weekStart');
  }
  const weekEnd = value['weekEnd'];
  if (typeof weekEnd !== 'string' || !INSTANT.test(weekEnd)) {
    throw new StoryCardShapeError('weekEnd');
  }
  const revision = value['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new StoryCardShapeError('revision');
  }
  const headline = text(value['headline'], 'headline', STORY_CARD_LIMITS.headlineCharacters);
  const publishers = value['publishers'];
  if (
    !Array.isArray(publishers) ||
    publishers.length > STORY_CARD_LIMITS.publishers ||
    publishers.some(
      (publisher) =>
        typeof publisher !== 'string' ||
        publisher.length > STORY_CARD_LIMITS.publisherCharacters ||
        !HOST.test(publisher),
    )
  ) {
    throw new StoryCardShapeError('publishers');
  }
  return {
    id,
    output,
    category,
    weekStart,
    weekEnd,
    revision,
    headline,
    publishers: [...(publishers as string[])],
  };
}
