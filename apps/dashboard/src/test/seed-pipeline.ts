import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from '@cas/database';
import {
  classifyBatch,
  clusterClassificationRun,
  ingestSnapshotFile,
  recordIncidentSubject,
  resolveEvidence,
  runWeek,
} from '@cas/worker';

/**
 * Test-only pipeline seed, never part of a build.
 *
 * Builds the smallest complete state the dashboard can show: one replay
 * batch of invented rows, classified and clustered by the real engines, the
 * twelve committed replay snapshots ingested, one incident given a recorded
 * subject, and one evidence run resolved so that a machine suggestion exists
 * for a person to decide on.
 *
 * The first row's title is deliberately hostile: an HTML script tag, a
 * right-to-left override, an ANSI escape introducer and a `javascript:`
 * scheme in text. Every organisation, headline and URL here is invented.
 */

export const FIXTURES = fileURLToPath(
  new URL('../../../../data/fixtures/evidence/', import.meta.url),
);

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

export const HOSTILE_TITLE = `<script>alert('x')</script> ${String.fromCodePoint(0x202e)}reversed ${String.fromCodePoint(0x1b)}[31mred javascript:alert(1) <img src=x onerror=alert(2)>`;

export const POSTED_AT = '2026-09-04T00:11:07.000Z';

const ROWS: readonly { title: string; summary: string; urlGroup: string }[] = [
  {
    title: HOSTILE_TITLE,
    summary:
      'Officials at Brightwater Lending described a ransomware intrusion affecting customer systems. A security review followed.',
    urlGroup: 'hostile',
  },
  ...Array.from({ length: 11 }, (_, index) => ({
    title: `Company ${index} reports outage affecting services`,
    summary: `Officials described disruption to services and systems for customers in region ${index}. A security review followed.`,
    urlGroup: `bg-${index}`,
  })),
  {
    title: 'Ransomware halts Northwind Clinic radiology in Portland',
    summary:
      'Northwind Clinic Portland radiology systems were disrupted by the Volt Typhoon intrusion.',
    urlGroup: 'inc-a',
  },
  {
    title: 'Northwind Clinic Portland radiology disrupted by Volt Typhoon',
    summary: 'Volt Typhoon ransomware halted Northwind radiology systems in Portland.',
    urlGroup: 'inc-b',
  },
  {
    title: 'Kestrelvale Water district confirms a ransomware breach of billing systems',
    summary: 'Kestrelvale Water said billing was offline for two days after the ransomware breach.',
    urlGroup: 'syn-a',
  },
  {
    title: 'Larkmere Transit authority discloses a data breach of rider accounts',
    summary: 'Larkmere Transit said rider account data was exposed in a breach disclosed Friday.',
    urlGroup: 'brc',
  },
];

export interface SeededPipeline {
  readonly batchId: string;
  readonly classificationRunId: string;
  readonly clusteringRunId: string;
  readonly signalRunIds: readonly string[];
  readonly evidenceRunId: string;
  readonly incidentIds: readonly string[];
  /** The incident that carries the hostile-titled row. */
  readonly hostileIncidentId: string;
  /** The incident given a recorded subject. */
  readonly subjectIncidentId: string;
}

function snapshotPath(day: number): string {
  return path.join(FIXTURES, 'snapshots', `replay-${String(day).padStart(2, '0')}.json`);
}

async function seedBatch(db: Database): Promise<{ batchId: string; hostileRowId: string }> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const groups = new Map<string, string>();
  let hostileRowId = '';
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', 'CS90', 'seed.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', $4, $4, 0, now(), now())`,
      [
        batchId,
        hash('a'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        ROWS.length,
      ],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, 'CS90', 'replay', now())`,
      [snapshotId, batchId],
    );
    for (const [index, spec] of ROWS.entries()) {
      let groupId = groups.get(spec.urlGroup);
      if (groupId === undefined) {
        groupId = randomUUID();
        groups.set(spec.urlGroup, groupId);
        await tx.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          groupId,
          `https://seed.example/dashboard/${spec.urlGroup}`,
        ]);
      }
      const rowId = randomUUID();
      if (index === 0) hostileRowId = rowId;
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_ch,
           raw_url, raw_category, posted_at, normalized_title, derived_summary_text,
           text_transform, canonical_url, url_group_id, row_hash
         ) VALUES ($1, $2, $3, 'replay', 'accepted', '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', $4, 'Security', $5::timestamptz, $6, $7, 'html-to-text@1', $4, $8, $9)`,
        [
          rowId,
          batchId,
          index + 1,
          `https://seed.example/dashboard/${spec.urlGroup}`,
          POSTED_AT,
          spec.title,
          spec.summary,
          groupId,
          hash(String(index % 10)),
        ],
      );
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state)
         VALUES ($1, $2, $3, $4, 'TRUE', 'selected')`,
        [randomUUID(), snapshotId, rowId, batchId],
      );
    }
  });
  return { batchId, hostileRowId };
}

/**
 * One batch with one quarantined row, classified: the quarantined row lands in
 * the review queue, which gives a test a real queue entry to review.
 */
export async function seedQueueRow(
  db: Database,
): Promise<{ readonly classificationRunId: string; readonly sourceRowId: string }> {
  const batchId = randomUUID();
  const sourceRowId = randomUUID();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', 'CS91', 'queue.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed_with_issues', 1, 0, 1, now(), now())`,
      [batchId, hash('b'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
    );
    await tx.query(
      `INSERT INTO source_rows (
         id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
         raw_ch, raw_url, raw_category, normalized_title, derived_summary_text,
         text_transform, row_hash
       ) VALUES ($1, $2, 1, 'replay', 'quarantined', '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                 'TRUE', 'https://seed.example/queue', 'Security', 'Incomplete row', NULL,
                 'html-to-text@1', $3)`,
      [sourceRowId, batchId, hash('c')],
    );
  });
  const classified = await classifyBatch(db, { batchId });
  return { classificationRunId: classified.run.id, sourceRowId };
}

export async function seedPipeline(db: Database): Promise<SeededPipeline> {
  const { batchId, hostileRowId } = await seedBatch(db);
  const classified = await classifyBatch(db, { batchId });
  const clustered = await clusterClassificationRun(db, {
    classificationRunId: classified.run.id,
  });
  const signalRunIds: string[] = [];
  for (let day = 1; day <= 12; day += 1) {
    // The discriminated file input the Sprint 5 correction introduced: a
    // replay fixture, and no way for it to become a live signal run.
    const outcome = await ingestSnapshotFile(db, {
      kind: 'file',
      snapshotPath: snapshotPath(day),
      dataOrigin: 'replay',
    });
    signalRunIds.push(outcome.run.id);
  }
  const incidents = await db.withClient((client) =>
    client.query<{ id: string }>(
      `SELECT id FROM incident_clusters WHERE clustering_run_id = $1 ORDER BY id`,
      [clustered.run.id],
    ),
  );
  const hostile = await db.withClient((client) =>
    client.query<{ incident_cluster_id: string }>(
      `SELECT incident_cluster_id FROM incident_memberships
        WHERE clustering_run_id = $1 AND source_row_id = $2`,
      [clustered.run.id, hostileRowId],
    ),
  );
  const incidentIds = incidents.rows.map((row) => row.id);
  const hostileIncidentId = hostile.rows[0]?.incident_cluster_id ?? '';
  const subjectIncidentId =
    incidentIds.find((id) => id !== hostileIncidentId) ?? incidentIds[0] ?? '';
  await recordIncidentSubject(db, {
    clusteringRunId: clustered.run.id,
    incidentId: subjectIncidentId,
    chain: 'ethereum',
    // spark-lend moves 31.5 percent on the twelfth replay day, past the
    // five-percent correlation floor, so the resolver suggests an association.
    protocolSlug: 'spark-lend',
    actor: 'seed',
    reasonCode: 'seed_subject',
  });
  const lastSignalRun = signalRunIds[signalRunIds.length - 1] ?? '';
  const resolved = await resolveEvidence(db, {
    clusteringRunId: clustered.run.id,
    signalRunId: lastSignalRun,
  });
  return {
    batchId,
    classificationRunId: classified.run.id,
    clusteringRunId: clustered.run.id,
    signalRunIds,
    evidenceRunId: resolved.run.id,
    incidentIds,
    hostileIncidentId,
    subjectIncidentId,
  };
}

/** The window the week seed runs over: Saturday 17 to Saturday 24 October 2026, America/Toronto. */
export const WEEK_WINDOW = {
  startsAt: '2026-10-18T03:59:00.000Z',
  endsAt: '2026-10-25T03:59:00.000Z',
} as const;

export interface SeededWeek {
  readonly batchId: string;
  readonly weekRunId: string;
  readonly clusteringRunId: string;
  readonly category: string;
}

/**
 * One batch with explicit timestamps (completed inside the window, so first
 * seen falls inside it), two incident-worthy rows inside the window and one
 * posted before it (carried), classified and clustered by a week run over
 * the window. Synthetic throughout.
 */
export async function seedWeek(
  db: Database,
  options: { readonly host?: string } = {},
): Promise<SeededWeek> {
  // `seed.example` is a reserved name the fetch policy refuses (R3), which is
  // what the round-up tests want; the article tests name a public-looking host.
  const host = options.host ?? 'seed.example';
  const batchId = randomUUID();
  const rows = [
    {
      title: 'Ransomware halts Harborline Port terminal operations',
      summary: 'Harborline Port said terminal systems were encrypted overnight.',
      group: 'a',
      postedAt: '2026-10-20T10:00:00.000Z',
    },
    {
      title: 'Harborline Port terminal operations disrupted by ransomware',
      summary: 'The port confirmed the ransomware intrusion to its terminal systems.',
      group: 'b',
      postedAt: '2026-10-21T09:00:00.000Z',
    },
    {
      title: 'Brightwater Utility confirms a data breach of customer accounts',
      summary: 'Brightwater Utility said customer account data was exposed.',
      group: 'c',
      postedAt: '2026-10-12T08:00:00.000Z',
    },
  ];
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
        hash('d'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        rows.length,
        '2026-10-22T12:00:00.000Z',
      ],
    );
    for (const [index, spec] of rows.entries()) {
      const groupId = randomUUID();
      await tx.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
        groupId,
        `https://${host}/${batchId}/${spec.group}`,
      ]);
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
          `https://${host}/${batchId}/${spec.group}`,
          spec.postedAt,
          spec.title,
          spec.summary,
          groupId,
          hash(String(index + 2)),
        ],
      );
    }
  });
  const week = await runWeek(db, { window: WEEK_WINDOW, batchId, categories: ['cyberattack'] });
  const clustering = week.children.find((c) => c.kind === 'clustering');
  if (clustering?.clusteringRunId === undefined || clustering.clusteringRunId === null) {
    throw new Error('the seeded week recorded no clustering run');
  }
  return {
    batchId,
    weekRunId: week.week.id,
    clusteringRunId: clustering.clusteringRunId,
    category: 'cyberattack',
  };
}

/**
 * A week whose selection can exceed the round-up's row bound (review of pull
 * request 24, F5): `groups` exact-URL duplicate groups of `rowsPerGroup`
 * rows each, every group its own incident after clustering, in one batch
 * over the standard window. Titles name a distinct organisation per group so
 * no two groups share a rare signal; one group's rows share one canonical
 * URL, so the clusterer keeps them together. Synthetic throughout.
 */
export async function seedLargeWeek(
  db: Database,
  groups: number,
  rowsPerGroup: number,
  options: {
    /** The last `carriedGroups` groups are posted before the window and first seen inside it: carried incidents. */
    readonly carriedGroups?: number | undefined;
  } = {},
): Promise<SeededWeek> {
  const batchId = randomUUID();
  const total = groups * rowsPerGroup;
  const carriedFrom = groups - (options.carriedGroups ?? 0) + 1;
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'master', NULL, 'large-week.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', $4, $4, 0, $5::timestamptz, $5::timestamptz)`,
      [
        batchId,
        hash('e'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        total,
        '2026-10-22T12:00:00.000Z',
      ],
    );
    // One URL group per incident-to-be, then its rows, all in two statements.
    await tx.query(
      `INSERT INTO url_groups (id, canonical_url)
       SELECT gen_random_uuid(), 'https://l.example/' || g
         FROM generate_series(1, $1::int) AS g`,
      [groups],
    );
    await tx.query(
      `INSERT INTO source_rows (
         id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_ch,
         raw_url, raw_category, posted_at, normalized_title, derived_summary_text,
         text_transform, canonical_url, url_group_id, row_hash
       )
       SELECT gen_random_uuid(), $1::uuid, (g - 1) * $3::int + r, 'replay', 'accepted',
              '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb, 'TRUE',
              u.canonical_url, 'Security',
              (CASE WHEN g >= $4::int THEN '2026-10-12T08:00:00.000Z'::timestamptz
                    ELSE '2026-10-20T10:00:00.000Z'::timestamptz END + (r || ' minutes')::interval),
              'Ransomware halts Orgline' || g || 'corp terminal operations, report ' || r,
              'Orgline' || g || 'corp said terminal systems were encrypted overnight; report ' || r || '.',
              'html-to-text@1', u.canonical_url, u.id,
              encode(sha256(convert_to($1::text || ':' || g || ':' || r, 'UTF8')), 'hex')
         FROM generate_series(1, $2::int) AS g
         CROSS JOIN generate_series(1, $3::int) AS r
         JOIN url_groups u ON u.canonical_url = 'https://l.example/' || g`,
      [batchId, groups, rowsPerGroup, carriedFrom],
    );
  });
  const week = await runWeek(db, { window: WEEK_WINDOW, batchId, categories: ['cyberattack'] });
  const clustering = week.children.find((c) => c.kind === 'clustering');
  if (clustering?.clusteringRunId === undefined || clustering.clusteringRunId === null) {
    throw new Error('the seeded large week recorded no clustering run');
  }
  return {
    batchId,
    weekRunId: week.week.id,
    clusteringRunId: clustering.clusteringRunId,
    category: 'cyberattack',
  };
}
