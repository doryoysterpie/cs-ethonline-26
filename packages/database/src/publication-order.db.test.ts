import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { insertArticleRevision } from './article.js';
import type { Database } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { currentPublication, insertPublication, type NewPublication } from './readers.js';
import { insertRoundupRevision } from './roundup.js';
import { migrationsUpTo, openIsolatedSchema } from './test-support.js';
import { completeWeekRun, insertRunningWeekRun, type NewWeekRun } from './week.js';

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One completed week with round-up revisions 0 to 2 and article revision 1, written through the package. */
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
  const run: NewWeekRun = {
    id: randomUUID(),
    dataOrigin: 'replay',
    batchId,
    timeZone: 'America/Toronto',
    windowStart: '2026-10-18T03:59:00.000Z',
    windowEnd: '2026-10-25T03:59:00.000Z',
    publicationCutoffAt: '2026-10-26T03:59:00.000Z',
    categories: ['cyberattack'],
    idempotencyKey: hash('f'),
    startedAt: new Date().toISOString(),
  };
  await db.withTransaction((tx) => insertRunningWeekRun(tx, run));
  await db.withTransaction((tx) =>
    completeWeekRun(tx, run.id, 'completed', new Date().toISOString(), null),
  );
  const at = new Date().toISOString();
  const generated = {
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
  await db.withTransaction(async (tx) => {
    await insertRoundupRevision(tx, {
      weekRunId: run.id,
      category: 'cyberattack',
      revision: 0,
      kind: 'deterministic',
      slots: { rundown: [] },
      markdown: '# r0',
      provenance: null,
      savedByAccountId: owner,
      createdAt: at,
    });
    for (const revision of [1, 2]) {
      await insertRoundupRevision(tx, {
        weekRunId: run.id,
        category: 'cyberattack',
        revision,
        kind: revision === 1 ? 'generated' : 'edited',
        slots: { rundown: [] },
        markdown: `# r${revision}`,
        provenance: revision === 1 ? generated : null,
        savedByAccountId: owner,
        createdAt: at,
      });
    }
    await insertArticleRevision(tx, {
      weekRunId: run.id,
      category: 'cyberattack',
      revision: 1,
      kind: 'generated',
      slots: { headline: 'x' },
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
      createdAt: at,
    });
  });
  return { weekRunId: run.id, owner };
}

/**
 * The history written before 0022, in the order it was written. The round-up was published at
 * revision 1, corrected to 2, then unpublished. The article was published, then two records
 * carry one instant: by the tie rule the greater `id` is the later, so the article ends
 * published. The instants start at `base`, the application's clock.
 */
function history(
  weekRunId: string,
  owner: string,
  base: number = Date.parse('2026-10-22T10:00:00.000Z'),
): NewPublication[] {
  const mark = (
    output: 'roundup' | 'article',
    revision: number,
    action: 'publish' | 'unpublish',
    createdAt: string,
    id: string = randomUUID(),
  ): NewPublication => ({
    id,
    weekRunId,
    category: 'cyberattack',
    output,
    revision,
    action,
    actorAccountId: owner,
    createdAt,
  });
  const [lower, greater] = [randomUUID(), randomUUID()].sort();
  const at = (seconds: number): string => new Date(base + seconds * 1000).toISOString();
  return [
    mark('roundup', 1, 'publish', at(0)),
    mark('article', 1, 'publish', at(30)),
    mark('roundup', 2, 'publish', at(60)),
    mark('roundup', 2, 'unpublish', at(120)),
    mark('article', 1, 'unpublish', at(240), lower),
    mark('article', 1, 'publish', at(240), greater),
  ];
}

/** Writes the history newest first, then stores the table in that order, so a scan meets the latest record first. */
async function writeNewestFirst(db: Database, records: readonly NewPublication[]): Promise<void> {
  for (const record of [...records].reverse()) {
    await db.withTransaction((tx) => insertPublication(tx, record));
  }
  await db.withClient(async (client) => {
    await client.query(
      'CREATE INDEX publications_newest_first ON output_publications (created_at DESC, id DESC)',
    );
    await client.query('CLUSTER output_publications USING publications_newest_first');
    await client.query('DROP INDEX publications_newest_first');
  });
}

/** Each output's current record under one order: `action:revision:id`. */
async function currentRecords(db: Database, order: string): Promise<Record<string, string>> {
  const result = await db.withClient((client) =>
    client.query<{ output: string; action: string; revision: number; id: string }>(
      `SELECT DISTINCT ON (week_run_id, category, output) output, action, revision, id
         FROM output_publications ORDER BY week_run_id, category, output, ${order}`,
    ),
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.output, `${row.action}:${row.revision}:${row.id}`]),
  );
}

/** The pre-0022 reader's rule. */
const WRITTEN = 'created_at DESC, id DESC';
const SEQUENCE = 'seq DESC';

/** The instant migration 0022's transaction began, as the runner recorded it. */
async function appliedAt22(db: Database): Promise<number> {
  const result = await db.withClient((client) =>
    client.query<{ applied_at: Date }>(
      'SELECT applied_at FROM schema_migrations WHERE version = 22',
    ),
  );
  return result.rows[0]?.applied_at.getTime() ?? Number.NaN;
}

/** Waits until another session is queued for the publication table's exclusive lock. */
async function untilTableLockWaits(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await db.withClient((client) =>
      client.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_catalog.pg_locks
          WHERE relation = 'output_publications'::regclass AND NOT granted
            AND mode = 'AccessExclusiveLock'`,
      ),
    );
    if (result.rows[0]?.waiting !== '0') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('migration 0022 never waited on the publication table');
}

/** The runner's refusal of a migration, with the code PostgreSQL raised, or null when it applied. */
async function refusal(db: Database): Promise<string | null> {
  try {
    await runMigrations(db);
    return null;
  } catch (error) {
    return isDatabaseError(error) ? `${error.message} (${error.code ?? 'no code'})` : 'other';
  }
}

async function idsInOrder(db: Database, order: string): Promise<string[]> {
  const result = await db.withClient((client) =>
    client.query<{ id: string }>(`SELECT id FROM output_publications ORDER BY ${order}`),
  );
  return result.rows.map((row) => row.id);
}

describe('migration 0023: the publication records 0022 numbered take the order they were written (combined audit F1; re-review of pull request 55, F1)', () => {
  it('keeps every output’s current publication through the upgrade, with the table stored opposite to the order its records were written', async () => {
    const isolated = await openIsolatedSchema();
    const through21 = await migrationsUpTo(21);
    const through22 = await migrationsUpTo(22);
    try {
      await runMigrations(isolated.db, { directory: through21.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      const records = history(weekRunId, owner);
      await writeNewestFirst(isolated.db, records);
      const before = await currentRecords(isolated.db, WRITTEN);
      expect(before).toEqual({
        roundup: `unpublish:2:${records[3]?.id}`,
        article: `publish:1:${records[5]?.id}`,
      });

      // 0022 alone numbers the records as the scan meets them: the unpublished round-up's first
      // record becomes current, so revision 1 reads as published again.
      await runMigrations(isolated.db, { directory: through22.directory });
      expect(await currentRecords(isolated.db, SEQUENCE)).toEqual({
        roundup: `publish:1:${records[0]?.id}`,
        article: `publish:1:${records[1]?.id}`,
      });
      expect(
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        ),
      ).not.toBeNull();

      // 0023: the numbers follow the order the records were written, and every output's current
      // record is the one it was before the upgrade; the round-up is unpublished again.
      await runMigrations(isolated.db);
      expect(await currentRecords(isolated.db, SEQUENCE)).toEqual(before);
      expect(await idsInOrder(isolated.db, 'seq')).toEqual(records.map((r) => r.id));
      expect(
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        ),
      ).toBeNull();
      expect(
        (
          await isolated.db.withClient((c) =>
            currentPublication(c, weekRunId, 'cyberattack', 'article'),
          )
        )?.revision,
      ).toBe(1);

      // The guard is back, `seq` is the database's alone again, and a record written now decides
      // whatever instant it carries.
      let refused: unknown;
      try {
        await isolated.db.withClient((c) => c.query(`UPDATE output_publications SET revision = 1`));
      } catch (error) {
        refused = error;
      }
      expect(isDatabaseError(refused) && refused.code).toBe('P0001');
      let supplied: unknown;
      try {
        await isolated.db.withClient((c) =>
          c.query(
            `INSERT INTO output_publications
               (id, week_run_id, category, output, revision, action, actor_account_id, created_at, seq)
             VALUES ($1, $2, 'cyberattack', 'roundup', 1, 'publish', $3, now(), 999)`,
            [randomUUID(), weekRunId, owner],
          ),
        );
      } catch (error) {
        supplied = error;
      }
      expect(isDatabaseError(supplied)).toBe(true);
      const late: NewPublication = {
        ...records[0]!,
        id: randomUUID(),
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      await isolated.db.withTransaction((tx) => insertPublication(tx, late));
      expect((await currentRecords(isolated.db, SEQUENCE)).roundup).toBe(`publish:1:${late.id}`);
    } finally {
      await through21.cleanup();
      await through22.cleanup();
      await isolated.close();
    }
  });

  it('when 0022 ran in an earlier deploy, reorders only the records it numbered; records written after it keep their order', async () => {
    const isolated = await openIsolatedSchema();
    const through21 = await migrationsUpTo(21);
    const through22 = await migrationsUpTo(22);
    try {
      await runMigrations(isolated.db, { directory: through21.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      const records = history(weekRunId, owner);
      await writeNewestFirst(isolated.db, records);
      const before = await currentRecords(isolated.db, WRITTEN);
      await runMigrations(isolated.db, { directory: through22.directory });
      // Written while 0022 was live, after it ran: the round-up republished at 1, then the
      // article unpublished. Their instants are later than 0022's, and their order is theirs.
      const soon = Date.now() + 60_000;
      const after: NewPublication[] = [
        { ...records[0]!, id: randomUUID(), createdAt: new Date(soon).toISOString() },
        {
          ...records[5]!,
          id: randomUUID(),
          action: 'unpublish',
          createdAt: new Date(soon - 30_000).toISOString(),
        },
      ];
      for (const record of after) {
        await isolated.db.withTransaction((tx) => insertPublication(tx, record));
      }
      await runMigrations(isolated.db);
      expect(await idsInOrder(isolated.db, 'seq')).toEqual([
        ...records.map((r) => r.id),
        ...after.map((r) => r.id),
      ]);
      expect(await currentRecords(isolated.db, SEQUENCE)).toEqual({
        roundup: `publish:1:${after[0]?.id}`,
        article: `unpublish:1:${after[1]?.id}`,
      });
      expect(before.roundup).toBe(`unpublish:2:${records[3]?.id}`);
    } finally {
      await through21.cleanup();
      await through22.cleanup();
      await isolated.close();
    }
  });

  it('numbers the records of an insert that held the table while 0022 waited, though their instants are later than 0022 began (re-review of pull request 55, F1 a)', async () => {
    const isolated = await openIsolatedSchema();
    const through21 = await migrationsUpTo(21);
    const through22 = await migrationsUpTo(22);
    try {
      await runMigrations(isolated.db, { directory: through21.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      let records: NewPublication[] = [];
      let migration: Promise<unknown> = Promise.resolve();
      await isolated.db.withClient(async (holder) => {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE output_publications IN ROW EXCLUSIVE MODE');
        migration = runMigrations(isolated.db, { directory: through22.directory });
        await untilTableLockWaits(isolated.db);
        // Stamped from the clock after 0022's transaction began, and written newest first, so
        // the scan 0022 makes once the insert commits meets the latest record first.
        records = history(weekRunId, owner, Date.now());
        for (const record of [...records].reverse()) await insertPublication(holder, record);
        await holder.query('COMMIT');
      });
      await migration;
      const began = await appliedAt22(isolated.db);
      expect(records.every((record) => Date.parse(record.createdAt) > began)).toBe(true);
      const before = await currentRecords(isolated.db, WRITTEN);
      expect(await currentRecords(isolated.db, SEQUENCE)).not.toEqual(before);

      await runMigrations(isolated.db);
      expect(await currentRecords(isolated.db, SEQUENCE)).toEqual(before);
      expect(before.roundup).toBe(`unpublish:2:${records[3]?.id}`);
      expect(await idsInOrder(isolated.db, 'seq')).toEqual(records.map((r) => r.id));
    } finally {
      await through21.cleanup();
      await through22.cleanup();
      await isolated.close();
    }
  });

  it('restores the order of records written before 0022 whose instants are later than 0022 began (re-review of pull request 55, F1 b)', async () => {
    const isolated = await openIsolatedSchema();
    const through21 = await migrationsUpTo(21);
    const through22 = await migrationsUpTo(22);
    try {
      await runMigrations(isolated.db, { directory: through21.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      // A clock a day ahead wrote the whole history.
      const records = history(weekRunId, owner, Date.now() + 86_400_000);
      await writeNewestFirst(isolated.db, records);
      const before = await currentRecords(isolated.db, WRITTEN);
      await runMigrations(isolated.db, { directory: through22.directory });
      const began = await appliedAt22(isolated.db);
      expect(records.every((record) => Date.parse(record.createdAt) > began)).toBe(true);
      expect((await currentRecords(isolated.db, SEQUENCE)).roundup).toBe(
        `publish:1:${records[0]?.id}`,
      );

      await runMigrations(isolated.db);
      expect(await currentRecords(isolated.db, SEQUENCE)).toEqual(before);
      expect(
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        ),
      ).toBeNull();
      expect(await idsInOrder(isolated.db, 'seq')).toEqual(records.map((r) => r.id));
    } finally {
      await through21.cleanup();
      await through22.cleanup();
      await isolated.close();
    }
  });

  it('keeps the written order of records written after 0022 whatever instants they carry, a backdated one included (re-review of pull request 55, F1 c)', async () => {
    const isolated = await openIsolatedSchema();
    const through21 = await migrationsUpTo(21);
    const through22 = await migrationsUpTo(22);
    try {
      await runMigrations(isolated.db, { directory: through21.directory });
      const { weekRunId, owner } = await seedWeek(isolated.db);
      const records = history(weekRunId, owner);
      await writeNewestFirst(isolated.db, records);
      await runMigrations(isolated.db, { directory: through22.directory });
      // Written after 0022, publish then unpublish: the first from a clock running ahead, the
      // second from one running behind, earlier than 0022 itself.
      const after: NewPublication[] = [
        {
          ...records[0]!,
          id: randomUUID(),
          createdAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { ...records[3]!, id: randomUUID(), createdAt: '2020-01-01T00:00:00.000Z' },
      ];
      for (const record of after) {
        await isolated.db.withTransaction((tx) => insertPublication(tx, record));
      }
      expect(Date.parse(after[1]!.createdAt)).toBeLessThan(await appliedAt22(isolated.db));

      await runMigrations(isolated.db);
      expect(await idsInOrder(isolated.db, 'seq')).toEqual([
        ...records.map((r) => r.id),
        ...after.map((r) => r.id),
      ]);
      expect((await currentRecords(isolated.db, SEQUENCE)).roundup).toBe(
        `unpublish:2:${after[1]?.id}`,
      );
      expect(
        await isolated.db.withClient((c) =>
          currentPublication(c, weekRunId, 'cyberattack', 'roundup'),
        ),
      ).toBeNull();
    } finally {
      await through21.cleanup();
      await through22.cleanup();
      await isolated.close();
    }
  });

  it('refuses, changing nothing, when the migration history or a numbered record was rewritten since 0022 ran', async () => {
    for (const rewrite of ['history', 'record'] as const) {
      const isolated = await openIsolatedSchema();
      const through21 = await migrationsUpTo(21);
      const through22 = await migrationsUpTo(22);
      try {
        await runMigrations(isolated.db, { directory: through21.directory });
        const { weekRunId, owner } = await seedWeek(isolated.db);
        await writeNewestFirst(isolated.db, history(weekRunId, owner));
        await runMigrations(isolated.db, { directory: through22.directory });
        await isolated.db.withTransaction(async (tx) => {
          if (rewrite === 'history') {
            // What a logical dump and restore leaves: every version recorded by one transaction.
            await tx.query(
              'CREATE TEMPORARY TABLE kept ON COMMIT DROP AS SELECT * FROM schema_migrations',
            );
            await tx.query('DELETE FROM schema_migrations');
            await tx.query('INSERT INTO schema_migrations SELECT * FROM kept');
          } else {
            await tx.query(
              'ALTER TABLE output_publications DISABLE TRIGGER output_publications_guard',
            );
            await tx.query('UPDATE output_publications SET revision = revision WHERE seq = 1');
            await tx.query(
              'ALTER TABLE output_publications ENABLE TRIGGER output_publications_guard',
            );
          }
        });
        const numbered = await idsInOrder(isolated.db, 'seq');
        expect(await refusal(isolated.db)).toMatch(
          /^migration 0023_publication_order_backfill\.sql failed and was rolled back \(P0001\)$/,
        );
        expect(await idsInOrder(isolated.db, 'seq')).toEqual(numbered);
        const versions = await isolated.db.withClient((c) =>
          c.query<{ version: number }>('SELECT max(version) AS version FROM schema_migrations'),
        );
        expect(versions.rows[0]?.version).toBe(22);
      } finally {
        await through21.cleanup();
        await through22.cleanup();
        await isolated.close();
      }
    }
  });

  it('changes nothing on a schema with no publication record', async () => {
    const isolated = await openIsolatedSchema();
    try {
      const applied = await runMigrations(isolated.db);
      expect(applied.applied.at(-1)).toBe('0023_publication_order_backfill.sql');
      expect(await idsInOrder(isolated.db, 'seq')).toEqual([]);
    } finally {
      await isolated.close();
    }
  });
});
