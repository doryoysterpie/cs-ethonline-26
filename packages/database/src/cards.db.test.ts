import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countStoryCardView,
  findStoryCard,
  getStoryCard,
  getStoryCardImage,
  insertStoryCard,
  insertStoryCardImage,
} from './cards.js';
import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';
import { completeWeekRun, insertRunningWeekRun, type NewWeekRun } from './week.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const cardId = (): string => randomBytes(16).toString('base64url');

async function expectRejected(
  db: Database,
  attempt: (tx: Queryable) => Promise<unknown>,
): Promise<string> {
  let caught: unknown;
  try {
    await db.withTransaction(async (tx) => {
      await attempt(tx);
    });
  } catch (error) {
    caught = error;
  }
  expect(isDatabaseError(caught), 'PostgreSQL must reject the contradiction').toBe(true);
  if (!isDatabaseError(caught)) throw new Error('unreachable');
  return caught.code ?? '';
}

describe('story cards (migration 0021)', () => {
  let isolated: IsolatedSchema;
  let reader: string;
  let editor: string;
  let weekRunId: string;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    reader = randomUUID();
    editor = randomUUID();
    await isolated.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at, expires_at)
         VALUES ($1, 'reader_account', 'reader', 'synthetic-not-a-credential', now(), now(), now() + interval '1 year'),
                ($2, 'editor_account', 'editor', 'synthetic-not-a-credential', now(), now(), NULL)`,
        [reader, editor],
      );
      await tx.query(
        `INSERT INTO import_batches (
           id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
           header_cells, importer_version, idempotency_key, status, parsed_row_count,
           accepted_row_count, quarantined_row_count, started_at, completed_at
         ) VALUES ($1, 'replay', 'master', NULL, 'week.csv', $2, 10, '["ch"]'::jsonb,
                   'editorial-csv-import@1', $3, 'completed', 0, 0, 0, now(), now())`,
        [randomUUID(), hash('d'), hash('e')],
      );
    });
    const batch = await isolated.db.withClient((c) =>
      c.query<{ id: string }>(`SELECT id FROM import_batches LIMIT 1`),
    );
    const run: NewWeekRun = {
      id: randomUUID(),
      dataOrigin: 'replay',
      batchId: batch.rows[0]?.id ?? '',
      timeZone: 'America/Toronto',
      windowStart: '2026-10-18T03:59:00.000Z',
      windowEnd: '2026-10-25T03:59:00.000Z',
      publicationCutoffAt: '2026-10-26T03:59:00.000Z',
      categories: ['cyberattack'],
      idempotencyKey: hash('f'),
      startedAt: new Date().toISOString(),
    };
    weekRunId = run.id;
    await isolated.db.withTransaction((tx) => insertRunningWeekRun(tx, run));
    await isolated.db.withTransaction((tx) =>
      completeWeekRun(tx, run.id, 'completed', new Date().toISOString(), null),
    );
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('holds one card per story, returns the first to a second request, counts views upward only, and never rewrites or deletes', async () => {
    const story = { weekRunId, category: 'cyberattack', output: 'roundup' as const, entryIndex: 2 };
    const first = await isolated.db.withTransaction((tx) =>
      insertStoryCard(tx, {
        ...story,
        id: cardId(),
        createdBy: reader,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(first.created).toBe(true);
    // A second request for the same story, by someone else, returns the first card.
    const second = await isolated.db.withTransaction((tx) =>
      insertStoryCard(tx, {
        ...story,
        id: cardId(),
        createdBy: editor,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(second).toMatchObject({
      created: false,
      card: { id: first.card.id, createdBy: reader },
    });
    expect((await isolated.db.withClient((c) => findStoryCard(c, story)))?.id).toBe(first.card.id);
    // Concurrent requests for a new story: one card.
    const fresh = { ...story, entryIndex: 3 };
    const raced = await Promise.all(
      Array.from({ length: 4 }, () =>
        isolated.db.withTransaction((tx) =>
          insertStoryCard(tx, {
            ...fresh,
            id: cardId(),
            createdBy: reader,
            createdAt: new Date().toISOString(),
          }),
        ),
      ),
    );
    expect(new Set(raced.map((r) => r.card.id)).size).toBe(1);
    expect(raced.filter((r) => r.created)).toHaveLength(1);
    // Views rise one by one; nothing else changes; nothing is deleted.
    expect(await isolated.db.withTransaction((tx) => countStoryCardView(tx, first.card.id))).toBe(
      1,
    );
    expect(await isolated.db.withTransaction((tx) => countStoryCardView(tx, first.card.id))).toBe(
      2,
    );
    expect(await isolated.db.withTransaction((tx) => countStoryCardView(tx, cardId()))).toBeNull();
    expect((await isolated.db.withClient((c) => getStoryCard(c, first.card.id)))?.views).toBe(2);
    for (const statement of [
      `UPDATE story_cards SET views = 0 WHERE id = $1`,
      `UPDATE story_cards SET entry_index = 9 WHERE id = $1`,
      `UPDATE story_cards SET created_by = '${editor}' WHERE id = $1`,
      `DELETE FROM story_cards WHERE id = $1`,
    ]) {
      expect(
        await expectRejected(isolated.db, (tx) => tx.query(statement, [first.card.id])),
        statement,
      ).toBe('P0001');
    }
    // The shape the table holds: an article has one entry; the address is 22 URL-safe characters.
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertStoryCard(tx, {
          ...story,
          output: 'article',
          entryIndex: 1,
          id: cardId(),
          createdBy: reader,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).toBe('23514');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertStoryCard(tx, {
          ...story,
          entryIndex: 7,
          id: 'short',
          createdBy: reader,
          createdAt: new Date().toISOString(),
        }),
      ),
    ).toBe('23514');
  });

  it('caches one image per card and revision, append-only and bounded', async () => {
    const { card } = await isolated.db.withTransaction((tx) =>
      insertStoryCard(tx, {
        weekRunId,
        category: 'cyberattack',
        output: 'article',
        entryIndex: 0,
        id: cardId(),
        createdBy: reader,
        createdAt: new Date().toISOString(),
      }),
    );
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const digest = createHash('sha256').update(png).digest('hex');
    const image = {
      cardId: card.id,
      revision: 1,
      png,
      pngSha256: digest,
      createdAt: new Date().toISOString(),
    };
    await isolated.db.withTransaction((tx) => insertStoryCardImage(tx, image));
    // A concurrent rasterization of the same revision is left as the first.
    await isolated.db.withTransaction((tx) =>
      insertStoryCardImage(tx, {
        ...image,
        png: new Uint8Array([...png, 4]),
        pngSha256: hash('a'),
      }),
    );
    const cached = await isolated.db.withClient((c) => getStoryCardImage(c, card.id, 1));
    expect(cached?.pngSha256).toBe(digest);
    expect([...(cached?.png ?? [])]).toEqual([...png]);
    expect(await isolated.db.withClient((c) => getStoryCardImage(c, card.id, 2))).toBeNull();
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`UPDATE story_card_images SET revision = 3 WHERE card_id = $1`, [card.id]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        tx.query(`DELETE FROM story_card_images WHERE card_id = $1`, [card.id]),
      ),
    ).toBe('P0001');
    expect(
      await expectRejected(isolated.db, (tx) =>
        insertStoryCardImage(tx, { ...image, revision: 2, png: new Uint8Array(1_048_577) }),
      ),
    ).toBe('23514');
  });
});
