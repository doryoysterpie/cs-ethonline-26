import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openMigratedSchema, type IsolatedSchema } from '../../test/isolated-schema.ts';
import {
  HOSTILE_TITLE,
  seedPipeline,
  seedQueueRow,
  seedLargeWeek,
  seedWeek,
  type SeededPipeline,
} from '../../test/seed-pipeline.ts';
import { insertSynthetic, syntheticAccount } from '../../test/synthetic-accounts.ts';
import { openMemoryStores } from '../auth/memory-store.ts';
import { openPostgresStores } from '../auth/postgres-store.ts';
import {
  MAX_MARKDOWN_CHARACTERS as ARTICLE_MARKDOWN_CHARACTERS,
  worstCaseMicrodollars as articleWorstCase,
} from '@cas/article';
import { recordedTransport, sectionOf, loadTemplate, MAX_MARKDOWN_CHARACTERS } from '@cas/roundup';
import { recordedTransport as recordedPages, type RawTransport } from '@cas/source-reader';
import { ReadingCache } from './readings.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { isDashboardError } from '../errors.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import {
  decideEvidence,
  generateArticle,
  generateRoundup,
  MAX_ARTICLE_CHARACTERS,
  MAX_DRAFT_REVISIONS,
  MAX_QUEUE_DECISIONS_PER_ENTRY,
  MAX_ROUNDUP_CHARACTERS,
  mergeIncidentsAction,
  readArticleSources,
  reviewQueueEntry,
  saveArticleRevision,
  saveDraftRevision,
  saveRoundupRevision,
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
  articleView,
  reviewQueue,
  roundupView,
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
      expect(judge.canSearch).toBe(false);
      expect(editor.canSearch).toBe(true);
      expect(judge.rows.length).toBe(editor.rows.length);
      expect(judge.rows.every((row) => row.title === null)).toBe(true);
      // A judge's result set cannot vary with a hidden title: a search is
      // refused with a fixed code before any query (review F1).
      for (const term of ['harborline', 'brightwater', 'zzzz-no-such-title']) {
        expect(
          await kindOf(
            weekTable(runtime, principals.judge, week.weekRunId, 'cyberattack', term, undefined),
          ),
        ).toBe('validation');
      }
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
      // The refusal is audited with its fixed code and no content (review F4).
      const refusals = (await persistent.audit.list(50)).filter(
        (event) => event.kind === 'story_selected' && event.outcome === 'failure',
      );
      expect(
        refusals.some(
          (event) =>
            event.actorAccountId === persisted.judge.accountId && event.code === 'select:stories',
        ),
      ).toBe(true);
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
      const audited = (await persistent.audit.list(50)).filter(
        (event) =>
          event.kind === 'story_selected' &&
          event.outcome === 'failure' &&
          event.actorAccountId === persisted.editor.accountId,
      );
      expect(audited.map((event) => event.code).sort()).toEqual(
        ['clustering_run_not_in_week', 'incident_not_found', 'state_invalid'].sort(),
      );
      // The machine tables are untouched by selection.
      expect(await fingerprint()).toBe(machineBefore);
    });
  });

  async function persistentRuntime(
    model: ReturnType<typeof recordedTransport> | null,
    schema: IsolatedSchema = isolated,
    reader: RawTransport | null = null,
  ) {
    const persistent = openPostgresStores(schema.db);
    const rt = createRuntime(
      {
        environment: 'local',
        accountStore: 'memory',
        memorySeedPath: null,
        databaseSchema: schema.name,
        trustForwardedFor: false,
        trustedProxyHops: 1,
      },
      persistent,
      schema.db,
      {
        model,
        reader:
          reader === null
            ? null
            : {
                transport: reader,
                resolver: { resolve: async () => ['93.184.216.34'] },
                userAgent: 'LatestInCyber/0.1 (+https://dashboard.example.org)',
              },
        readings: new ReadingCache(),
      },
    );
    const persisted = {} as Record<Role, Principal>;
    for (const role of ROLES) {
      const account = await syntheticAccount(role);
      await insertSynthetic(persistent, account);
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
        sessionToken: 'c'.repeat(43),
      };
    }
    return { rt, persisted, persistent };
  }

  describe('the round-up (CAS-004)', () => {
    it('holds the stored rendering bound equal across the package and the layer (the migration refuses the 400,001st character)', () => {
      expect([MAX_MARKDOWN_CHARACTERS, MAX_ROUNDUP_CHARACTERS]).toEqual([400_000, 400_000]);
    });
    /** A model answer that reformats the selection exactly as the contract demands: the rundown and the marker. */
    function goldenFor(snapshot: {
      incidents: readonly { rows: readonly { url: string; sourceRowId: string }[] }[];
      extras: string;
    }) {
      return {
        rundown: snapshot.incidents.map((incident, i) => ({
          headline: `Reformatted Headline ${i + 1}`,
          summary:
            'Brace yourself: the organization named in the sources saw its systems disrupted.',
          sources: incident.rows.map((row) => row.url),
          citations: incident.rows.map((row) => row.sourceRowId),
        })),
        extras: snapshot.extras,
      };
    }

    it('generates for the owner only, records both revisions, the ledger and the audit events, and refuses a second generation', async () => {
      const week = await seedWeek(isolated.db);
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      // The transport sees the request and answers from it, so its sources and
      // citations are exactly the selection's.
      type Seen = {
        incidents: { rows: { url: string; sourceRowId: string }[] }[];
        extras: string;
      };
      const captured: { request: Seen | null } = { request: null };
      const transport = {
        async generate(request: {
          system: string;
          user: string;
          model: string;
          maxOutputTokens: number;
        }) {
          const seen = JSON.parse(request.user) as Seen;
          captured.request = seen;
          expect(request.model).toBe('claude-opus-5-5');
          expect(request.maxOutputTokens).toBe(16_000);
          // The private note of the omitted incident never crosses (review F1):
          // the exact note is absent from the whole request, and the request
          // carries no flagged section at all.
          expect(`${request.system}\n${request.user}`).not.toContain('not this week');
          expect(Object.keys(seen)).toEqual([
            'weekRunId',
            'category',
            'window',
            'incidents',
            'extras',
          ]);
          return {
            raw: goldenFor(seen),
            usage: { inputTokens: 900, outputTokens: 300 },
            model: request.model,
          };
        },
      };
      const { rt, persisted, persistent } = await persistentRuntime(transport);
      // Select the first two incidents; set one aside with a note (the omitted entry).
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      const [first, second, third] = table.rows;
      expect(first && second).toBeTruthy();
      for (const row of [first, second]) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: row?.incidentId ?? '',
          state: 'selected',
          note: null,
        });
      }
      if (third !== undefined) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: third.incidentId,
          state: 'unselected',
          note: 'not this week',
        });
      }
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      };
      for (const role of ['judge', 'editor', 'admin'] as const) {
        expect(await kindOf(generateRoundup(rt, persisted[role], input))).toBe('authorization');
      }
      const before = await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(before).toMatchObject({
        canGenerate: true,
        canEdit: false,
        modelConfigured: true,
        revisions: [],
        latest: null,
        selectedIncidents: 2,
      });
      const generated = await generateRoundup(rt, persisted.owner, input);
      expect(generated).toMatchObject({
        revision: 1,
        inputTokens: 900,
        outputTokens: 300,
        costMicrodollars: 900 * 4 + 300 * 20,
      });
      expect(captured.request?.incidents).toHaveLength(2);
      expect(captured.request?.extras).toBe(marker);
      // The omitted incident and its note are in the stored flagged section of
      // every revision, from records (F1), and were never in the request.
      if (third !== undefined) {
        const stored = await isolated.db.withClient((c) =>
          c.query<{ flagged: { reason: string; disposition: string }[] }>(
            `SELECT slots->'flagged' AS flagged FROM roundup_revisions
              WHERE week_run_id = $1 AND category = 'cyberattack' ORDER BY revision`,
            [week.weekRunId],
          ),
        );
        expect(stored.rows).toHaveLength(2);
        for (const revision of stored.rows) {
          expect(
            revision.flagged.some((f) => f.reason === 'not this week' && f.disposition === 'omit'),
          ).toBe(true);
        }
      }
      const after = await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(after.revisions.map((r) => [r.revision, r.kind])).toEqual([
        [0, 'deterministic'],
        [1, 'generated'],
      ]);
      expect(after.revisions[1]?.provenance).toMatchObject({
        model: 'claude-opus-5-5',
        inputTokens: 900,
        outputTokens: 300,
        costMicrodollars: 9_600,
        templateVersion: 'rundown-template@1',
      });
      expect(after.latest?.revision).toBe(1);
      expect(after.latest?.markdown).toContain('**Reformatted Headline 1**');
      expect(after.canGenerate).toBe(false);
      expect(after.canEdit).toBe(true);
      expect(after.spendThisMonthMicrodollars).toBe(9_600);
      // The ledger and the audit log carry counts and codes, never content.
      const ledger = await isolated.db.withClient((c) =>
        c.query<{ outcome: string; cost: string }>(
          `SELECT outcome, cost_microdollars::text AS cost FROM model_calls WHERE week_run_id = $1`,
          [week.weekRunId],
        ),
      );
      expect(ledger.rows).toEqual([{ outcome: 'completed', cost: '9600' }]);
      const events = (await persistent.audit.list(100)).filter((e) =>
        e.kind.startsWith('roundup_'),
      );
      expect(events.map((e) => e.kind).sort()).toEqual([
        'roundup_completed',
        'roundup_refused',
        'roundup_refused',
        'roundup_refused',
        'roundup_requested',
      ]);
      // The three non-owner refusals are audited at the boundary with the
      // capability as the code and the week as the subject, never content.
      const refusedAtBoundary = events.filter((e) => e.kind === 'roundup_refused');
      expect(refusedAtBoundary.every((e) => e.outcome === 'failure')).toBe(true);
      expect(refusedAtBoundary.map((e) => e.code)).toEqual([
        'generate:roundup',
        'generate:roundup',
        'generate:roundup',
      ]);
      expect(refusedAtBoundary.every((e) => e.subjectId === week.weekRunId)).toBe(true);
      expect(refusedAtBoundary.map((e) => e.actorAccountId).sort()).toEqual(
        [persisted.judge, persisted.editor, persisted.admin].map((p) => p.accountId).sort(),
      );
      expect(events.find((e) => e.kind === 'roundup_completed')?.code).toBe(
        'cost_9600_in_900_out_300',
      );
      expect(events.every((e) => !e.code.includes('Headline'))).toBe(true);
      // One generation per week and category; the owner edits instead. That
      // refusal is audited too.
      expect(await kindOf(generateRoundup(rt, persisted.owner, input))).toBe('validation');
      const again = (await persistent.audit.list(100)).filter(
        (e) => e.kind === 'roundup_refused' && e.code === 'roundup_already_generated',
      );
      expect(again).toHaveLength(1);
      expect(again[0]?.actorAccountId).toBe(persisted.owner.accountId);
      // A judge reads nothing here; an editor reads the page but cannot edit.
      expect(await kindOf(roundupView(rt, persisted.judge, week.weekRunId, 'cyberattack'))).toBe(
        'authorization',
      );
      expect((await roundupView(rt, persisted.editor, week.weekRunId, 'cyberattack')).canEdit).toBe(
        false,
      );
    });

    it('fails closed without a credential, refuses over the cap and on a template hash mismatch, and writes nothing', async () => {
      // Its own schema: the ledger is append-only, so the cap row written here must
      // not outlive the test.
      const own = await openMigratedSchema();
      const week = await seedWeek(own.db);
      const loaded = await loadTemplate();
      const { rt: noModel, persisted } = await persistentRuntime(null, own);
      const table = await weekTable(
        noModel,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      const row = table.rows[0];
      await selectStory(noModel, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: row?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      };
      let caught: unknown;
      try {
        await generateRoundup(noModel, persisted.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(
        isDashboardError(caught) &&
          caught.kind === 'unavailable' &&
          caught.code === 'model_key_missing',
      ).toBe(true);
      expect(
        (await roundupView(noModel, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
      // A transport that must not be reached when the cap or the template refuses.
      let calls = 0;
      const counting = {
        async generate() {
          calls += 1;
          throw new Error('must not be called');
        },
      };
      const {
        rt: withModel,
        persisted: owners,
        persistent: withModelStores,
      } = await persistentRuntime(counting, own);
      expect(
        await kindOf(
          generateRoundup(withModel, owners.owner, {
            ...input,
            expectedTemplateHash: 'f'.repeat(64),
          }),
        ),
      ).toBe('validation');
      await own.db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO model_calls (id, kind, week_run_id, category, model, input_tokens, output_tokens, cost_microdollars, outcome, code, actor_account_id, created_at)
           VALUES ($1, 'roundup', $2, 'cyberattack', 'claude-opus-5-5', 1, 1, 25000000, 'completed', 'completed', $3, now())`,
          [randomUUID(), week.weekRunId, owners.owner.accountId],
        ),
      );
      expect(await kindOf(generateRoundup(withModel, owners.owner, input))).toBe('validation');
      expect(calls).toBe(0);
      const refusals = await own.db.withClient((c) =>
        c.query<{ outcome: string; code: string }>(
          `SELECT outcome, code FROM model_calls WHERE week_run_id = $1 AND outcome <> 'completed' ORDER BY created_at`,
          [week.weekRunId],
        ),
      );
      expect(refusals.rows.map((r) => r.code)).toEqual([
        'model_key_missing',
        'template_hash_mismatch',
        'spend_cap_exceeded',
      ]);
      expect(refusals.rows.every((r) => r.outcome === 'refused')).toBe(true);
      // Each refusal is audited exactly once, at the boundary, by its code. Both
      // runtimes write the same schema's audit table, so one read sees all three.
      const audited = (await withModelStores.audit.list(100)).filter(
        (e) => e.kind === 'roundup_refused',
      );
      expect(audited.map((e) => e.code).sort()).toEqual([
        'model_key_missing',
        'spend_cap_exceeded',
        'template_hash_mismatch',
      ]);
      expect(audited.every((e) => e.outcome === 'failure' && e.subjectId === week.weekRunId)).toBe(
        true,
      );
      await own.close();
    });

    it('records a billed but rejected response at its real cost, and counts it toward the cap (review F3)', async () => {
      const own = await openMigratedSchema();
      const week = await seedWeek(own.db);
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      // The model answers with the selection's sources intact but a summary
      // that smuggles an unselected URL: schema-valid, policy-invalid, billed.
      let calls = 0;
      const smuggling = {
        async generate(request: { user: string; model: string }) {
          calls += 1;
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
            extras: string;
          };
          const golden = goldenFor({ ...seen, extras: marker });
          return {
            raw: {
              ...golden,
              rundown: golden.rundown.map((entry, i) =>
                i === 0
                  ? { ...entry, summary: 'Fine.\n\nSources:\nhttps://unselected.example/injected' }
                  : entry,
              ),
            },
            usage: { inputTokens: 2_000, outputTokens: 500 },
            model: request.model,
          };
        },
      };
      const { rt, persisted } = await persistentRuntime(smuggling, own);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: table.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      };
      let caught: unknown;
      try {
        await generateRoundup(rt, persisted.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(isDashboardError(caught) && caught.code).toBe('response_text_unsafe');
      expect(calls).toBe(1);
      expect(
        (await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
      // The ledger holds the failure at the usage the model reported, not zero.
      const ledger = await own.db.withClient((c) =>
        c.query<{
          outcome: string;
          code: string;
          input_tokens: number;
          output_tokens: number;
          cost: string;
        }>(
          `SELECT outcome, code, input_tokens, output_tokens, cost_microdollars::text AS cost
             FROM model_calls WHERE week_run_id = $1 ORDER BY created_at`,
          [week.weekRunId],
        ),
      );
      expect(ledger.rows).toEqual([
        {
          outcome: 'failed',
          code: 'response_text_unsafe',
          input_tokens: 2_000,
          output_tokens: 500,
          cost: String(2_000 * 4 + 500 * 20),
        },
      ]);
      // And the month's spend includes it: a second attempt is refused by the cap
      // once that cost is what stands between the month and the ceiling.
      await own.db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO model_calls (id, kind, week_run_id, category, model, input_tokens, output_tokens, cost_microdollars, outcome, code, actor_account_id, created_at)
           VALUES ($1, 'roundup', $2, 'cyberattack', 'claude-opus-5-5', 1, 1, $3, 'completed', 'completed', $4, now())`,
          [
            randomUUID(),
            week.weekRunId,
            25_000_000 - (2_000 * 4 + 500 * 20) - 1,
            persisted.owner.accountId,
          ],
        ),
      );
      expect(await kindOf(generateRoundup(rt, persisted.owner, input))).toBe('validation');
      expect(calls).toBe(1);
      await own.close();
    });

    it('records a provider refusal after an answer at its real cost (re-review RR1)', async () => {
      const own = await openMigratedSchema();
      const week = await seedWeek(own.db);
      const loaded = await loadTemplate();
      const refusing = {
        async generate() {
          throw Object.assign(new Error('declined'), {
            code: 'model_refused',
            billed: { model: 'claude-opus-5-5', inputTokens: 1_500, outputTokens: 40 },
          });
        },
      };
      const { rt, persisted } = await persistentRuntime(refusing, own);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: table.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      expect(
        await kindOf(
          generateRoundup(rt, persisted.owner, {
            weekRunId: week.weekRunId,
            category: 'cyberattack',
            expectedTemplateHash: loaded.hash,
          }),
        ),
      ).toBe('unavailable');
      const ledger = await own.db.withClient((c) =>
        c.query<{
          outcome: string;
          code: string;
          input_tokens: number;
          output_tokens: number;
          cost: string;
        }>(
          `SELECT outcome, code, input_tokens, output_tokens, cost_microdollars::text AS cost FROM model_calls WHERE week_run_id = $1`,
          [week.weekRunId],
        ),
      );
      expect(ledger.rows).toEqual([
        {
          outcome: 'failed',
          code: 'model_refused',
          input_tokens: 1_500,
          output_tokens: 40,
          cost: String(1_500 * 4 + 40 * 20),
        },
      ]);
      await own.close();
    });

    it('serialises concurrent generations: two submissions make exactly one model request (review F4)', async () => {
      const own = await openMigratedSchema();
      const week = await seedWeek(own.db);
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      let calls = 0;
      const slow = {
        async generate(request: { user: string; model: string }) {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
            extras: string;
          };
          return {
            raw: goldenFor({ ...seen, extras: marker }),
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      };
      const { rt, persisted } = await persistentRuntime(slow, own);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: table.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      };
      // Pool-sized and larger concurrency (re-review RR2): the test runtime's
      // pool holds four connections; five submissions at once make one
      // request, the rest are refused at once, and nothing waits.
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => kindOf(generateRoundup(rt, persisted.owner, input))),
      );
      expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
      expect(
        outcomes.every((o) => o === 'succeeded' || o === 'conflict' || o === 'validation'),
      ).toBe(true);
      expect(calls).toBe(1);
      const ledger = await own.db.withClient((c) =>
        c.query<{ outcome: string }>(`SELECT outcome FROM model_calls WHERE week_run_id = $1`, [
          week.weekRunId,
        ]),
      );
      expect(ledger.rows.map((r) => r.outcome)).toEqual(['completed']);
      expect(
        (await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toHaveLength(2);
      await own.close();
    });

    it('refuses a selection past the row bound whole, never a prefix, and accepts one at the bound (review F5)', async () => {
      const own = await openMigratedSchema();
      // 201 incidents of 50 rows: 10,050 selected rows, whose first 10,000 would
      // pass the input bounds (200 incidents, 50 rows each) as a silent prefix.
      const week = await seedLargeWeek(own.db, 201, 50);
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      let calls = 0;
      const transport = {
        async generate(request: { user: string; model: string }) {
          calls += 1;
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
            extras: string;
          };
          return {
            raw: goldenFor({ ...seen, extras: marker }),
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      };
      const { rt, persisted } = await persistentRuntime(transport, own);
      const incidents = await own.db.withClient((c) =>
        c.query<{ id: string; member_count: number }>(
          `SELECT id, member_count FROM incident_clusters WHERE clustering_run_id = $1 ORDER BY created_at, id`,
          [week.clusteringRunId],
        ),
      );
      expect(incidents.rows).toHaveLength(201);
      expect(incidents.rows.every((row) => row.member_count === 50)).toBe(true);
      for (const incident of incidents.rows) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: incident.id,
          state: 'selected',
          note: null,
        });
      }
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      };
      let caught: unknown;
      try {
        await generateRoundup(rt, persisted.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(isDashboardError(caught) && `${caught.kind}:${caught.code}`).toBe(
        'validation:selection_too_large',
      );
      expect(calls).toBe(0);
      expect(
        (await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
      // Set one incident aside: exactly 10,000 rows, the bound inclusive, every row kept.
      const last = incidents.rows[200];
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: last?.id ?? '',
        state: 'unselected',
        note: null,
      });
      const result = await generateRoundup(rt, persisted.owner, input);
      expect(result.revision).toBe(1);
      expect(calls).toBe(1);
      const stored = await own.db.withClient((c) =>
        c.query<{ entries: string; sources: string }>(
          `SELECT jsonb_array_length(slots->'rundown')::text AS entries,
                    (SELECT count(*) FROM jsonb_array_elements(slots->'rundown') e, jsonb_array_elements(e->'sources'))::text AS sources
               FROM roundup_revisions WHERE week_run_id = $1 AND revision = 1`,
          [week.weekRunId],
        ),
      );
      expect(stored.rows[0]).toEqual({ entries: '200', sources: '10000' });
      // The upper-bound revision is editable: a small edit above the draft
      // editor's 200,000 characters saves as revision 2 (re-review RR3).
      const generated = await own.db.withClient((c) =>
        c.query<{ markdown: string }>(
          `SELECT markdown FROM roundup_revisions WHERE week_run_id = $1 AND revision = 1`,
          [week.weekRunId],
        ),
      );
      const markdown = generated.rows[0]?.markdown ?? '';
      expect(markdown.length).toBeGreaterThan(200_000);
      const saved = await saveRoundupRevision(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedRevision: 1,
        markdown: `${markdown}\nEdited by the owner.\n`,
      });
      expect(saved.revision).toBe(2);
      await own.close();
    }, 180_000);

    it('flags every carried incident, past the sift table’s page, and refuses past the flagged bound (re-review RR4)', async () => {
      const own = await openMigratedSchema();
      // 1,003 incidents of one row: three posted before the window and first seen
      // inside it (carried), which the sift table's page of 1,000 newest would drop.
      const week = await seedLargeWeek(own.db, 1_003, 1, { carriedGroups: 3 });
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      const transport = {
        async generate(request: { user: string; model: string }) {
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
            extras: string;
          };
          return {
            raw: goldenFor({ ...seen, extras: marker }),
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      };
      const { rt, persisted } = await persistentRuntime(transport, own);
      const newest = await own.db.withClient((c) =>
        c.query<{ id: string }>(
          `SELECT c.id FROM incident_clusters c JOIN source_rows s ON s.id = c.representative_source_row_id
              WHERE c.clustering_run_id = $1 ORDER BY s.posted_at DESC LIMIT 1`,
          [week.clusteringRunId],
        ),
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: newest.rows[0]?.id ?? '',
        state: 'selected',
        note: null,
      });
      const result = await generateRoundup(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      });
      expect(result.revision).toBe(1);
      const stored = await own.db.withClient((c) =>
        c.query<{ carried: string }>(
          `SELECT (SELECT count(*) FROM jsonb_array_elements(slots->'flagged') f WHERE f->>'disposition' = 'carry')::text AS carried
               FROM roundup_revisions WHERE week_run_id = $1 AND revision = 1`,
          [week.weekRunId],
        ),
      );
      expect(stored.rows[0]?.carried).toBe('3');
      await own.close();
    }, 180_000);

    it('lets the owner edit as the next revision under the expected one, and refuses everyone else', async () => {
      const week = await seedWeek(isolated.db);
      const loaded = await loadTemplate();
      const transport = {
        async generate(request: { user: string; model: string }) {
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
            extras: string;
          };
          return {
            raw: goldenFor(seen),
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      };
      const { rt, persisted, persistent } = await persistentRuntime(transport);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: table.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      await generateRoundup(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      });
      const edit = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedRevision: 1,
        markdown: '## Rundown\n\n**Edited**\n\nThe owner rewrote this.\n',
      };
      for (const role of ['judge', 'editor', 'admin'] as const) {
        expect(await kindOf(saveRoundupRevision(rt, persisted[role], edit))).toBe('authorization');
      }
      expect(await saveRoundupRevision(rt, persisted.owner, edit)).toEqual({ revision: 2 });
      expect(await kindOf(saveRoundupRevision(rt, persisted.owner, edit))).toBe('conflict');
      expect(
        await kindOf(
          saveRoundupRevision(rt, persisted.owner, {
            ...edit,
            expectedRevision: 2,
            markdown: 'x\u0000y',
          }),
        ),
      ).toBe('validation');
      const view = await roundupView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(view.latest).toEqual({ revision: 2, markdown: edit.markdown });
      expect(view.revisions.map((r) => r.kind)).toEqual(['deterministic', 'generated', 'edited']);
      expect(view.revisions[2]?.savedBy).toBe(persisted.owner.username);
      // Three authorization refusals, one conflict, one validation refusal and
      // one success, each audited once with its code and no content.
      const edits = (await persistent.audit.list(100)).filter((e) => e.kind === 'roundup_edited');
      expect(edits.map((e) => `${e.outcome}:${e.code}`).sort()).toEqual([
        'failure:edit:output',
        'failure:edit:output',
        'failure:edit:output',
        'failure:markdown_control',
        'failure:roundup_revision_conflict',
        'success:revision_2',
      ]);
      expect(edits.every((e) => e.subjectId === week.weekRunId)).toBe(true);
      expect(edits.every((e) => !e.code.includes('Edited'))).toBe(true);
    });
  });

  describe('the article (CAS-005)', () => {
    const HOST = 'seed.example.org';
    const page = (body: string) =>
      `<html><head><title>t</title></head><body><article><p>${body}</p></article></body></html>`;
    const TEXT_A =
      'Harborline Port said terminal systems were encrypted overnight and that trucks were turned away at the gate while crews worked to restore operations.';
    const TEXT_B =
      'The port confirmed the ransomware intrusion to its terminal systems on Tuesday and said it had notified the provincial regulator and its insurers.';

    /** Pages for the seeded rows: a is read, b is read, c is disallowed by robots.txt. */
    function pagesFor(batchId: string): RawTransport & { readonly calls: readonly string[] } {
      return recordedPages({
        [`https://${HOST}/robots.txt`]: {
          headers: { 'content-type': 'text/plain' },
          body: `User-agent: LatestInCyber\nDisallow: /${batchId}/c`,
        },
        [`https://${HOST}/${batchId}/a`]: { body: page(TEXT_A) },
        [`https://${HOST}/${batchId}/b`]: { body: page(TEXT_B) },
        [`https://${HOST}/${batchId}/c`]: { body: page('never fetched') },
      });
    }

    const filler = (sentences: number): string =>
      Array.from(
        { length: sentences },
        (_, i) => `The port reported detail number ${i + 1} of the incident.`,
      ).join(' ');

    /** A model answer in the contract, built from the request it is given. */
    function goldenFor(user: string) {
      const input = JSON.parse(user) as {
        incidents: { rows: { sourceRowId: string; reading: { status: string } }[] }[];
      };
      const rows = input.incidents.flatMap((i) => i.rows);
      const read = rows.filter((r) => r.reading.status !== 'not_read').map((r) => r.sourceRowId);
      const notRead = rows.filter((r) => r.reading.status === 'not_read').map((r) => r.sourceRowId);
      const first = read[0] as string;
      const second = read[1] ?? first;
      return {
        headline: 'Harborline Port halts terminal operations after ransomware intrusion',
        standfirst:
          'Harborline Port said on Tuesday that a ransomware intrusion encrypted its terminal systems overnight, turning trucks away at the gate while crews worked to restore operations.',
        paragraphs: [
          {
            section: 'what_happened',
            text: `Harborline Port said terminal systems were encrypted overnight. ${filler(9)}`,
            citations: [first],
          },
          {
            section: 'organization_statement',
            text: `The port confirmed the intrusion to its terminal systems on Tuesday. ${filler(9)}`,
            citations: [second],
          },
          {
            section: 'scale_impact',
            text: `Trucks were turned away at the gate while crews worked. ${filler(9)}`,
            citations: [first],
          },
          {
            section: 'not_confirmed',
            text: `The port did not say who was responsible or when operations would resume. ${filler(9)}`,
            citations: [first, second],
          },
          {
            section: 'next_step',
            text: `The port said it had notified the provincial regulator and its insurers. ${filler(9)}`,
            citations: [second],
          },
        ],
        victimNaming: { named: false, basis: 'none', organization: null, citations: [] },
        notRead,
      };
    }

    const model = () =>
      recordedTransport({ raw: null, usage: { inputTokens: 12_000, outputTokens: 2_000 } });

    it('reads only the selected sources under the policy, shows the reading, writes on confirmation, and audits every step without content', async () => {
      const week = await seedWeek(isolated.db, { host: HOST });
      const pages = pagesFor(week.batchId);
      let userSeen = '';
      const answering = {
        async generate(request: { user: string; model: string; maxOutputTokens: number }) {
          userSeen = request.user;
          expect(request.maxOutputTokens).toBe(32_000);
          return {
            raw: goldenFor(request.user),
            usage: { inputTokens: 12_000, outputTokens: 2_000 },
            model: request.model,
          };
        },
      };
      const { rt, persisted, persistent } = await persistentRuntime(answering, isolated, pages);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      for (const row of table.rows) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: row.incidentId,
          state: 'selected',
          note: null,
        });
      }
      const input = { weekRunId: week.weekRunId, category: 'cyberattack' };
      for (const role of ['judge', 'editor', 'admin'] as const) {
        expect(await kindOf(readArticleSources(rt, persisted[role], input))).toBe('authorization');
      }
      const before = await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(before).toMatchObject({
        canRead: true,
        canGenerate: false,
        canEdit: false,
        reading: null,
        readerConfigured: true,
        modelConfigured: true,
        revisions: [],
      });
      expect(before.selectedSources).toBe(3);
      const reading = await readArticleSources(rt, persisted.owner, input);
      expect(reading).toMatchObject({ read: 2, partlyRead: 0, notRead: 1 });
      // Only the selected URLs and the host's robots.txt were requested; the disallowed page never.
      expect(pages.calls.map((c) => c.split(' ')[1])).toEqual([
        `https://${HOST}/robots.txt`,
        `https://${HOST}/${week.batchId}/a`,
        `https://${HOST}/${week.batchId}/b`,
      ]);
      const shown = await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(shown.reading).toMatchObject({ readingId: reading.readingId, read: 2, partlyRead: 0 });
      expect(shown.reading?.notRead).toEqual([{ publisher: HOST, code: 'robots_disallowed' }]);
      expect(shown.canGenerate).toBe(true);
      // A judge sees nothing; an editor sees the page but no pending reading of someone else's.
      expect(await kindOf(articleView(rt, persisted.judge, week.weekRunId, 'cyberattack'))).toBe(
        'authorization',
      );
      expect(
        (await articleView(rt, persisted.editor, week.weekRunId, 'cyberattack')).reading,
      ).toBeNull();
      // The fetch audit: one event per source, the row as subject, bytes and duration in the code, never a URL.
      const fetched = (await persistent.audit.list(100)).filter((e) => e.kind === 'source_fetched');
      expect(fetched).toHaveLength(3);
      expect(fetched.map((e) => e.outcome).sort()).toEqual(['failure', 'success', 'success']);
      expect(
        fetched.every((e) => /^bytes_\d+_ms_\d+_(?:read|robots_disallowed)$/u.test(e.code)),
      ).toBe(true);
      // The fixed shape above admits no host, path or text; every event names its row.
      expect(fetched.every((e) => e.subjectId !== null)).toBe(true);
      // A bogus or foreign reading identifier is refused; the owner's is accepted once.
      const generation = { ...input, readingId: 'f'.repeat(32) };
      expect(await kindOf(generateArticle(rt, persisted.owner, generation))).toBe('validation');
      for (const role of ['judge', 'editor', 'admin'] as const) {
        expect(
          await kindOf(
            generateArticle(rt, persisted[role], { ...input, readingId: reading.readingId }),
          ),
        ).toBe('authorization');
      }
      const written = await generateArticle(rt, persisted.owner, {
        ...input,
        readingId: reading.readingId,
      });
      expect(written).toMatchObject({
        revision: 1,
        inputTokens: 12_000,
        outputTokens: 2_000,
        costMicrodollars: 12_000 * 4 + 2_000 * 20,
      });
      expect(written.wordCount).toBeGreaterThanOrEqual(450);
      // The model saw the texts read and the not-read row without text.
      const sent = JSON.parse(userSeen) as {
        incidents: { rows: { reading: { status: string; text: string | null } }[] }[];
      };
      const sentRows = sent.incidents.flatMap((i) => i.rows);
      expect(
        sentRows
          .filter((r) => r.reading.status === 'read')
          .map((r) => r.reading.text)
          .sort(),
      ).toEqual([TEXT_A, TEXT_B].sort());
      expect(
        sentRows
          .filter((r) => r.reading.status === 'not_read')
          .every((r) => r.reading.text === null),
      ).toBe(true);
      const after = await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(after.revisions.map((r) => [r.revision, r.kind])).toEqual([[1, 'generated']]);
      expect(after.revisions[0]?.provenance).toMatchObject({
        model: 'claude-opus-5-5',
        promptVersion: 'article-prompt@1',
        namingBasis: 'none',
        sourcesRead: 2,
        sourcesNotRead: 1,
      });
      expect(after.latest?.markdown).toContain('# Harborline Port halts terminal operations');
      expect(after.latest?.markdown).toContain('## Not read');
      expect(after.reading).toBeNull();
      expect(after.canRead).toBe(false);
      expect(after.canEdit).toBe(true);
      expect(after.spendThisMonthMicrodollars).toBe(88_000);
      // The ledger carries the article apart from the round-up.
      const ledger = await isolated.db.withClient((c) =>
        c.query<{ kind: string; outcome: string; cost: string }>(
          `SELECT kind, outcome, cost_microdollars::text AS cost FROM model_calls WHERE week_run_id = $1`,
          [week.weekRunId],
        ),
      );
      expect(ledger.rows).toEqual([{ kind: 'article', outcome: 'completed', cost: '88000' }]);
      // Audit events: requested and completed with counts; the refusals at the boundary by code.
      const events = (await persistent.audit.list(200)).filter((e) =>
        e.kind.startsWith('article_'),
      );
      expect(events.filter((e) => e.kind === 'article_requested')).toHaveLength(1);
      expect(events.find((e) => e.kind === 'article_completed')?.code).toMatch(
        /^cost_88000_in_12000_out_2000_words_\d+$/u,
      );
      expect(
        events
          .filter((e) => e.kind === 'article_refused')
          .map((e) => e.code)
          .sort(),
      ).toEqual([
        'generate:article',
        'generate:article',
        'generate:article',
        'generate:article',
        'generate:article',
        'generate:article',
        'reading_not_found',
      ]);
      expect(events.every((e) => !e.code.includes('Harborline'))).toBe(true);
      // A second article is refused; reading again is refused too.
      expect(
        await kindOf(
          generateArticle(rt, persisted.owner, { ...input, readingId: reading.readingId }),
        ),
      ).toBe('validation');
      expect(await kindOf(readArticleSources(rt, persisted.owner, input))).toBe('validation');
      // The owner edits as revision 2 under the expected one; others are refused.
      const edit = {
        ...input,
        expectedRevision: 1,
        markdown: '# Edited\n\nThe owner rewrote this.\n',
      };
      for (const role of ['judge', 'editor', 'admin'] as const) {
        expect(await kindOf(saveArticleRevision(rt, persisted[role], edit))).toBe('authorization');
      }
      expect(await saveArticleRevision(rt, persisted.owner, edit)).toEqual({ revision: 2 });
      expect(await kindOf(saveArticleRevision(rt, persisted.owner, edit))).toBe('conflict');
      const edits = (await persistent.audit.list(200)).filter((e) => e.kind === 'article_edited');
      expect(edits.map((e) => `${e.outcome}:${e.code}`).sort()).toEqual([
        'failure:article_revision_conflict',
        'failure:edit:output',
        'failure:edit:output',
        'failure:edit:output',
        'success:revision_2',
      ]);
    });

    it('refuses reserved names at the boundary, fails closed without a credential or a reader, and writes nothing', async () => {
      // The default seed's host is a reserved name (R3): every source is not read, and there is nothing to write from.
      const week = await seedWeek(isolated.db);
      const pages = recordedPages({});
      const { rt, persisted, persistent } = await persistentRuntime(model(), isolated, pages);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: table.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      const input = { weekRunId: week.weekRunId, category: 'cyberattack' };
      const reading = await readArticleSources(rt, persisted.owner, input);
      expect(reading.read + reading.partlyRead).toBe(0);
      expect(pages.calls).toEqual([]);
      const fetched = (await persistent.audit.list(200)).filter(
        (e) => e.kind === 'source_fetched' && e.code.endsWith('reserved_name'),
      );
      expect(fetched.length).toBeGreaterThan(0);
      expect(
        await kindOf(
          generateArticle(rt, persisted.owner, { ...input, readingId: reading.readingId }),
        ),
      ).toBe('validation');
      const ledger = await isolated.db.withClient((c) =>
        c.query<{ outcome: string; code: string }>(
          `SELECT outcome, code FROM model_calls WHERE week_run_id = $1`,
          [week.weekRunId],
        ),
      );
      expect(ledger.rows).toEqual([{ outcome: 'refused', code: 'input_empty' }]);
      expect(
        (await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
      // No reader configured: reading fails closed with a fixed code and audits it.
      const { rt: noReader, persisted: owners } = await persistentRuntime(model(), isolated, null);
      let caught: unknown;
      try {
        await readArticleSources(noReader, owners.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(
        isDashboardError(caught) &&
          caught.kind === 'unavailable' &&
          caught.code === 'reader_not_configured',
      ).toBe(true);
      // No credential: the reading works, the generation fails closed before any request, nothing is written.
      const good = await seedWeek(isolated.db, { host: HOST });
      const { rt: noModel, persisted: p2 } = await persistentRuntime(
        null,
        isolated,
        pagesFor(good.batchId),
      );
      const t2 = await weekTable(
        noModel,
        p2.owner,
        good.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      await selectStory(noModel, p2.owner, {
        weekRunId: good.weekRunId,
        clusteringRunId: good.clusteringRunId,
        incidentId: t2.rows[0]?.incidentId ?? '',
        state: 'selected',
        note: null,
      });
      const r2 = await readArticleSources(noModel, p2.owner, {
        weekRunId: good.weekRunId,
        category: 'cyberattack',
      });
      let keyMissing: unknown;
      try {
        await generateArticle(noModel, p2.owner, {
          weekRunId: good.weekRunId,
          category: 'cyberattack',
          readingId: r2.readingId,
        });
      } catch (error) {
        keyMissing = error;
      }
      expect(isDashboardError(keyMissing) && keyMissing.code === 'model_key_missing').toBe(true);
      expect(
        (await articleView(noModel, p2.owner, good.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
    });

    /** A transport answering the contract from the request, counting its calls and recording the prompt's size. */
    function answeringWith(
      usage: { readonly inputTokens: number; readonly outputTokens: number },
      options: {
        readonly delayMs?: number;
        readonly shape?: (slots: ReturnType<typeof goldenFor>) => unknown;
      } = {},
    ) {
      const transport = {
        calls: 0,
        promptCharacters: 0,
        async generate(request: { system: string; user: string; model: string }) {
          transport.calls += 1;
          transport.promptCharacters = request.system.length + request.user.length;
          if (options.delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          }
          const slots = goldenFor(request.user);
          return {
            raw: options.shape === undefined ? slots : options.shape(slots),
            usage,
            model: request.model,
          };
        },
      };
      return transport;
    }

    /** A week on the public-looking host, every story selected and the sources read: ready for one generation. */
    async function readyToWrite(
      answering: Parameters<typeof persistentRuntime>[0],
      schema: IsolatedSchema,
    ) {
      const week = await seedWeek(schema.db, { host: HOST });
      const pages = pagesFor(week.batchId);
      const { rt, persisted } = await persistentRuntime(answering, schema, pages);
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      for (const row of table.rows) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: row.incidentId,
          state: 'selected',
          note: null,
        });
      }
      const reading = await readArticleSources(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
      });
      expect(reading).toMatchObject({ read: 2, partlyRead: 0, notRead: 1 });
      const input = {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        readingId: reading.readingId,
      };
      return { week, rt, persisted, input };
    }

    const ledgerOf = (schema: IsolatedSchema, weekRunId: string) =>
      schema.db.withClient((c) =>
        c.query<{
          outcome: string;
          code: string;
          input_tokens: number;
          output_tokens: number;
          cost: string;
        }>(
          `SELECT outcome, code, input_tokens, output_tokens, cost_microdollars::text AS cost
             FROM model_calls WHERE week_run_id = $1 AND kind = 'article' ORDER BY created_at, id`,
          [weekRunId],
        ),
      );

    it('records a billed but rejected response at its real cost, keeps the reading, and counts the cost toward the cap (the round-up’s review F3)', async () => {
      const own = await openMigratedSchema();
      // The model answers the contract but claims every source was read:
      // schema-valid, policy-invalid, billed.
      const answering = answeringWith(
        { inputTokens: 2_000, outputTokens: 500 },
        { shape: (slots) => ({ ...slots, notRead: [] }) },
      );
      const { rt, persisted, input, week } = await readyToWrite(answering, own);
      let caught: unknown;
      try {
        await generateArticle(rt, persisted.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(isDashboardError(caught) && `${caught.kind}:${caught.code}`).toBe(
        'unavailable:response_not_read_differs',
      );
      expect(answering.calls).toBe(1);
      expect((await ledgerOf(own, week.weekRunId)).rows).toEqual([
        {
          outcome: 'failed',
          code: 'response_not_read_differs',
          input_tokens: 2_000,
          output_tokens: 500,
          cost: String(2_000 * 4 + 500 * 20),
        },
      ]);
      const view = await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(view.revisions).toEqual([]);
      expect(view.reading).not.toBeNull();
      // The failed row counts toward the cap: with a completed row that leaves
      // the month exactly one microdollar short of the ceiling once the failed
      // row is counted, and the worst case to spare when it is not, a second
      // attempt is refused before any request.
      const worstCase = articleWorstCase(answering.promptCharacters);
      await own.db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO model_calls (id, kind, week_run_id, category, model, input_tokens, output_tokens, cost_microdollars, outcome, code, actor_account_id, created_at)
           VALUES ($1, 'article', $2, 'cyberattack', 'claude-opus-5-5', 1, 1, $3, 'completed', 'completed', $4, now())`,
          [
            randomUUID(),
            week.weekRunId,
            25_000_000 - worstCase - (2_000 * 4 + 500 * 20) + 1,
            persisted.owner.accountId,
          ],
        ),
      );
      let capped: unknown;
      try {
        await generateArticle(rt, persisted.owner, input);
      } catch (error) {
        capped = error;
      }
      expect(isDashboardError(capped) && `${capped.kind}:${capped.code}`).toBe(
        'validation:spend_cap_exceeded',
      );
      expect(answering.calls).toBe(1);
      expect((await ledgerOf(own, week.weekRunId)).rows.map((r) => [r.outcome, r.cost])).toEqual([
        ['failed', String(2_000 * 4 + 500 * 20)],
        ['completed', String(25_000_000 - worstCase - (2_000 * 4 + 500 * 20) + 1)],
        ['refused', '0'],
      ]);
      await own.close();
    });

    it('records a provider refusal after an answer at its real cost (the round-up’s re-review RR1)', async () => {
      const own = await openMigratedSchema();
      const refusing = {
        calls: 0,
        async generate() {
          refusing.calls += 1;
          throw Object.assign(new Error('declined'), {
            code: 'model_refused',
            billed: { model: 'claude-opus-5-5', inputTokens: 1_500, outputTokens: 40 },
          });
        },
      };
      const { rt, persisted, input, week } = await readyToWrite(refusing, own);
      expect(await kindOf(generateArticle(rt, persisted.owner, input))).toBe('unavailable');
      expect(refusing.calls).toBe(1);
      expect((await ledgerOf(own, week.weekRunId)).rows).toEqual([
        {
          outcome: 'failed',
          code: 'model_refused',
          input_tokens: 1_500,
          output_tokens: 40,
          cost: String(1_500 * 4 + 40 * 20),
        },
      ]);
      expect(
        (await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions,
      ).toEqual([]);
      await own.close();
    });

    it('serialises concurrent generations: five submissions of one reading make exactly one model request (the round-up’s review F4)', async () => {
      const own = await openMigratedSchema();
      const slow = answeringWith({ inputTokens: 10, outputTokens: 10 }, { delayMs: 150 });
      const { rt, persisted, input, week } = await readyToWrite(slow, own);
      // Pool-sized and larger concurrency: the test runtime's pool holds four
      // connections; five submissions at once make one request, the rest are
      // refused at once with the article's own conflict, and nothing waits.
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, async () => {
          try {
            await generateArticle(rt, persisted.owner, input);
            return 'succeeded';
          } catch (error) {
            if (!isDashboardError(error)) throw error;
            return `${error.kind}:${error.code}`;
          }
        }),
      );
      expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
      expect(
        outcomes.every(
          (o) =>
            o === 'succeeded' ||
            o === 'conflict:article_generation_in_progress' ||
            o === 'validation:article_already_generated' ||
            o === 'validation:reading_not_found',
        ),
        outcomes.join(' '),
      ).toBe(true);
      expect(slow.calls).toBe(1);
      expect((await ledgerOf(own, week.weekRunId)).rows.map((r) => r.outcome)).toEqual([
        'completed',
      ]);
      const view = await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack');
      expect(view.revisions.map((r) => r.revision)).toEqual([1]);
      expect(view.reading).toBeNull();
      await own.close();
    });

    it('holds the editor bound at storage: the package, the layer and migration 0016 agree on 400,000 characters (the round-up’s re-review RR3)', async () => {
      expect([ARTICLE_MARKDOWN_CHARACTERS, MAX_ARTICLE_CHARACTERS]).toEqual([400_000, 400_000]);
      const own = await openMigratedSchema();
      const answering = answeringWith({ inputTokens: 10, outputTokens: 10 });
      const { rt, persisted, input, week } = await readyToWrite(answering, own);
      await generateArticle(rt, persisted.owner, input);
      const edit = { weekRunId: week.weekRunId, category: 'cyberattack', expectedRevision: 1 };
      let tooLong: unknown;
      try {
        await saveArticleRevision(rt, persisted.owner, { ...edit, markdown: 'a'.repeat(400_001) });
      } catch (error) {
        tooLong = error;
      }
      expect(isDashboardError(tooLong) && `${tooLong.kind}:${tooLong.code}`).toBe(
        'validation:markdown_length',
      );
      expect(
        await saveArticleRevision(rt, persisted.owner, { ...edit, markdown: 'a'.repeat(400_000) }),
      ).toEqual({ revision: 2 });
      // Behind the layer's bound, the database refuses the 400,001st character.
      let refused: unknown;
      try {
        await own.db.withTransaction((tx) =>
          tx.query(
            `INSERT INTO article_revisions (week_run_id, category, revision, kind, slots, markdown, saved_by_account_id, created_at)
             SELECT $1, 'cyberattack', 3, 'edited', '{}'::jsonb, repeat('x', 400001), $2, now()`,
            [week.weekRunId, persisted.owner.accountId],
          ),
        );
      } catch (error) {
        refused = error;
      }
      expect((refused as { code?: string } | undefined)?.code).toBe('23514');
      expect(
        (await articleView(rt, persisted.owner, week.weekRunId, 'cyberattack')).revisions.map(
          (r) => r.revision,
        ),
      ).toEqual([1, 2]);
      await own.close();
    });

    it('refuses a selection past the row bound whole before any page is fetched, and reads one at the bound (the round-up’s review F5)', async () => {
      const own = await openMigratedSchema();
      // 201 incidents of 50 rows: 10,050 selected rows, whose first 10,000 would
      // read and generate as a silent prefix. The seed's host is a reserved
      // name, so a reading classifies every source and fetches none.
      const week = await seedLargeWeek(own.db, 201, 50);
      const pages = recordedPages({});
      const { rt, persisted } = await persistentRuntime(model(), own, pages);
      const incidents = await own.db.withClient((c) =>
        c.query<{ id: string }>(
          `SELECT id FROM incident_clusters WHERE clustering_run_id = $1 ORDER BY created_at, id`,
          [week.clusteringRunId],
        ),
      );
      expect(incidents.rows).toHaveLength(201);
      for (const incident of incidents.rows) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: incident.id,
          state: 'selected',
          note: null,
        });
      }
      const input = { weekRunId: week.weekRunId, category: 'cyberattack' };
      let caught: unknown;
      try {
        await readArticleSources(rt, persisted.owner, input);
      } catch (error) {
        caught = error;
      }
      expect(isDashboardError(caught) && `${caught.kind}:${caught.code}`).toBe(
        'validation:selection_too_large',
      );
      expect(pages.calls).toEqual([]);
      expect(
        await kindOf(generateArticle(rt, persisted.owner, { ...input, readingId: 'f'.repeat(32) })),
      ).toBe('validation');
      // One incident set aside: exactly 10,000 rows, the bound inclusive, every row in the reading.
      await selectStory(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        clusteringRunId: week.clusteringRunId,
        incidentId: incidents.rows[200]?.id ?? '',
        state: 'unselected',
        note: null,
      });
      const reading = await readArticleSources(rt, persisted.owner, input);
      expect(reading.read + reading.partlyRead + reading.notRead).toBe(10_000);
      expect(pages.calls).toEqual([]);
      await own.close();
    }, 120_000);
  });
});
