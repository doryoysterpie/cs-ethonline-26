import { randomUUID } from 'node:crypto';

import { categoryRulesetHash } from '@cas/classification';
import {
  getWeekRun,
  insertIssueSelection,
  isDatabaseError,
  lastSelectionRevision,
  listIncidentMemberRefs,
  listLatestIssueSelections,
  listWeekIncidents,
  listWeekRunChildren,
  type Database,
  type Queryable,
} from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IngestionError, isIngestionError } from '../editorial/errors.js';
import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { computeWeekRunKey, runWeek } from './run.js';
import { resolveWeekWindow } from './window.js';

/**
 * The editorial week against a migrated schema: a complete run over a
 * provided batch, the same window again, a failing child, and the selection
 * record with its provenance, the latest-revision read and the sift table's
 * window and carried rules. Every fixture is synthetic.
 */

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const WINDOW = { startsAt: '2026-10-18T03:59:00.000Z', endsAt: '2026-10-25T03:59:00.000Z' };
/** The batch completes inside the window, so "first seen" is inside it. */
const BATCH_COMPLETED_AT = '2026-10-22T12:00:00.000Z';

const ROWS: readonly {
  title: string;
  summary: string | null;
  urlGroup: string;
  postedAt: string | null;
}[] = [
  {
    title: 'Ransomware halts Northwind Clinic radiology in Portland',
    summary:
      'Northwind Clinic Portland radiology systems were disrupted by the Volt Typhoon intrusion.',
    urlGroup: 'inc-a',
    postedAt: '2026-10-20T10:00:00.000Z',
  },
  {
    title: 'Northwind Clinic Portland radiology disrupted by Volt Typhoon',
    summary: 'Volt Typhoon ransomware halted Northwind radiology systems in Portland.',
    urlGroup: 'inc-b',
    postedAt: '2026-10-21T09:00:00.000Z',
  },
  // Posted before the window, first seen inside it: carried.
  {
    title: 'Kestrelvale Water district confirms a ransomware breach of billing systems',
    summary: 'Kestrelvale Water said billing was offline for two days after the ransomware breach.',
    urlGroup: 'syn-a',
    postedAt: '2026-10-12T08:00:00.000Z',
  },
  // Posted after the freeze: a later week.
  {
    title: 'Larkmere Transit authority discloses a data breach of rider accounts',
    summary: 'Larkmere Transit said rider account data was exposed in a breach.',
    urlGroup: 'lark',
    postedAt: '2026-10-26T08:00:00.000Z',
  },
  // Crypto story inside the window.
  {
    title: 'Bitcoin exchange halts withdrawals after a wallet drainer hits customers',
    summary: 'The exchange said a drainer targeted customer wallets.',
    urlGroup: 'btc',
    postedAt: '2026-10-19T15:00:00.000Z',
  },
  // No posted time: no week.
  {
    title: 'A slow-cooker recipe for the weekend',
    summary: 'Serve the casserole with a salad.',
    urlGroup: 'exc',
    postedAt: null,
  },
];

async function seedBatch(db: Database): Promise<string> {
  const batchId = randomUUID();
  const groups = new Map<string, string>();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'master', NULL, 'week.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', $4, $4, 0, $5::timestamptz, $5::timestamptz)`,
      [
        batchId,
        hash('b'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        ROWS.length,
        BATCH_COMPLETED_AT,
      ],
    );
    for (const [index, spec] of ROWS.entries()) {
      let groupId = groups.get(spec.urlGroup);
      if (groupId === undefined) {
        groupId = randomUUID();
        groups.set(spec.urlGroup, groupId);
        await tx.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          groupId,
          `https://seed.example/${batchId}/${spec.urlGroup}`,
        ]);
      }
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_ch,
           raw_url, raw_category, posted_at, normalized_title, derived_summary_text,
           text_transform, canonical_url, url_group_id, row_hash
         ) VALUES ($1, $2, $3, 'replay', 'accepted', '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', $4, 'Security', $5::timestamptz, $6, $7, 'html-to-text@1', $4, $8, $9)`,
        [
          randomUUID(),
          batchId,
          index + 1,
          `https://seed.example/${batchId}/${spec.urlGroup}`,
          spec.postedAt,
          spec.title,
          spec.summary,
          groupId,
          hash(String(index + 1)),
        ],
      );
    }
  });
  return batchId;
}

async function insertAccount(db: Database): Promise<string> {
  const id = randomUUID();
  await db.withTransaction((tx) =>
    tx.query(
      `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at)
       VALUES ($1, $2, 'editor', 'synthetic-not-a-credential', now(), now())`,
      [id, `editor_${id.slice(0, 8)}`],
    ),
  );
  return id;
}

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

describe('the editorial week against a migrated schema', () => {
  let isolated: IsolatedSchema;
  let batchId: string;

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    batchId = await seedBatch(isolated.db);
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('runs a complete week over a provided batch and records every child; the same window again is reused', async () => {
    const first = await runWeek(isolated.db, { window: WINDOW, batchId });
    expect(first.outcome).toBe('ran');
    expect(first.week.status).toBe('completed');
    expect(first.week.categories).toEqual(['crypto', 'cyberattack']);
    expect(first.week.publicationCutoffAt).toBe(
      new Date('2026-10-26T03:59:00.000Z').toISOString().replace('.000Z', '+00:00'),
    );
    expect(first.children.map((c) => [c.position, c.kind, c.category, c.outcome])).toEqual([
      [1, 'import', null, 'provided'],
      [2, 'classification', 'cyberattack', 'created'],
      [3, 'classification', 'crypto', 'created'],
      [4, 'clustering', 'cyberattack', 'created'],
      [5, 'clustering', 'crypto', 'created'],
    ]);
    const again = await runWeek(isolated.db, { window: WINDOW, batchId });
    expect(again.outcome).toBe('already_ran');
    expect(again.week.id).toBe(first.week.id);
    expect(again.children).toHaveLength(5);
    // The key is the window, zone, batch and the sorted categories.
    const window = resolveWeekWindow(WINDOW);
    expect(first.week.idempotencyKey).toBe(
      computeWeekRunKey({ window, batchId, categories: ['cyberattack', 'crypto'] }),
    );
    expect(computeWeekRunKey({ window, batchId, categories: ['crypto', 'cyberattack'] })).toBe(
      first.week.idempotencyKey,
    );
  });

  it('refuses an unresolved window, a window outside the rule, and an unregistered category before any child runs', async () => {
    const codes: string[] = [];
    for (const request of [
      { window: undefined, batchId },
      {
        window: { startsAt: '2026-10-19T03:59:00.000Z', endsAt: '2026-10-26T03:59:00.000Z' },
        batchId,
      },
      { window: WINDOW, batchId, categories: ['weather_unregistered'] },
      { window: WINDOW, batchId: randomUUID() },
    ]) {
      try {
        await runWeek(isolated.db, request);
        codes.push('none');
      } catch (error) {
        codes.push(isIngestionError(error) ? error.code : 'other');
      }
    }
    expect(codes).toEqual([
      'window_required',
      'window_outside_rule',
      'category_invalid',
      'batch_not_found',
    ]);
    const runs = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM week_runs WHERE status <> $1',
        ['completed'],
      ),
    );
    expect(runs.rows[0]?.count).toBe('0');
  });

  it('marks the manifest failed when a child fails, keeps the children so far, and a rerun continues', async () => {
    const other = await seedBatch(isolated.db);
    let caught: unknown;
    try {
      await runWeek(
        isolated.db,
        { window: WINDOW, batchId: other, categories: ['cyberattack'] },
        {
          cluster: async () => {
            throw new IngestionError('database', 'run_not_reconciled', 'injected failure');
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isIngestionError(caught) && caught.code === 'run_not_reconciled').toBe(true);
    const weekRunId = isIngestionError(caught) ? String(caught.details['weekRunId']) : '';
    const failed = await isolated.db.withClient((c) => getWeekRun(c, weekRunId));
    expect(failed?.status).toBe('failed');
    expect(failed?.failureCode).toBe('run_not_reconciled');
    const children = await isolated.db.withClient((c) => listWeekRunChildren(c, weekRunId));
    expect(children.map((c) => [c.kind, c.outcome])).toEqual([
      ['import', 'provided'],
      ['classification', 'created'],
      ['clustering', 'failed'],
    ]);
    // The retry over the same window and batch reuses the classification and completes.
    const retry = await runWeek(isolated.db, {
      window: WINDOW,
      batchId: other,
      categories: ['cyberattack'],
    });
    expect(retry.outcome).toBe('ran');
    expect(retry.week.id).not.toBe(weekRunId);
    expect(retry.children.map((c) => [c.kind, c.outcome])).toEqual([
      ['import', 'provided'],
      ['classification', 'reused'],
      ['clustering', 'created'],
    ]);
  });

  it('lists the week’s incidents with the window and carried rules, searches and sorts, and withholds text unless asked', async () => {
    const week = await runWeek(isolated.db, { window: WINDOW, batchId });
    const cyber = week.children.find(
      (c) => c.kind === 'clustering' && c.category === 'cyberattack',
    );
    expect(cyber?.clusteringRunId).toBeDefined();
    const rows = await isolated.db.withClient((c) =>
      listWeekIncidents(c, {
        clusteringRunId: cyber?.clusteringRunId ?? '',
        windowStart: week.week.windowStart,
        windowEnd: week.week.windowEnd,
        withText: true,
        search: null,
        sort: 'posted_desc',
        limit: 100,
      }),
    );
    const titles = rows.map((r) => r.title);
    // Northwind (in window) and Kestrelvale (carried) appear; Larkmere (after the freeze) and the recipe (no time) do not.
    expect(
      titles.some(
        (t) => t?.startsWith('Ransomware halts Northwind') || t?.startsWith('Northwind Clinic'),
      ),
    ).toBe(true);
    expect(rows.find((r) => r.title?.startsWith('Kestrelvale'))).toMatchObject({
      inWindow: false,
      carried: true,
    });
    expect(
      rows.every((r) => !r.title?.startsWith('Larkmere') && !r.title?.startsWith('A slow-cooker')),
    ).toBe(true);
    for (const row of rows) expect(row.inWindow || row.carried).toBe(true);
    // Search is a bounded substring match on the representative title.
    const searched = await isolated.db.withClient((c) =>
      listWeekIncidents(c, {
        clusteringRunId: cyber?.clusteringRunId ?? '',
        windowStart: week.week.windowStart,
        windowEnd: week.week.windowEnd,
        withText: true,
        search: 'kestrelvale',
        sort: 'members_desc',
        limit: 100,
      }),
    );
    expect(searched).toHaveLength(1);
    expect(searched[0]?.carried).toBe(true);
    // Without text, no title crosses.
    const blind = await isolated.db.withClient((c) =>
      listWeekIncidents(c, {
        clusteringRunId: cyber?.clusteringRunId ?? '',
        windowStart: week.week.windowStart,
        windowEnd: week.week.windowEnd,
        withText: false,
        search: null,
        sort: 'posted_desc',
        limit: 100,
      }),
    );
    expect(blind.length).toBe(rows.length);
    expect(blind.every((r) => r.title === null)).toBe(true);
  });

  it('records a per-incident selection with its member rows, revises it, and refuses what the guards forbid', async () => {
    const week = await runWeek(isolated.db, { window: WINDOW, batchId });
    const cyber = week.children.find(
      (c) => c.kind === 'clustering' && c.category === 'cyberattack',
    );
    const crypto = week.children.find((c) => c.kind === 'clustering' && c.category === 'crypto');
    const clusteringRunId = cyber?.clusteringRunId ?? '';
    const rows = await isolated.db.withClient((c) =>
      listWeekIncidents(c, {
        clusteringRunId,
        windowStart: week.week.windowStart,
        windowEnd: week.week.windowEnd,
        withText: false,
        search: null,
        sort: 'posted_desc',
        limit: 100,
      }),
    );
    const incident = rows[0];
    expect(incident).toBeDefined();
    const actor = await insertAccount(isolated.db);
    const members = await isolated.db.withClient((c) =>
      listIncidentMemberRefs(c, clusteringRunId, incident?.incidentId ?? ''),
    );
    expect(members.length).toBe(incident?.memberCount);
    const base = {
      weekRunId: week.week.id,
      batchId,
      clusteringRunId,
      incidentId: incident?.incidentId ?? '',
      category: 'cyberattack',
      actorAccountId: actor,
      note: null,
      createdAt: new Date().toISOString(),
    };
    expect(
      await isolated.db.withClient((c) => lastSelectionRevision(c, week.week.id, base.incidentId)),
    ).toBe(0);
    await isolated.db.withTransaction((tx) =>
      insertIssueSelection(
        tx,
        { ...base, id: randomUUID(), state: 'selected', revision: 1 },
        members,
      ),
    );
    // The revision must follow; the same revision again is refused.
    const repeat = await expectRejected(isolated.db, (tx) =>
      insertIssueSelection(
        tx,
        { ...base, id: randomUUID(), state: 'unselected', revision: 1 },
        members,
      ),
    );
    expect(repeat).toBe('P0001');
    await isolated.db.withTransaction((tx) =>
      insertIssueSelection(
        tx,
        { ...base, id: randomUUID(), state: 'unselected', revision: 2, note: 'not this week' },
        members,
      ),
    );
    const latest = await isolated.db.withClient((c) => listLatestIssueSelections(c, week.week.id));
    expect(latest.get(base.incidentId)).toMatchObject({
      state: 'unselected',
      revision: 2,
      note: 'not this week',
    });
    expect(
      await isolated.db.withClient((c) => lastSelectionRevision(c, week.week.id, base.incidentId)),
    ).toBe(2);
    // A clustering run the week did not record for that category is refused.
    const wrongRun = await expectRejected(isolated.db, (tx) =>
      insertIssueSelection(
        tx,
        {
          ...base,
          id: randomUUID(),
          clusteringRunId: crypto?.clusteringRunId ?? '',
          state: 'selected',
          revision: 3,
        },
        members,
      ),
    );
    expect(wrongRun).toBe('P0001');
    // A member reference that is not the incident's is refused by the composite key.
    const wrongMember = await expectRejected(isolated.db, (tx) =>
      insertIssueSelection(tx, { ...base, id: randomUUID(), state: 'selected', revision: 3 }, [
        { ...(members[0] as (typeof members)[number]), membershipId: randomUUID() },
      ]),
    );
    expect(wrongMember).toBe('23503');
    // Append-only.
    const edit = await expectRejected(isolated.db, (tx) =>
      tx.query(`UPDATE issue_selections SET state = 'selected' WHERE week_run_id = $1`, [
        week.week.id,
      ]),
    );
    expect(edit).toBe('P0001');
    const remove = await expectRejected(isolated.db, (tx) =>
      tx.query(`DELETE FROM issue_selection_members WHERE clustering_run_id = $1`, [
        clusteringRunId,
      ]),
    );
    expect(remove).toBe('P0001');
    // The selection's clustering run carries the category's hash, as the manifest says.
    const run = await isolated.db.withClient((c) =>
      c.query<{ ruleset_hash: string }>(
        `SELECT r.ruleset_hash FROM clustering_runs k JOIN classification_runs r ON r.id = k.classification_run_id WHERE k.id = $1`,
        [clusteringRunId],
      ),
    );
    expect(run.rows[0]?.ruleset_hash).toBe(categoryRulesetHash('cyberattack'));
  });
});
