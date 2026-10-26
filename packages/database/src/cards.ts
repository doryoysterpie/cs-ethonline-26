import type { Queryable } from './database.js';

/**
 * Story cards (CAS-009, D48, migration 0021): one card per story, bound to
 * its output and entry, never to a revision; a view count that only rises;
 * a PNG cache per card and published revision.
 */

export type CardOutput = 'roundup' | 'article';

export interface StoryKey {
  readonly weekRunId: string;
  readonly category: string;
  readonly output: CardOutput;
  readonly entryIndex: number;
}

export interface NewStoryCard extends StoryKey {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface StoryCardRecord extends NewStoryCard {
  readonly views: number;
}

const COLUMNS = `id, week_run_id, category, output, entry_index, created_by,
  to_json(created_at) #>> '{}' AS created_at, views::text AS views`;

interface Row {
  id: string;
  week_run_id: string;
  category: string;
  output: CardOutput;
  entry_index: number;
  created_by: string;
  created_at: string;
  views: string;
}

function toRecord(row: Row): StoryCardRecord {
  return {
    id: row.id,
    weekRunId: row.week_run_id,
    category: row.category,
    output: row.output,
    entryIndex: row.entry_index,
    createdBy: row.created_by,
    createdAt: row.created_at,
    views: Number(row.views),
  };
}

export async function getStoryCard(client: Queryable, id: string): Promise<StoryCardRecord | null> {
  const result = await client.query<Row>(`SELECT ${COLUMNS} FROM story_cards WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/** The card already made for a story, if any. */
export async function findStoryCard(
  client: Queryable,
  story: StoryKey,
): Promise<StoryCardRecord | null> {
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM story_cards
      WHERE week_run_id = $1 AND category = $2 AND output = $3 AND entry_index = $4`,
    [story.weekRunId, story.category, story.output, story.entryIndex],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Records a card for its story, or returns the card a concurrent request
 * recorded first: one card per story whatever the interleaving (D48, 7).
 */
export async function insertStoryCard(
  client: Queryable,
  card: NewStoryCard,
): Promise<{ readonly card: StoryCardRecord; readonly created: boolean }> {
  const inserted = await client.query<Row>(
    `INSERT INTO story_cards (id, week_run_id, category, output, entry_index, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
     ON CONFLICT ON CONSTRAINT story_cards_story_unique DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      card.id,
      card.weekRunId,
      card.category,
      card.output,
      card.entryIndex,
      card.createdBy,
      card.createdAt,
    ],
  );
  const row = inserted.rows[0];
  if (row !== undefined) return { card: toRecord(row), created: true };
  const existing = await findStoryCard(client, card);
  if (existing === null) throw new Error('a story card conflicted and then vanished');
  return { card: existing, created: false };
}

/** One origin view, counted; returns the count, or null for an unknown card. */
export async function countStoryCardView(client: Queryable, id: string): Promise<number | null> {
  const result = await client.query<{ views: string }>(
    `UPDATE story_cards SET views = views + 1 WHERE id = $1 RETURNING views::text AS views`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : Number(row.views);
}

export interface StoryCardImage {
  readonly cardId: string;
  readonly revision: number;
  readonly png: Uint8Array;
  readonly pngSha256: string;
  readonly createdAt: string;
}

export async function getStoryCardImage(
  client: Queryable,
  cardId: string,
  revision: number,
): Promise<StoryCardImage | null> {
  const result = await client.query<{
    card_id: string;
    revision: number;
    png: Buffer;
    png_sha256: string;
    created_at: string;
  }>(
    `SELECT card_id, revision, png, png_sha256, to_json(created_at) #>> '{}' AS created_at
       FROM story_card_images WHERE card_id = $1 AND revision = $2`,
    [cardId, revision],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        cardId: row.card_id,
        revision: row.revision,
        png: new Uint8Array(row.png),
        pngSha256: row.png_sha256,
        createdAt: row.created_at,
      };
}

/** Caches one rasterization; a concurrent one of the same card and revision is left as it is. */
export async function insertStoryCardImage(
  client: Queryable,
  image: StoryCardImage,
): Promise<void> {
  await client.query(
    `INSERT INTO story_card_images (card_id, revision, png, png_sha256, created_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (card_id, revision) DO NOTHING`,
    [image.cardId, image.revision, Buffer.from(image.png), image.pngSha256, image.createdAt],
  );
}
