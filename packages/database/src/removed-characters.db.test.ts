import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { insertArticleRevision, listArticleRevisions } from './article.js';
import type { Database } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { insertRoundupRevision, listRoundupRevisions } from './roundup.js';
import { migrationsUpTo, openIsolatedSchema } from './test-support.js';
import { completeWeekRun, insertRunningWeekRun } from './week.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One completed week with round-up revision 0, written before migration 0024. */
async function seedWeek(db: Database): Promise<{ weekRunId: string; owner: string }> {
  const owner = randomUUID();
  const batchId = randomUUID();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at)
       VALUES ($1, 'owner_account', 'owner', 'synthetic-not-a-credential', now(), now())`,
      [owner],
    );
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'master', NULL, 'week.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', 0, 0, 0, now(), now())`,
      [batchId, hash('d'), hash('e')],
    );
  });
  const id = randomUUID();
  await db.withTransaction((tx) =>
    insertRunningWeekRun(tx, {
      id,
      dataOrigin: 'replay',
      batchId,
      timeZone: 'America/Toronto',
      windowStart: '2026-10-18T03:59:00.000Z',
      windowEnd: '2026-10-25T03:59:00.000Z',
      publicationCutoffAt: '2026-10-26T03:59:00.000Z',
      categories: ['cyberattack'],
      idempotencyKey: hash('f'),
      startedAt: new Date().toISOString(),
    }),
  );
  await db.withTransaction((tx) =>
    completeWeekRun(tx, id, 'completed', new Date().toISOString(), null),
  );
  await db.withTransaction((tx) =>
    insertRoundupRevision(tx, {
      weekRunId: id,
      category: 'cyberattack',
      revision: 0,
      kind: 'deterministic',
      slots: { rundown: [] },
      markdown: '# r0',
      provenance: null,
      savedByAccountId: owner,
      createdAt: new Date().toISOString(),
    }),
  );
  return { weekRunId: id, owner };
}

const GENERATED = {
  model: 'claude-opus-5-5',
  promptVersion: 'roundup-prompt@1',
  promptHash: hash('a'),
  templateVersion: 'rundown-template@1',
  templateHash: hash('b'),
  inputDigest: hash('c'),
  inputTokens: 1,
  outputTokens: 1,
  costMicrodollars: 24,
};

/** Round-up revision 1, generated, so that the next revision is the owner's edit. */
async function insertGenerated(db: Database, weekRunId: string, owner: string): Promise<void> {
  await db.withTransaction((tx) =>
    insertRoundupRevision(tx, {
      weekRunId,
      category: 'cyberattack',
      revision: 1,
      kind: 'generated',
      slots: { rundown: [] },
      markdown: '# r1',
      provenance: GENERATED,
      savedByAccountId: owner,
      createdAt: new Date().toISOString(),
    }),
  );
}

async function sqlState(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return isDatabaseError(error) ? error.code : 'not a database error';
  }
}

describe('migration 0024: each revision keeps every character its save removed (CAS-012, review of db10902, finding 1)', () => {
  it('gives an existing revision the empty record, unchanged, and keeps an edit’s record as numbers only', async () => {
    const isolated = await openIsolatedSchema();
    const through23 = await migrationsUpTo(23);
    try {
      await runMigrations(isolated.db, { directory: through23.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      const applied = await runMigrations(isolated.db);
      expect(applied.applied[0]).toBe('0024_revision_removed_characters.sql');
      const before = await isolated.db.withClient((c) =>
        listRoundupRevisions(c, weekRunId, 'cyberattack'),
      );
      expect(before.map((r) => [r.revision, r.markdown, r.removedCharacters])).toEqual([
        [0, '# r0', []],
      ]);

      const removed = Array.from({ length: 25 }, (_, index) => ({
        codePoint: 0x200b,
        line: 1,
        column: index + 3,
      }));
      await insertGenerated(isolated.db, weekRunId, owner);
      await isolated.db.withTransaction(async (tx) => {
        await insertRoundupRevision(tx, {
          weekRunId,
          category: 'cyberattack',
          revision: 2,
          kind: 'edited',
          slots: { rundown: [] },
          markdown: '# r2',
          provenance: null,
          savedByAccountId: owner,
          createdAt: new Date().toISOString(),
          removedCharacters: removed,
        });
      });
      const after = await isolated.db.withClient((c) =>
        listRoundupRevisions(c, weekRunId, 'cyberattack'),
      );
      expect(after.map((r) => r.removedCharacters)).toEqual([[], [], removed]);
      const raw = await isolated.db.withClient((c) =>
        c.query<{ removed_characters: unknown }>(
          `SELECT removed_characters FROM roundup_revisions WHERE week_run_id = $1 AND revision = 2`,
          [weekRunId],
        ),
      );
      expect(raw.rows[0]?.removed_characters).toEqual(removed.map((r) => [0x200b, 1, r.column]));

      // The append-only guard stands: the record cannot be edited after the save.
      expect(
        await sqlState(
          isolated.db.withClient((c) =>
            c.query(
              `UPDATE roundup_revisions SET removed_characters = '[]'::jsonb
                WHERE week_run_id = $1 AND revision = 2`,
              [weekRunId],
            ),
          ),
        ),
      ).toBe('P0001');
    } finally {
      await through23.cleanup();
      await isolated.close();
    }
  });

  it('refuses a record of any other shape, and a record on a revision no owner edited', async () => {
    const isolated = await openIsolatedSchema();
    try {
      await runMigrations(isolated.db);
      const { weekRunId, owner } = await seedWeek(isolated.db);
      await insertGenerated(isolated.db, weekRunId, owner);
      // Revision 2, the owner's edit: only the record can fail the insert.
      const edit = (record: string) =>
        isolated.db.withClient((c) =>
          c.query(
            `INSERT INTO roundup_revisions (week_run_id, category, revision, kind, slots, markdown,
               saved_by_account_id, created_at, removed_characters)
             VALUES ($1, 'cyberattack', 2, 'edited', '{}'::jsonb, '# x', $2, now(), $3::jsonb)`,
            [weekRunId, owner, record],
          ),
        );
      for (const malformed of [
        '{}',
        '[8203]',
        '[[8203, 1]]',
        '[[8203, 1, 1, 4]]',
        '[["200B", 1, 1]]',
        '[[8203, 0, 1]]',
        '[[8203, 1, 1.5]]',
        '[[1114112, 1, 1]]',
        '[[[8203], 1, 1]]',
      ]) {
        expect([malformed, await sqlState(edit(malformed))]).toEqual([malformed, '23514']);
      }
      expect(await sqlState(edit('[[8203, 1, 1]]'))).toBeNull();
      // A generated revision with a record: only an owner's edit removes anything.
      const article = await sqlState(
        isolated.db.withTransaction((tx) =>
          insertArticleRevision(tx, {
            weekRunId,
            category: 'cyberattack',
            revision: 1,
            kind: 'generated',
            slots: {},
            markdown: '# a1',
            provenance: {
              model: 'claude-opus-5-5',
              promptVersion: 'article-prompt@1',
              promptHash: hash('a'),
              inputDigest: hash('b'),
              inputTokens: 1,
              outputTokens: 1,
              costMicrodollars: 24,
              wordCount: 500,
              namingBasis: 'none',
              sources: [],
            },
            savedByAccountId: owner,
            createdAt: new Date().toISOString(),
            removedCharacters: [{ codePoint: 0xad, line: 1, column: 1 }],
          }),
        ),
      );
      expect(article).toBe('23514');
      expect(
        await isolated.db.withClient((c) => listArticleRevisions(c, weekRunId, 'cyberattack')),
      ).toEqual([]);
    } finally {
      await isolated.close();
    }
  });
});
