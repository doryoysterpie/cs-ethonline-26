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
