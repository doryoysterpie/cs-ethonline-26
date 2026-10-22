import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openMigratedSchema, type IsolatedSchema } from '../../test/isolated-schema.ts';
import {
  HOSTILE_TITLE,
  seedPipeline,
  seedQueueRow,
  seedWeek,
  type SeededPipeline,
} from '../../test/seed-pipeline.ts';
import { insertSynthetic, syntheticAccount } from '../../test/synthetic-accounts.ts';
import { openMemoryStores } from '../auth/memory-store.ts';
import { openPostgresStores } from '../auth/postgres-store.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { isDashboardError } from '../errors.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import {
  decideEvidence,
  MAX_DRAFT_REVISIONS,
  MAX_QUEUE_DECISIONS_PER_ENTRY,
  mergeIncidentsAction,
  reviewQueueEntry,
  saveDraftRevision,
  selectStory,
  splitIncidentAction,
} from './mutate.ts';
import {
  anomalyView,
  commandCenter,
  draftKeyOf,
  draftView,
  evidenceView,
  incidentDetail,
  incidentExplorer,
  reviewQueue,
  weekList,
  weekTable,
} from './read.ts';

/**
 * The data-access layer against a migrated schema seeded by the real
 * pipeline, with the memory stores for accounts, sessions, audit, drafts and
 * queue decisions.
 *
 * What is proven here and nowhere else: a judge receives no source text from
 * the database; an identifier from another run reads nothing; every mutation
 * lands as a new row and the machine's records are byte-for-byte unchanged;
 * optimistic concurrency refuses a stale revision; and a direct SQL statement
 * against a machine record is refused by the schema's own guards.
 */

const PERIOD_START = '2026-09-01T00:00:00.000Z';
const PERIOD_END = '2026-09-08T00:00:00.000Z';
const AS_OF = '2026-09-04T09:11:23Z';

async function kindOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (isDashboardError(error)) return error.kind;
    throw error;
  }
  return 'succeeded';
}

describe('data-access layer against PostgreSQL', () => {
  let isolated: IsolatedSchema;
  let seeded: SeededPipeline;
  let runtime: Runtime;
  const principals = {} as Record<Role, Principal>;
  let machineFingerprint = '';

  async function fingerprint(): Promise<string> {
    const result = await isolated.db.withClient((client) =>
      client.query<{ digest: string }>(
        `SELECT encode(sha256(convert_to(string_agg(line, E'\\n' ORDER BY line), 'UTF8')), 'hex') AS digest
           FROM (
             SELECT 'c:' || id::text || member_count::text || fingerprint AS line FROM incident_clusters
             UNION ALL
             SELECT 'm:' || id::text || incident_cluster_id::text || source_row_id::text FROM incident_memberships
             UNION ALL
             SELECT 'a:' || id::text || status || relation FROM incident_signal_associations
             UNION ALL
             SELECT 's:' || id::text || state FROM incident_evidence_states
           ) lines`,
      ),
    );
    return result.rows[0]?.digest ?? '';
  }

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    seeded = await seedPipeline(isolated.db);
    const stores = await openMemoryStores(null);
    runtime = createRuntime(
      {
        environment: 'local',
        accountStore: 'memory',
        memorySeedPath: null,
        databaseSchema: isolated.name,
        trustForwardedFor: false,
        trustedProxyHops: 1,
      },
      stores,
      isolated.db,
    );
    for (const role of ROLES) {
      const account = await syntheticAccount(role);
      await insertSynthetic(stores, account);
      principals[role] = {
        accountId: account.record.id,
        username: account.record.username,
        normalizedEmail: null,
        role,
        sessionId: randomUUID(),
        sessionToken: 'a'.repeat(43),
      };
    }
    machineFingerprint = await fingerprint();
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('shows every run with its data origin on the command center, to every role', async () => {
    for (const role of ROLES) {
      const view = await commandCenter(runtime, principals[role]);
      expect(view.totals.importBatches).toBe(1);
      expect(view.totals.clusteringRuns).toBe(1);
      expect(view.totals.graphSignalRuns).toBe(12);
      expect(view.totals.evidenceRuns).toBe(1);
      for (const run of [...view.clusteringRuns, ...view.evidenceRuns, ...view.signalRuns]) {
        expect(run.dataOrigin).toBe('replay');
      }
      // The seeded run was classified under the default category (migration 0013).
      expect(
        view.classificationRuns.find((run) => run.id === seeded.classificationRunId)?.category,
      ).toBe('cyberattack');
    }
  });

  it('withholds source text from a judge and returns it to an editor', async () => {
    const judge = await incidentDetail(
      runtime,
      principals.judge,
      seeded.clusteringRunId,
      seeded.hostileIncidentId,
    );
    expect(judge.members.length).toBeGreaterThan(0);
    for (const member of judge.members) {
      expect(member.title).toBeNull();
      expect(member.publisher).toBeNull();
      expect(member.url).toBeNull();
    }
    expect(judge.canReview).toBe(false);
    expect(JSON.stringify(judge)).not.toContain('<script>');
    const editor = await incidentDetail(
      runtime,
      principals.editor,
      seeded.clusteringRunId,
      seeded.hostileIncidentId,
    );
    expect(editor.members.some((member) => member.title === HOSTILE_TITLE)).toBe(true);
    expect(editor.canReview).toBe(true);
    expect(editor.incident.dataOrigin).toBe('replay');
  });

  it('reads nothing for an incident named under a run that does not own it', async () => {
    expect(
      await kindOf(
        incidentDetail(runtime, principals.editor, randomUUID(), seeded.hostileIncidentId),
      ),
    ).toBe('not_found');
    expect(await kindOf(incidentExplorer(runtime, principals.editor, randomUUID(), null))).toBe(
      'not_found',
    );
    expect(await kindOf(evidenceView(runtime, principals.judge, randomUUID()))).toBe('not_found');
  });

  it('pages the incident explorer by identifier', async () => {
    const view = await incidentExplorer(runtime, principals.judge, seeded.clusteringRunId, null);
    expect(view.incidents.length).toBe(seeded.incidentIds.length);
    expect(view.incidents.map((incident) => incident.id)).toEqual(seeded.incidentIds);
    expect(
      view.incidents.find((incident) => incident.id === seeded.subjectIncidentId)?.subjectChain,
    ).toBe('ethereum');
    expect(view.reviewRevision).toBe(0);
  });

  it('derives the queue for an editor only, and refuses a decision on a row outside the queue', async () => {
    expect(
      await kindOf(reviewQueue(runtime, principals.judge, seeded.classificationRunId, 0)),
    ).toBe('authorization');
    const view = await reviewQueue(runtime, principals.editor, seeded.classificationRunId, 0);
    expect(view.entries.length).toBe(view.run.reviewCount);
    expect(view.run.category).toBe('cyberattack');
    const outside = await isolated.db.withClient((client) =>
      client.query<{ source_row_id: string }>(
        `SELECT source_row_id FROM classification_results WHERE run_id = $1 AND decision <> 'review' LIMIT 1`,
        [seeded.classificationRunId],
      ),
    );
    const rowOutside = outside.rows[0]?.source_row_id ?? randomUUID();
    expect(
      await kindOf(
        reviewQueueEntry(runtime, principals.editor, {
          classificationRunId: seeded.classificationRunId,
          sourceRowId: rowOutside,
          reviewState: 'selected',
          reasonCode: 'editorial_judgement',
          note: null,
        }),
      ),
    ).toBe('not_found');
    const first = view.entries[0];
    if (first !== undefined) {
      const recorded = await reviewQueueEntry(runtime, principals.editor, {
        classificationRunId: seeded.classificationRunId,
        sourceRowId: first.sourceRowId,
        reviewState: 'rejected',
        reasonCode: 'editorial_judgement',
        note: 'private editorial note',
      });
      expect(recorded.decisionId).toMatch(/^[0-9a-f-]{36}$/u);
      const again = await reviewQueue(runtime, principals.editor, seeded.classificationRunId, 0);
      expect(again.entries[0]?.decision?.reviewState).toBe('rejected');
      expect(again.entries[0]?.decision?.note).toBe('private editorial note');
    }
  });

  it('records a merge and a split as append-only actions and refuses a stale revision', async () => {
    const [first, second] = seeded.incidentIds;
    if (first === undefined || second === undefined)
      throw new Error('seed produced fewer than two incidents');
    const merged = await mergeIncidentsAction(runtime, principals.editor, {
      clusteringRunId: seeded.clusteringRunId,
      incidentIds: [first, second],
      reasonCode: 'same_incident',
      note: 'merge note',
      expectedRevision: 0,
    });
    expect(merged.outcome).toBe('recorded');
    expect(merged.revision).toBe(1);
    const replay = await mergeIncidentsAction(runtime, principals.editor, {
      clusteringRunId: seeded.clusteringRunId,
      incidentIds: [second, first],
      reasonCode: 'same_incident',
      note: 'merge note',
      expectedRevision: 0,
    });
    expect(replay.outcome).toBe('already_recorded');
    const [third, fourth] = seeded.incidentIds.slice(2);
    if (third === undefined || fourth === undefined)
      throw new Error('seed produced fewer than four incidents');
    expect(
      await kindOf(
        mergeIncidentsAction(runtime, principals.editor, {
          clusteringRunId: seeded.clusteringRunId,
          incidentIds: [third, fourth],
          reasonCode: 'same_incident',
          note: null,
          expectedRevision: 0,
        }),
      ),
    ).toBe('conflict');
    const explorer = await incidentExplorer(
      runtime,
      principals.judge,
      seeded.clusteringRunId,
      null,
    );
    expect(explorer.reviewRevision).toBe(1);
    const multi = explorer.incidents.find(
      (incident) => incident.memberCount > 1 && incident.id !== first && incident.id !== second,
    );
    if (multi !== undefined) {
      const detail = await incidentDetail(
        runtime,
        principals.editor,
        seeded.clusteringRunId,
        multi.id,
      );
      const membership = detail.members[0]?.membershipId ?? '';
      const split = await splitIncidentAction(runtime, principals.editor, {
        clusteringRunId: seeded.clusteringRunId,
        incidentId: multi.id,
        membershipIds: [membership],
        reasonCode: 'distinct_incident',
        note: null,
        expectedRevision: 1,
      });
      expect(split.outcome).toBe('recorded');
      expect(split.revision).toBe(2);
    }
  });

  it('shows evidence to every role, decisions with rationale to editors only, and records a decision', async () => {
    const judge = await evidenceView(runtime, principals.judge, seeded.evidenceRunId);
    expect(judge.states.length).toBe(seeded.incidentIds.length);
    expect(judge.limitations.length).toBeGreaterThan(0);
    expect(judge.canReview).toBe(false);
    expect(judge.associations.length).toBeGreaterThan(0);
    const association = judge.associations[0];
    if (association === undefined) throw new Error('no association');
    expect(
      await kindOf(
        decideEvidence(runtime, principals.judge, {
          evidenceRunId: seeded.evidenceRunId,
          associationId: association.associationId,
          operation: 'accept',
          relation: 'context',
          claimId: null,
          reasonCode: 'editorial_review',
          rationale: null,
        }),
      ),
    ).toBe('authorization');
    const decided = await decideEvidence(runtime, principals.editor, {
      evidenceRunId: seeded.evidenceRunId,
      associationId: association.associationId,
      operation: 'accept',
      relation: 'context',
      claimId: null,
      reasonCode: 'editorial_review',
      rationale: 'private rationale',
    });
    expect(decided.outcome).toBe('recorded');
    expect(decided.revision).toBe(1);
    expect(
      await kindOf(
        decideEvidence(runtime, principals.editor, {
          evidenceRunId: randomUUID(),
          associationId: association.associationId,
          operation: 'accept',
          relation: 'context',
          claimId: null,
          reasonCode: 'editorial_review',
          rationale: null,
        }),
      ),
    ).toBe('not_found');
    const editor = await evidenceView(runtime, principals.editor, seeded.evidenceRunId);
    expect(editor.decisions[0]?.rationale).toBe('private rationale');
    expect(
      editor.associations.find((entry) => entry.associationId === association.associationId)
        ?.effectiveStatus,
    ).toBe('accepted');
    const judgeAgain = await evidenceView(runtime, principals.judge, seeded.evidenceRunId);
    expect(judgeAgain.decisions[0]?.rationale).toBeNull();
    expect(JSON.stringify(judgeAgain)).not.toContain('private rationale');
  });

  it('builds the anomaly feed from stored signals with a limitation on every entry', async () => {
    const lastSignalRun = seeded.signalRunIds[seeded.signalRunIds.length - 1] ?? '';
    const view = await anomalyView(runtime, principals.judge, {
      signalRunId: lastSignalRun,
      asOf: AS_OF,
      clusteringRunId: null,
      windows: [],
    });
    expect(view.entries.length).toBeGreaterThan(0);
    for (const entry of view.entries) {
      expect(entry.dataOrigin).toBe('replay');
      expect(entry.evidenceLimitation.length).toBeGreaterThan(20);
    }
    expect(
      await kindOf(
        anomalyView(runtime, principals.judge, {
          signalRunId: lastSignalRun,
          asOf: AS_OF,
          clusteringRunId: seeded.clusteringRunId,
          windows: [{ startsAt: PERIOD_END, endsAt: PERIOD_START }],
        }),
      ),
    ).toBe('validation');
    const withReporting = await anomalyView(runtime, principals.judge, {
      signalRunId: lastSignalRun,
      asOf: AS_OF,
      clusteringRunId: seeded.clusteringRunId,
      windows: [{ startsAt: PERIOD_START, endsAt: PERIOD_END }],
    });
    expect(withReporting.stats.reportingWindows).toBe(1);
  });

  it('refuses draft preview to a judge entirely, and appends editor revisions with optimistic concurrency', async () => {
    // The owner decision of 2026-09-12 withdraws draft-preview access from
    // the judge role: no headline, no source link, no source text, no
    // editor note and no unsanitized draft content reaches a judge.
    expect(
      await kindOf(
        draftView(runtime, principals.judge, seeded.evidenceRunId, PERIOD_START, PERIOD_END),
      ),
    ).toBe('authorization');
    expect(
      await kindOf(
        saveDraftRevision(runtime, principals.judge, {
          evidenceRunId: seeded.evidenceRunId,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          expectedRevision: 0,
          markdown: '# edited',
        }),
      ),
    ).toBe('authorization');

    const editor = await draftView(
      runtime,
      principals.editor,
      seeded.evidenceRunId,
      PERIOD_START,
      PERIOD_END,
    );
    expect(editor.revision).toBe(0);
    expect(editor.status).toBe('unpublished_requires_human_review');
    expect(editor.markdown).toContain('unpublished');
    expect(editor.canEdit).toBe(true);

    const saved = await saveDraftRevision(runtime, principals.editor, {
      evidenceRunId: seeded.evidenceRunId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      expectedRevision: 0,
      markdown: '# edited by the editor\n\nA sentence.',
    });
    expect(saved.revision).toBe(1);
    expect(
      await kindOf(
        saveDraftRevision(runtime, principals.admin, {
          evidenceRunId: seeded.evidenceRunId,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          expectedRevision: 0,
          markdown: '# a competing edit',
        }),
      ),
    ).toBe('conflict');
    const after = await draftView(
      runtime,
      principals.admin,
      seeded.evidenceRunId,
      PERIOD_START,
      PERIOD_END,
    );
    expect(after.revision).toBe(1);
    expect(after.markdown).toContain('edited by the editor');
    expect(after.generatedMarkdown).toContain('unpublished');
    expect(after.revisions).toHaveLength(1);
    expect(after.revisions[0]?.savedBy).toBe(principals.editor.username);
  });

  it('left every machine record unchanged and audited every mutation without stored text', async () => {
    expect(await fingerprint()).toBe(machineFingerprint);
    const audit = await runtime.stores.audit.list(100);
    const kinds = audit.map((event) => event.kind);
    expect(kinds).toContain('incident_merged');
    expect(kinds).toContain('evidence_decided');
    expect(kinds).toContain('draft_revision_saved');
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('<script>');
    expect(serialized).not.toContain('private rationale');
    expect(serialized).not.toContain('merge note');
    expect(serialized).not.toContain('edited by the editor');
  });

  it('refuses a direct SQL rewrite of a machine record or a human decision', async () => {
    const raised = (error: unknown): boolean =>
      typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P0001';
    // Every statement below must match rows, or a row-level guard would never fire.
    const counts = await isolated.db.withClient((client) =>
      client.query<{ clusters: string; actions: string; decisions: string; associations: string }>(
        `SELECT (SELECT count(*) FROM incident_clusters WHERE clustering_run_id = $1)::text AS clusters,
                (SELECT count(*) FROM clustering_review_actions WHERE clustering_run_id = $1)::text AS actions,
                (SELECT count(*) FROM evidence_review_actions WHERE evidence_run_id = $2)::text AS decisions,
                (SELECT count(*) FROM incident_signal_associations WHERE evidence_run_id = $2)::text AS associations`,
        [seeded.clusteringRunId, seeded.evidenceRunId],
      ),
    );
    for (const value of Object.values(counts.rows[0] ?? {}))
      expect(Number(value)).toBeGreaterThan(0);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE incident_clusters SET member_count = member_count + 1 WHERE clustering_run_id = $1`,
          [seeded.clusteringRunId],
        ),
      ),
    ).rejects.toSatisfy(raised);
    await expect(
      isolated.db.withClient((client) =>
        client.query(`DELETE FROM clustering_review_actions WHERE clustering_run_id = $1`, [
          seeded.clusteringRunId,
        ]),
      ),
    ).rejects.toSatisfy(raised);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE evidence_review_actions SET rationale = NULL WHERE evidence_run_id = $1`,
          [seeded.evidenceRunId],
        ),
      ),
    ).rejects.toSatisfy(raised);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE incident_signal_associations SET status = 'accepted' WHERE evidence_run_id = $1`,
          [seeded.evidenceRunId],
        ),
      ),
    ).rejects.toSatisfy(raised);
    expect(await fingerprint()).toBe(machineFingerprint);
  });
  it('refuses the 101st decision when two reviews of one row arrive together (CAS-006, blocker 7, Codex F1)', async () => {
    const queueRow = await seedQueueRow(isolated.db);
    for (let n = 0; n < MAX_QUEUE_DECISIONS_PER_ENTRY - 1; n += 1) {
      await runtime.stores.queueDecisions.append({
        id: randomUUID(),
        classificationRunId: queueRow.classificationRunId,
        sourceRowId: queueRow.sourceRowId,
        reviewState: 'rejected',
        reasonCode: 'editorial_judgement',
        note: null,
        actorAccountId: principals.editor.accountId,
        createdAt: new Date().toISOString(),
      });
    }
    const review = () =>
      reviewQueueEntry(runtime, principals.editor, {
        classificationRunId: queueRow.classificationRunId,
        sourceRowId: queueRow.sourceRowId,
        reviewState: 'selected',
        reasonCode: 'editorial_judgement',
        note: null,
      });
    // Both start at 99 held decisions. Exactly one may land.
    const settled = await Promise.allSettled([review(), review()]);
    const landed = settled.filter((r) => r.status === 'fulfilled');
    const refused = settled.filter(
      (r) =>
        r.status === 'rejected' && isDashboardError(r.reason) && r.reason.code === 'decision_limit',
    );
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(
      await runtime.stores.queueDecisions.countForEntry(
        queueRow.classificationRunId,
        queueRow.sourceRowId,
      ),
    ).toBe(MAX_QUEUE_DECISIONS_PER_ENTRY);
  });

  it('bounds the decisions one queue row keeps and the revisions one draft keeps (CAS-006, blocker 7)', async () => {
    // The seeded run has no review row, so the bound is exercised on a row
    // identifier whose decisions are appended through the store directly; the
    // data-access layer checks the bound before the queue lookup.
    const rowId = randomUUID();
    expect(
      await runtime.stores.queueDecisions.countForEntry(seeded.classificationRunId, rowId),
    ).toBe(0);
    for (let n = 0; n < MAX_QUEUE_DECISIONS_PER_ENTRY; n += 1) {
      await runtime.stores.queueDecisions.append({
        id: randomUUID(),
        classificationRunId: seeded.classificationRunId,
        sourceRowId: rowId,
        reviewState: 'rejected',
        reasonCode: 'editorial_judgement',
        note: null,
        actorAccountId: principals.editor.accountId,
        createdAt: new Date().toISOString(),
      });
    }
    let caught: unknown = null;
    try {
      await reviewQueueEntry(runtime, principals.editor, {
        classificationRunId: seeded.classificationRunId,
        sourceRowId: rowId,
        reviewState: 'selected',
        reasonCode: 'editorial_judgement',
        note: null,
      });
    } catch (error) {
      caught = error;
    }
    expect(isDashboardError(caught) && caught.code === 'decision_limit').toBe(true);

    const key = draftKeyOf(seeded.evidenceRunId, PERIOD_START, PERIOD_END);
    const latest = await runtime.stores.drafts.latest(key);
    for (
      let revision = (latest?.revision ?? 0) + 1;
      revision <= MAX_DRAFT_REVISIONS;
      revision += 1
    ) {
      await runtime.stores.drafts.append({
        draftKey: key,
        revision,
        markdown: `# revision ${revision}`,
        savedByAccountId: principals.editor.accountId,
        savedAt: new Date().toISOString(),
      });
    }
    caught = null;
    try {
      await saveDraftRevision(runtime, principals.editor, {
        evidenceRunId: seeded.evidenceRunId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        expectedRevision: MAX_DRAFT_REVISIONS,
        markdown: '# one too many',
      });
    } catch (error) {
      caught = error;
    }
    expect(isDashboardError(caught) && caught.code === 'revision_limit').toBe(true);
  });

  describe('the editorial week (CAS-003)', () => {
    it('lists completed weeks to every role, and shows the sift table with titles only to a principal holding source text', async () => {
      const week = await seedWeek(isolated.db);
      for (const role of ROLES) {
        const list = await weekList(runtime, principals[role]);
        expect(list.weeks.some((w) => w.id === week.weekRunId && w.status === 'completed')).toBe(
          true,
        );
      }
      const editor = await weekTable(
        runtime,
        principals.editor,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(editor.category).toBe('cyberattack');
      expect(editor.clusteringRunId).toBe(week.clusteringRunId);
      expect(editor.canSelect).toBe(true);
      expect(editor.rows.length).toBeGreaterThan(0);
      expect(
        editor.rows.some(
          (row) =>
            row.title?.startsWith('Ransomware halts Harborline') ||
            row.title?.startsWith('Harborline Port'),
        ),
      ).toBe(true);
      const carried = editor.rows.find((row) => row.title?.startsWith('Brightwater'));
      expect(carried).toMatchObject({ carried: true, inWindow: false, selection: null });
      const judge = await weekTable(
        runtime,
        principals.judge,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(judge.canSelect).toBe(false);
      expect(judge.rows.length).toBe(editor.rows.length);
      expect(judge.rows.every((row) => row.title === null)).toBe(true);
      // Search is compared in the database; sort and category are whitelisted.
      const searched = await weekTable(
        runtime,
        principals.editor,
        week.weekRunId,
        'cyberattack',
        'brightwater',
        'members_desc',
      );
      expect(searched.rows).toHaveLength(1);
      expect(searched.search).toBe('brightwater');
      expect(
        await kindOf(
          weekTable(runtime, principals.editor, week.weekRunId, 'crypto', undefined, undefined),
        ),
      ).toBe('validation');
      expect(
        await kindOf(
          weekTable(runtime, principals.editor, week.weekRunId, 'cyberattack', undefined, 'random'),
        ),
      ).toBe('validation');
      expect(
        await kindOf(
          weekTable(runtime, principals.editor, randomUUID(), 'cyberattack', undefined, undefined),
        ),
      ).toBe('not_found');
    });

    it('records a selection for an editor with the next revision, refuses a judge, and shows the latest state', async () => {
      const week = await seedWeek(isolated.db);
      // The seed itself writes machine rows (runs, incidents); the selections below must not.
      const machineBefore = await fingerprint();
      const table = await weekTable(
        runtime,
        principals.editor,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      const row = table.rows[0];
      expect(row).toBeDefined();
      const input = {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: row?.incidentId ?? '',
        state: 'selected',
        note: null,
      };
      // The selection carries its actor by foreign key, so it needs persistent
      // accounts: the memory-store runtime refuses with a fixed code, and the
      // PostgreSQL-store runtime below records it.
      expect(await kindOf(selectStory(runtime, principals.editor, input))).toBe('validation');
      const persistent = openPostgresStores(isolated.db);
      const persistentRuntime = createRuntime(
        {
          environment: 'local',
          accountStore: 'memory',
          memorySeedPath: null,
          databaseSchema: isolated.name,
          trustForwardedFor: false,
          trustedProxyHops: 1,
        },
        persistent,
        isolated.db,
      );
      const persisted = {} as Record<Role, Principal>;
      for (const role of ROLES) {
        const account = await syntheticAccount(role);
        await insertSynthetic(persistent, account);
        // The audit event names its session by foreign key, so the session is real too.
        const sessionId = randomUUID();
        await persistent.sessions.insert({
          id: sessionId,
          accountId: account.record.id,
          tokenHash: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          revokedAt: null,
          revokedReason: null,
        });
        persisted[role] = {
          accountId: account.record.id,
          username: account.record.username,
          normalizedEmail: null,
          role,
          sessionId,
          sessionToken: 'b'.repeat(43),
        };
      }
      expect(await kindOf(selectStory(persistentRuntime, persisted.judge, input))).toBe(
        'authorization',
      );
      const first = await selectStory(persistentRuntime, persisted.editor, input);
      expect(first.revision).toBe(1);
      const second = await selectStory(persistentRuntime, persisted.admin, {
        ...input,
        state: 'unselected',
        note: 'next week',
      });
      expect(second.revision).toBe(2);
      const after = await weekTable(
        persistentRuntime,
        persisted.editor,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      const decided = after.rows.find((r) => r.incidentId === row?.incidentId);
      expect(decided?.selection).toMatchObject({
        state: 'unselected',
        revision: 2,
        note: 'next week',
      });
      expect(decided?.selection?.by).toBe(persisted.admin.username);
      // A judge reads the state but never the note.
      const judgeView = await weekTable(
        persistentRuntime,
        persisted.judge,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(judgeView.rows.find((r) => r.incidentId === row?.incidentId)?.selection).toMatchObject(
        { state: 'unselected', note: null },
      );
      // Wrong identifiers are refused before anything is written.
      expect(
        await kindOf(
          selectStory(persistentRuntime, persisted.editor, { ...input, incidentId: randomUUID() }),
        ),
      ).toBe('not_found');
      expect(
        await kindOf(
          selectStory(persistentRuntime, persisted.editor, {
            ...input,
            clusteringRunId: seeded.clusteringRunId,
          }),
        ),
      ).toBe('not_found');
      expect(
        await kindOf(
          selectStory(persistentRuntime, persisted.editor, { ...input, state: 'maybe' }),
        ),
      ).toBe('validation');
      // The machine tables are untouched by selection.
      expect(await fingerprint()).toBe(machineBefore);
    });
  });
});
