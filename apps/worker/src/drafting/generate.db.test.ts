import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSection, DRAFTING_CONTRACT, type DraftRequest } from '@cas/drafting';
import type { Database } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyBatch } from '../classification/run.js';
import { clusterClassificationRun } from '../clustering/run.js';
import { decideAssociation } from '../evidence/review.js';
import { resolveEvidence } from '../evidence/run.js';
import { ingestSnapshotFile } from '../evidence/signals.js';
import { recordIncidentClaim } from '../evidence/claim.js';
import { recordIncidentSubject } from '../evidence/subject.js';
import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { buildDraftRequest } from './build.js';
import { publishDraft } from './generate.js';

/**
 * Drafting from a real evidence run.
 *
 * The properties under test are the ones a person would be harmed by if they
 * failed: a draft is never overwritten, no name is published on insufficient
 * sourcing, a contradicted incident is marked as contradicted rather than
 * quietly dropped, and every draft says in its own text that it is
 * unpublished, deterministic and not model-generated.
 *
 * All seed text is invented. No organisation, headline or URL here is real.
 */

const FIXTURES = fileURLToPath(new URL('../../../../data/fixtures/evidence/', import.meta.url));
const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const POSTED_AT = '2026-09-04T00:11:07.000Z';

const ROWS: readonly { title: string; summary: string; urlGroup: string }[] = [
  ...Array.from({ length: 12 }, (_, index) => ({
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
    title: 'Kestrelvale Water district confirms a ransomware breach of billing systems',
    summary: 'Kestrelvale Water said billing was offline for two days after the ransomware breach.',
    urlGroup: 'syn-a',
  },
  {
    title: 'Larkmere Transit authority discloses a data breach of rider accounts',
    summary: 'Larkmere Transit said rider account data was exposed in a breach disclosed Friday.',
    urlGroup: 'brc',
  },
  {
    title: 'Stonebrook Credit Union reports an intrusion into member systems',
    summary: 'Stonebrook Credit Union described an intrusion affecting member systems last week.',
    urlGroup: 'cru',
  },
];

async function seedBatch(db: Database): Promise<string> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const groups = new Map<string, string>();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', 'CS91', 'seed.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', $4, $4, 0, now(), now())`,
      [batchId, hash('a'), hash('b'), ROWS.length],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, 'CS91', 'replay', now())`,
      [snapshotId, batchId],
    );
    for (const [index, spec] of ROWS.entries()) {
      let groupId = groups.get(spec.urlGroup);
      if (groupId === undefined) {
        groupId = randomUUID();
        groups.set(spec.urlGroup, groupId);
        await tx.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          groupId,
          `https://seed.example/drafting/${spec.urlGroup}`,
        ]);
      }
      const rowId = randomUUID();
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
          `https://seed.example/drafting/${spec.urlGroup}`,
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
  return batchId;
}

describe('drafting from a real evidence run', () => {
  let isolated: IsolatedSchema;
  let evidenceRunId = '';
  let directory = '';
  let cryptoIncidentId = '';
  let contradictedIncidentId = '';

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const batchId = await seedBatch(isolated.db);
    const classified = await classifyBatch(isolated.db, { batchId });
    const clustered = await clusterClassificationRun(isolated.db, {
      classificationRunId: classified.run.id,
    });
    const signals = await ingestSnapshotFile(isolated.db, {
      kind: 'file',
      snapshotPath: path.join(FIXTURES, 'snapshots', 'replay-12.json'),
      dataOrigin: 'replay',
    });

    const incidents = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM incident_clusters WHERE clustering_run_id = $1 ORDER BY id LIMIT 2`,
        [clustered.run.id],
      ),
    );
    cryptoIncidentId = incidents.rows[0]?.id ?? '';
    contradictedIncidentId = incidents.rows[1]?.id ?? '';
    for (const [incidentId, slug] of [
      [cryptoIncidentId, 'spark-lend'],
      [contradictedIncidentId, 'compound-v3'],
    ] as const) {
      await recordIncidentSubject(isolated.db, {
        clusteringRunId: clustered.run.id,
        incidentId,
        chain: 'ethereum',
        protocolSlug: slug,
        actor: 'owner',
        reasonCode: 'named_in_disclosure',
      });
    }

    const first = await resolveEvidence(isolated.db, {
      clusteringRunId: clustered.run.id,
      signalRunId: signals.run.id,
    });
    const associations = await isolated.db.withClient((client) =>
      client.query<{ id: string; incident_cluster_id: string }>(
        `SELECT id, incident_cluster_id FROM incident_signal_associations WHERE evidence_run_id = $1`,
        [first.run.id],
      ),
    );
    const idFor = (incidentId: string): string =>
      associations.rows.find((row) => row.incident_cluster_id === incidentId)?.id ?? '';

    // A decision names a recorded claim, never an invented identifier: each
    // claim rests on a source row that is a member of its incident.
    const claimFor = async (incidentId: string, statement: string): Promise<string> => {
      const member = await isolated.db.withClient((client) =>
        client.query<{ source_row_id: string }>(
          `SELECT source_row_id FROM incident_memberships
            WHERE clustering_run_id = $1 AND incident_cluster_id = $2 ORDER BY source_row_id LIMIT 1`,
          [clustered.run.id, incidentId],
        ),
      );
      const claim = await recordIncidentClaim(isolated.db, {
        clusteringRunId: clustered.run.id,
        incidentId,
        sourceRowId: member.rows[0]?.source_row_id ?? '',
        claimKind: 'recorded_statement',
        statement,
        actor: 'owner',
        reasonCode: 'stated_in_disclosure',
      });
      return claim.claim.id;
    };
    await decideAssociation(isolated.db, {
      runId: first.run.id,
      associationId: idFor(cryptoIncidentId),
      operation: 'accept',
      relation: 'supports',
      claimId: await claimFor(cryptoIncidentId, 'The disclosure describes a drain on the fourth.'),
      reasonCode: 'movement_matches_disclosure',
      actor: 'owner',
    });
    await decideAssociation(isolated.db, {
      runId: first.run.id,
      associationId: idFor(contradictedIncidentId),
      operation: 'accept',
      relation: 'conflicts',
      claimId: await claimFor(contradictedIncidentId, 'The notice says no funds moved.'),
      reasonCode: 'movement_contradicts_claim',
      actor: 'owner',
    });

    const second = await resolveEvidence(isolated.db, {
      clusteringRunId: clustered.run.id,
      signalRunId: signals.run.id,
    });
    evidenceRunId = second.run.id;
    // Resolved once: the publisher refuses any symbolic link in the root's
    // path, and the platform's temporary directory is reached through one.
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cas-drafts-')));
  });

  afterAll(async () => {
    await isolated.close();
  });

  async function request(): Promise<DraftRequest> {
    return buildDraftRequest(isolated.db, {
      evidenceRunId,
      periodStart: '2026-08-30T00:00:00Z',
      periodEnd: '2026-09-06T00:00:00Z',
    });
  }

  it('writes a draft and its provenance sidecar', async () => {
    const written = await publishDraft(await request(), { root: directory });
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(path.basename(written.directory)).toMatch(
      /^cyberattack-sunday-2026-08-30-[0-9a-f]{8}$/u,
    );
    expect(path.basename(written.draftPath)).toBe('draft.md');
    expect(path.basename(written.sidecarPath)).toBe('provenance.json');
    expect(await readdir(written.directory)).toEqual(['draft.md', 'provenance.json']);

    const markdown = await readFile(written.draftPath, 'utf8');
    expect(markdown).toContain('This draft requires human review before anything is published');
    expect(markdown).toContain('no model was');
    expect(markdown).toContain('supplied explicitly');
  });

  it('refuses to overwrite a draft that already exists', async () => {
    const built = await request();
    await publishDraft(built, { root: directory });
    await expect(publishDraft(built, { root: directory })).rejects.toMatchObject({
      code: 'draft_exists',
    });
  });

  it('withholds every name, because nothing here extracts one', async () => {
    const written = await publishDraft(await request(), { root: directory });
    const sidecar = JSON.parse(await readFile(written.sidecarPath, 'utf8')) as {
      claims: Record<string, unknown>[];
      counts: Record<string, number>;
      status: string;
    };
    expect(sidecar.status).toBe('unpublished_requires_human_review');
    expect(sidecar.claims.length).toBeGreaterThan(0);
    for (const claim of sidecar.claims) {
      // The sidecar has no field for a name at all, which is a stronger
      // property than every name happening to be null.
      expect(Object.keys(claim)).not.toContain('victimName');
      expect(claim.confidence).toBe('reported');
      expect(claim.namingDecision).toBe('withheld_insufficient_sourcing');
    }
    expect(sidecar.counts.namesWithheld).toBe(sidecar.claims.length);
    expect(written.namesWithheld).toBe(sidecar.claims.length);
  });

  it('separates the crypto section from the rest by recorded subject alone', async () => {
    const built = await request();
    const crypto = generateSection('crypto', built);
    const incidents = generateSection('incidents', built);
    const withSubject = built.incidents.filter((incident) => incident.onChainSubject);
    expect(withSubject).toHaveLength(2);
    for (const incident of withSubject) {
      expect(crypto.markdown).toContain(`**${incident.headline}**`);
      expect(incidents.markdown).not.toContain(`**${incident.headline}**`);
    }
    expect(crypto.markdown.startsWith('## Crypto and Web3')).toBe(true);
  });

  it('regenerates one section without touching the others', async () => {
    const built = await request();
    for (const section of DRAFTING_CONTRACT.sections) {
      const once = generateSection(section, built);
      const twice = generateSection(section, built);
      expect(twice).toEqual(once);
    }
    // Changing one incident changes that incident's section and no other.
    const altered: DraftRequest = {
      ...built,
      incidents: built.incidents.map((incident) =>
        incident.incidentId === cryptoIncidentId
          ? {
              ...incident,
              evidenceState: 'reported_only' as const,
              graphEvidence: 'absent' as const,
            }
          : incident,
      ),
    };
    expect(generateSection('header', altered).markdown).toBe(
      generateSection('header', built).markdown,
    );
    expect(generateSection('incidents', altered).markdown).toBe(
      generateSection('incidents', built).markdown,
    );
    expect(generateSection('crypto', altered).markdown).not.toBe(
      generateSection('crypto', built).markdown,
    );
  });

  it('marks a contradicted incident rather than dropping it', async () => {
    const built = await request();
    const contradicted = built.incidents.find(
      (incident) => incident.incidentId === contradictedIncidentId,
    );
    expect(contradicted?.evidenceState).toBe('contradicted');
    const written = await publishDraft(built, { root: directory });
    const markdown = await readFile(written.draftPath, 'utf8');
    // Present, and labelled. A contradicted incident that vanished from the
    // draft would look like an incident nobody ever reported.
    expect(markdown).toContain(`**${contradicted?.headline ?? ''}**`);
    expect(markdown).toContain(
      'accepted on-chain evidence conflicts with this incident as a whole',
    );
    expect(written.draft.provenance.counts.contradicted).toBe(1);
    expect(
      written.draft.provenance.claims.filter((claim) => claim.incidentId === contradictedIncidentId)
        .length,
    ).toBeGreaterThan(0);
  });

  it('produces the same bytes twice for the same evidence run', async () => {
    const first = await request();
    const second = { ...(await request()), draftId: first.draftId };
    const { draft: a } = await publishDraft(first, { root: path.join(directory, 'a') });
    const { draft: b } = await publishDraft(second, { root: path.join(directory, 'b') });
    expect(b.markdown).toBe(a.markdown);
    expect(b.provenance).toEqual(a.provenance);
  });

  it('refuses to draft from an evidence run that is not completed', async () => {
    await expect(
      buildDraftRequest(isolated.db, {
        evidenceRunId: randomUUID(),
        periodStart: '2026-08-30T00:00:00Z',
        periodEnd: '2026-09-06T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'evidence_run_not_completed' });
  });
});
