import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORY_CARD_FIELDS } from '@cas/contracts';
import { insertStoryCardImage, type Queryable } from '@cas/database';

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
import { cardImage, cardPage, makeCard } from './cards.ts';
import { ReadingCache } from './readings.ts';
import { shellStatus } from './shell.ts';
import { insertRoundupRevision } from '@cas/database';
import type { EmailMessage } from '../auth/email-provider.ts';
import { WindowLimiter, type Limits } from '../http/limits.ts';
import { signPayload } from '../support/signature.ts';
import type { StripeClient } from '../support/stripe.ts';
import {
  CHECKOUT_ATTEMPT_MINUTES,
  openBillingPortal,
  recordWebhook,
  startCheckout,
  supportView,
} from './support.ts';
import {
  approveSignup,
  denySignup,
  pendingSignups,
  publishedList,
  publishedOutput,
  publishOutput,
  requestSignup,
  unpublishOutput,
  verifySignup,
} from './readers.ts';
import { OTP_LIFETIME_SECONDS } from '../auth/otp.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { DashboardError, isDashboardError } from '../errors.ts';
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
 * What is proven here and nowhere else: a reader receives no source text from
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
        buildCommit: null,
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

  it('withholds source text from a reader and returns it to an editor', async () => {
    const reader = await incidentDetail(
      runtime,
      principals.reader,
      seeded.clusteringRunId,
      seeded.hostileIncidentId,
    );
    expect(reader.members.length).toBeGreaterThan(0);
    for (const member of reader.members) {
      expect(member.title).toBeNull();
      expect(member.publisher).toBeNull();
      expect(member.url).toBeNull();
    }
    expect(reader.canReview).toBe(false);
    expect(JSON.stringify(reader)).not.toContain('<script>');
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
    expect(await kindOf(evidenceView(runtime, principals.reader, randomUUID()))).toBe('not_found');
  });

  it('pages the incident explorer by identifier', async () => {
    const view = await incidentExplorer(runtime, principals.reader, seeded.clusteringRunId, null);
    expect(view.incidents.length).toBe(seeded.incidentIds.length);
    expect(view.incidents.map((incident) => incident.id)).toEqual(seeded.incidentIds);
    expect(
      view.incidents.find((incident) => incident.id === seeded.subjectIncidentId)?.subjectChain,
    ).toBe('ethereum');
    expect(view.reviewRevision).toBe(0);
  });

  it('derives the queue for an editor only, and refuses a decision on a row outside the queue', async () => {
    expect(
      await kindOf(reviewQueue(runtime, principals.reader, seeded.classificationRunId, 0)),
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
      principals.reader,
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
    const reader = await evidenceView(runtime, principals.reader, seeded.evidenceRunId);
    expect(reader.states.length).toBe(seeded.incidentIds.length);
    expect(reader.limitations.length).toBeGreaterThan(0);
    expect(reader.canReview).toBe(false);
    expect(reader.associations.length).toBeGreaterThan(0);
    const association = reader.associations[0];
    if (association === undefined) throw new Error('no association');
    expect(
      await kindOf(
        decideEvidence(runtime, principals.reader, {
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
    const readerAgain = await evidenceView(runtime, principals.reader, seeded.evidenceRunId);
    expect(readerAgain.decisions[0]?.rationale).toBeNull();
    expect(JSON.stringify(readerAgain)).not.toContain('private rationale');
  });

  it('builds the anomaly feed from stored signals with a limitation on every entry', async () => {
    const lastSignalRun = seeded.signalRunIds[seeded.signalRunIds.length - 1] ?? '';
    const view = await anomalyView(runtime, principals.reader, {
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
        anomalyView(runtime, principals.reader, {
          signalRunId: lastSignalRun,
          asOf: AS_OF,
          clusteringRunId: seeded.clusteringRunId,
          windows: [{ startsAt: PERIOD_END, endsAt: PERIOD_START }],
        }),
      ),
    ).toBe('validation');
    const withReporting = await anomalyView(runtime, principals.reader, {
      signalRunId: lastSignalRun,
      asOf: AS_OF,
      clusteringRunId: seeded.clusteringRunId,
      windows: [{ startsAt: PERIOD_START, endsAt: PERIOD_END }],
    });
    expect(withReporting.stats.reportingWindows).toBe(1);
  });

  it('refuses draft preview to a reader entirely, and appends editor revisions with optimistic concurrency', async () => {
    // The owner decision of 2026-09-12 withdraws draft-preview access from
    // the reader role: no headline, no source link, no source text, no
    // editor note and no unsanitized draft content reaches a reader.
    expect(
      await kindOf(
        draftView(runtime, principals.reader, seeded.evidenceRunId, PERIOD_START, PERIOD_END),
      ),
    ).toBe('authorization');
    expect(
      await kindOf(
        saveDraftRevision(runtime, principals.reader, {
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
      const reader = await weekTable(
        runtime,
        principals.reader,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(reader.canSelect).toBe(false);
      expect(reader.canSearch).toBe(false);
      expect(editor.canSearch).toBe(true);
      expect(reader.rows.length).toBe(editor.rows.length);
      expect(reader.rows.every((row) => row.title === null)).toBe(true);
      // A reader's result set cannot vary with a hidden title: a search is
      // refused with a fixed code before any query (review F1).
      for (const term of ['harborline', 'brightwater', 'zzzz-no-such-title']) {
        expect(
          await kindOf(
            weekTable(runtime, principals.reader, week.weekRunId, 'cyberattack', term, undefined),
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

    it('records a selection for an editor with the next revision, refuses a reader, and shows the latest state', async () => {
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
          buildCommit: null,
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
      expect(await kindOf(selectStory(persistentRuntime, persisted.reader, input))).toBe(
        'authorization',
      );
      // The refusal is audited with its fixed code and no content (review F4).
      const refusals = (await persistent.audit.list(50)).filter(
        (event) => event.kind === 'story_selected' && event.outcome === 'failure',
      );
      expect(
        refusals.some(
          (event) =>
            event.actorAccountId === persisted.reader.accountId && event.code === 'select:stories',
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
      // A reader reads the state but never the note.
      const readerView = await weekTable(
        persistentRuntime,
        persisted.reader,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(
        readerView.rows.find((r) => r.incidentId === row?.incidentId)?.selection,
      ).toMatchObject({ state: 'unselected', note: null });
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
    extra: Partial<Parameters<typeof createRuntime>[3]> = {},
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
        buildCommit: null,
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
        ...extra,
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

  describe('the shell status (CAS-010)', () => {
    /** What the database holds now: the schema is shared with the other blocks, which seed weeks and imports of their own. */
    const expected = async () => {
      const week = await isolated.db.withClient((c) =>
        c.query<{ id: string }>(
          `SELECT id FROM week_runs ORDER BY window_end DESC, started_at DESC, id LIMIT 1`,
        ),
      );
      const batch = await isolated.db.withClient((c) =>
        c.query<{ completed_at: string }>(
          `SELECT to_json(completed_at) #>> '{}' AS completed_at FROM import_batches
            WHERE status = 'completed' AND completed_at IS NOT NULL
            ORDER BY completed_at DESC, id DESC LIMIT 1`,
        ),
      );
      return {
        weekId: week.rows[0]?.id ?? null,
        asOf: Date.parse(batch.rows[0]?.completed_at ?? ''),
      };
    };

    it('states the build, the latest week and the last successful import as the data instant, for every role, and refuses nobody signed in', async () => {
      const { rt, persisted } = await persistentRuntime(null, isolated, null);
      const before = await expected();
      for (const role of ROLES) {
        const status = await shellStatus(rt, persisted[role]);
        expect(status.build).toBe('local');
        expect(status.latestWeek?.id ?? null).toBe(before.weekId);
        // The seeded pipeline's import completed: the latest completion is the data instant.
        expect(Date.parse(status.asOf ?? '')).toBe(before.asOf);
      }
      expect(await kindOf(shellStatus(rt, null))).toBe('authentication');
      // A week run, once seeded, is reported when it is the latest by its window.
      await seedWeek(isolated.db);
      const after = await expected();
      const status = await shellStatus(rt, persisted.reader);
      expect(status.latestWeek?.id ?? null).toBe(after.weekId);
      expect(Date.parse(status.asOf ?? '')).toBe(after.asOf);
      expect(JSON.stringify(status)).not.toContain(HOSTILE_TITLE.slice(0, 8));
    });
  });

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
      for (const role of ['reader', 'editor', 'admin'] as const) {
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
        [persisted.reader, persisted.editor, persisted.admin].map((p) => p.accountId).sort(),
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
      // A reader reads nothing here; an editor reads the page but cannot edit.
      expect(await kindOf(roundupView(rt, persisted.reader, week.weekRunId, 'cyberattack'))).toBe(
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
      for (const role of ['reader', 'editor', 'admin'] as const) {
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
      for (const role of ['reader', 'editor', 'admin'] as const) {
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
      // A reader sees nothing; an editor sees the page but no pending reading of someone else's.
      expect(await kindOf(articleView(rt, persisted.reader, week.weekRunId, 'cyberattack'))).toBe(
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
      for (const role of ['reader', 'editor', 'admin'] as const) {
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
      for (const role of ['reader', 'editor', 'admin'] as const) {
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

  describe('readers (CAS-007)', () => {
    const PEPPER = 'p'.repeat(32);
    function mailbox() {
      const sent: EmailMessage[] = [];
      return { sent, provider: { send: async (message: EmailMessage) => void sent.push(message) } };
    }
    const codeIn = (message: EmailMessage | undefined): string =>
      /\b(\d{6})\b/u.exec(message?.text ?? '')?.[1] ?? '';

    it('answers every address the same way, sends a code only where one is due, locks after five wrong codes, and verifies once', async () => {
      const mail = mailbox();
      const { rt, persisted, persistent } = await persistentRuntime(null, isolated, null, {
        emailProvider: mail.provider,
        otpPepper: PEPPER,
        publicUrl: 'https://dashboard.example.org',
      });
      const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
      const fresh = await requestSignup(rt, {
        email: 'New.Reader@Example.org',
        networkKey: 'direct',
      });
      expect(fresh.requestId).toMatch(shape);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe('new.reader@example.org');
      expect(codeIn(mail.sent[0])).toMatch(/^\d{6}$/u);
      // Pending again, an existing account's address, and a malformed address: the same answer, no mail.
      const again = await requestSignup(rt, {
        email: 'new.reader@example.org',
        networkKey: 'direct',
      });
      const malformed = await requestSignup(rt, { email: 'not an address', networkKey: 'direct' });
      for (const answer of [again, malformed]) expect(Object.keys(answer)).toEqual(['requestId']);
      for (const answer of [again, malformed]) expect(answer.requestId).toMatch(shape);
      expect(mail.sent).toHaveLength(1);
      const requested = (await persistent.audit.list(50)).filter(
        (e) => e.kind === 'signup_requested',
      );
      expect(requested.map((e) => e.code).sort()).toEqual(['sent', 'silent', 'silent']);
      expect(requested.every((e) => !/@|example\.org/u.test(JSON.stringify(e)))).toBe(true);
      // Wrong codes: four invalid, the fifth locks; the right code is then refused too.
      const wrong = codeIn(mail.sent[0]) === '000000' ? '000001' : '000000';
      for (let i = 0; i < 4; i += 1) {
        expect(
          await verifySignup(rt, { requestId: fresh.requestId, code: wrong, networkKey: 'direct' }),
        ).toBe('invalid');
      }
      expect(
        await verifySignup(rt, { requestId: fresh.requestId, code: wrong, networkKey: 'direct' }),
      ).toBe('locked');
      expect(
        await verifySignup(rt, {
          requestId: fresh.requestId,
          code: codeIn(mail.sent[0]),
          networkKey: 'direct',
        }),
      ).toBe('locked');
      expect(
        (await persistent.audit.list(50)).filter((e) => e.kind === 'signup_locked'),
      ).toHaveLength(1);
      // A second address verifies once with its code; a bogus identifier answers as expired.
      const second = await requestSignup(rt, { email: 'second@example.org', networkKey: 'direct' });
      expect(
        await verifySignup(rt, {
          requestId: second.requestId,
          code: codeIn(mail.sent[1]),
          networkKey: 'direct',
        }),
      ).toBe('verified');
      expect(
        await verifySignup(rt, {
          requestId: second.requestId,
          code: codeIn(mail.sent[1]),
          networkKey: 'direct',
        }),
      ).toBe('verified');
      expect(
        await verifySignup(rt, { requestId: randomUUID(), code: '123456', networkKey: 'direct' }),
      ).toBe('expired');
      expect(
        await verifySignup(rt, { requestId: 'nonsense', code: '123456', networkKey: 'direct' }),
      ).toBe('expired');
      // The admin sees the verified request and nobody else does.
      for (const role of ['reader', 'editor', 'owner'] as const) {
        expect(await kindOf(pendingSignups(rt, persisted[role]))).toBe('authorization');
      }
      const pending = await pendingSignups(rt, persisted.admin);
      expect(pending.map((p) => [p.requestId, p.email])).toEqual([
        [second.requestId, 'second@example.org'],
      ]);
      // Approval creates a reader with a one-year expiry and sends the fixed text; the request is decided once.
      for (const role of ['reader', 'editor', 'owner'] as const) {
        expect(
          await kindOf(
            approveSignup(rt, persisted[role], { requestId: second.requestId, expiresAt: null }),
          ),
        ).toBe('authorization');
      }
      const approved = await approveSignup(rt, persisted.admin, {
        requestId: second.requestId,
        expiresAt: null,
      });
      const account = await persistent.accounts.getById(approved.accountId);
      expect(account?.role).toBe('reader');
      expect(account?.normalizedEmail).toBe('second@example.org');
      const days = (Date.parse(account?.expiresAt ?? '') - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(364);
      expect(days).toBeLessThan(366);
      expect(mail.sent[2]).toMatchObject({
        to: 'second@example.org',
        subject: 'Your request to read Latest in Cyber was approved',
      });
      expect(mail.sent[2]?.text).toContain(
        'Sign in at https://dashboard.example.org with this address',
      );
      expect(mail.sent[2]?.text).not.toMatch(/https?:\/\/\S*(?:token|code|key)=/u);
      expect(
        await kindOf(
          approveSignup(rt, persisted.admin, { requestId: second.requestId, expiresAt: null }),
        ),
      ).toBe('validation');
      expect(await pendingSignups(rt, persisted.admin)).toEqual([]);
      // The address now holds an account: a request for it answers the same way and sends nothing.
      const existing = await requestSignup(rt, {
        email: 'second@example.org',
        networkKey: 'direct',
      });
      expect(existing.requestId).toMatch(shape);
      expect(mail.sent).toHaveLength(3);
      // Denial of a third verified request: the fixed text, no account.
      const third = await requestSignup(rt, {
        email: 'third@example.org',
        networkKey: 'elsewhere',
      });
      expect(
        await verifySignup(rt, {
          requestId: third.requestId,
          code: codeIn(mail.sent[3]),
          networkKey: 'elsewhere',
        }),
      ).toBe('verified');
      await denySignup(rt, persisted.admin, { requestId: third.requestId });
      expect(mail.sent[4]).toEqual({
        to: 'third@example.org',
        subject: 'Your request to read Latest in Cyber',
        text: 'Your request was not approved.',
      });
      expect(await persistent.accounts.findByNormalizedEmail('third@example.org')).toBeNull();
      expect(await kindOf(denySignup(rt, persisted.admin, { requestId: third.requestId }))).toBe(
        'validation',
      );
      const decisions = (await persistent.audit.list(100)).filter(
        (e) => e.kind === 'signup_approved' || e.kind === 'signup_denied',
      );
      expect(decisions.map((e) => e.kind).sort()).toEqual(['signup_approved', 'signup_denied']);
      expect(
        decisions.every(
          (e) => e.actorAccountId === persisted.admin.accountId && !/@/u.test(JSON.stringify(e)),
        ),
      ).toBe(true);
    });

    it('lets an address ask again once its unverified code expired, and verifies the new code (train review F4)', async () => {
      const mail = mailbox();
      const { rt } = await persistentRuntime(null, isolated, null, {
        emailProvider: mail.provider,
        otpPepper: PEPPER,
        publicUrl: 'https://dashboard.example.org',
      });
      const t0 = new Date('2026-10-23T12:00:00.000Z');
      const later = new Date(t0.getTime() + (OTP_LIFETIME_SECONDS + 1) * 1000);
      const first = await requestSignup(rt, {
        email: 'retry@example.org',
        networkKey: 'direct',
        now: t0,
      });
      expect(mail.sent).toHaveLength(1);
      // Before the expiry the address is held to its open request: silence, no code.
      await requestSignup(rt, { email: 'retry@example.org', networkKey: 'direct', now: t0 });
      expect(mail.sent).toHaveLength(1);
      // Past it, a new request supersedes the stale one and a new code is sent.
      const second = await requestSignup(rt, {
        email: 'retry@example.org',
        networkKey: 'direct',
        now: later,
      });
      expect(second.requestId).not.toBe(first.requestId);
      expect(mail.sent).toHaveLength(2);
      expect(
        await verifySignup(rt, {
          requestId: first.requestId,
          code: codeIn(mail.sent[0]),
          networkKey: 'direct',
          now: later,
        }),
      ).toBe('expired');
      expect(
        await verifySignup(rt, {
          requestId: second.requestId,
          code: codeIn(mail.sent[1]),
          networkKey: 'direct',
          now: later,
        }),
      ).toBe('verified');
    });

    it('approves atomically: a lost race or a failure at any write leaves no account, no decision and no event (train review F5)', async () => {
      const mail = mailbox();
      const own = await openMigratedSchema();
      const { rt, persisted, persistent } = await persistentRuntime(null, own, null, {
        emailProvider: mail.provider,
        otpPepper: PEPPER,
        publicUrl: 'https://dashboard.example.org',
      });
      /** A verified request for a fresh address. */
      const verifiedRequest = async (email: string): Promise<string> => {
        const before = mail.sent.length;
        const { requestId } = await requestSignup(rt, { email, networkKey: 'direct' });
        expect(
          await verifySignup(rt, {
            requestId,
            code: codeIn(mail.sent[before]),
            networkKey: 'direct',
          }),
        ).toBe('verified');
        return requestId;
      };
      const stateOf = async (requestId: string, email: string) => {
        const request = await own.db.withClient((c) =>
          c.query<{ decision: string | null; account_id: string | null }>(
            `SELECT decision, account_id FROM signup_requests WHERE id = $1`,
            [requestId],
          ),
        );
        const account = await persistent.accounts.findByNormalizedEmail(email);
        const events = (await persistent.audit.list(500)).filter(
          (e) =>
            (e.kind === 'signup_approved' && e.subjectId === requestId) ||
            (e.kind === 'account_provisioned' && e.subjectAccountId === account?.id),
        );
        return {
          decision: request.rows[0]?.decision ?? null,
          boundAccount: request.rows[0]?.account_id ?? null,
          account: account?.id ?? null,
          events: events.map((e) => e.kind).sort(),
        };
      };
      // The race: approve and deny together, several times; exactly one decision
      // lands each time, and an account exists exactly when it is the approval.
      for (let round = 0; round < 4; round += 1) {
        const email = `race${round}@example.org`;
        const requestId = await verifiedRequest(email);
        const outcomes = await Promise.allSettled([
          approveSignup(rt, persisted.admin, { requestId, expiresAt: null }),
          denySignup(rt, persisted.admin, { requestId }),
        ]);
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const state = await stateOf(requestId, email);
        if (outcomes[0]?.status === 'fulfilled') {
          expect(state.decision).toBe('approved');
          expect(state.account).not.toBeNull();
          expect(state.boundAccount).toBe(state.account);
          expect(state.events).toEqual(['account_provisioned', 'signup_approved']);
        } else {
          expect(state.decision).toBe('denied');
          expect(state).toMatchObject({ account: null, boundAccount: null, events: [] });
        }
      }
      // A failure at every write of the approval, in turn: the k-th statement of
      // the transaction throws, and nothing of the approval survives it.
      const email = 'fragile@example.org';
      const requestId = await verifiedRequest(email);
      const failingAt = (k: number): Runtime => ({
        ...rt,
        database: {
          schema: own.db.schema,
          withClient: (work: (client: Queryable) => Promise<unknown>) => own.db.withClient(work),
          withTransaction: (work: (tx: Queryable) => Promise<unknown>) =>
            own.db.withTransaction(async (tx) => {
              let count = 0;
              const proxy: Queryable = {
                query: (text, values) => {
                  count += 1;
                  if (count === k)
                    return Promise.reject(new Error(`injected failure at statement ${k}`));
                  return tx.query(text, values);
                },
              } as Queryable;
              return work(proxy);
            }),
        } as unknown as Runtime['database'],
      });
      for (let k = 1; k <= 6; k += 1) {
        let caught: unknown;
        try {
          await approveSignup(failingAt(k), persisted.admin, { requestId, expiresAt: null });
        } catch (error) {
          caught = error;
        }
        expect(caught, `statement ${k}`).toBeDefined();
        expect(await stateOf(requestId, email), `statement ${k}`).toEqual({
          decision: null,
          boundAccount: null,
          account: null,
          events: [],
        });
      }
      // Whole again, the approval lands with every record of it.
      const approved = await approveSignup(rt, persisted.admin, { requestId, expiresAt: null });
      expect(await stateOf(requestId, email)).toEqual({
        decision: 'approved',
        boundAccount: approved.accountId,
        account: approved.accountId,
        events: ['account_provisioned', 'signup_approved'],
      });
      expect(mail.sent.at(-1)).toMatchObject({
        to: email,
        subject: 'Your request to read Latest in Cyber was approved',
      });
      // The memory stores cannot hold the approval in one transaction with the request: refused.
      const { rt: memory, persisted: memoryPrincipals } = await (async () => {
        const stores = await openMemoryStores(null);
        const runtime = createRuntime(
          {
            environment: 'local',
            accountStore: 'memory',
            memorySeedPath: null,
            databaseSchema: own.name,
            trustForwardedFor: false,
            trustedProxyHops: 1,
            buildCommit: null,
          },
          stores,
          own.db,
          { otpPepper: PEPPER, emailProvider: mail.provider },
        );
        const account = await syntheticAccount('admin');
        await insertSynthetic(stores, account);
        const principal: Principal = {
          accountId: account.record.id,
          username: account.record.username,
          normalizedEmail: null,
          role: 'admin',
          sessionId: randomUUID(),
          sessionToken: 'c'.repeat(43),
        };
        return { rt: runtime, persisted: { admin: principal } };
      })();
      const another = await verifiedRequest('memory@example.org');
      expect(
        await kindOf(
          approveSignup(memory, memoryPrincipals.admin, { requestId: another, expiresAt: null }),
        ),
      ).toBe('validation');
      await own.close();
    });

    it('throttles a burst per address and per source with one count-only event each, and limits a reader’s reads', async () => {
      const mail = mailbox();
      const { rt, persisted, persistent } = await persistentRuntime(null, isolated, null, {
        emailProvider: mail.provider,
        otpPepper: PEPPER,
        limits: {
          signupAddress: new WindowLimiter(2, 900),
          signupNetwork: new WindowLimiter(3, 900),
          readerReads: new WindowLimiter(2, 900),
          checkoutAccount: new WindowLimiter(5, 900),
          cardAccount: new WindowLimiter(50, 900),
          cardNetwork: new WindowLimiter(500, 900),
        },
      });
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        await requestSignup(rt, { email: 'burst@example.org', networkKey: `source-${i}` });
        outcomes.push(
          (await persistent.audit.list(5)).find((e) => e.kind === 'signup_requested')?.code ?? '',
        );
      }
      expect(outcomes).toEqual(['sent', 'silent', 'limited', 'limited']);
      let trips = (await persistent.audit.list(100)).filter((e) => e.kind === 'limit_tripped');
      expect(trips.map((e) => e.code)).toEqual(['signup_address']);
      for (let i = 0; i < 4; i += 1) {
        await requestSignup(rt, { email: `n${i}@example.org`, networkKey: 'one-source' });
      }
      trips = (await persistent.audit.list(100)).filter((e) => e.kind === 'limit_tripped');
      expect(trips.map((e) => e.code).sort()).toEqual(['signup_address', 'signup_network']);
      // A reader's third read in the window is refused with the wait; one event for the window.
      await commandCenter(rt, persisted.reader);
      await commandCenter(rt, persisted.reader);
      let caught: unknown;
      try {
        await commandCenter(rt, persisted.reader);
      } catch (error) {
        caught = error;
      }
      expect(
        isDashboardError(caught) &&
          caught.kind === 'throttled' &&
          caught.code === 'reader_read_limit',
      ).toBe(true);
      expect(await kindOf(commandCenter(rt, persisted.reader))).toBe('throttled');
      expect(
        (await persistent.audit.list(100)).filter(
          (e) => e.kind === 'limit_tripped' && e.code === 'reader_reads',
        ),
      ).toHaveLength(1);
      // An editor is not limited.
      await commandCenter(rt, persisted.editor);
      await commandCenter(rt, persisted.editor);
      await commandCenter(rt, persisted.editor);
    });

    it('publishes one revision for readers, by the latest mark, and nothing without it', async () => {
      const week = await seedWeek(isolated.db);
      const { rt, persisted, persistent } = await persistentRuntime(null);
      const at = new Date().toISOString();
      await isolated.db.withTransaction(async (tx) => {
        await insertRoundupRevision(tx, {
          weekRunId: week.weekRunId,
          category: 'cyberattack',
          revision: 0,
          kind: 'deterministic',
          slots: { rundown: [] },
          markdown: '## Rundown\n\n**Revision zero**',
          provenance: null,
          savedByAccountId: persisted.owner.accountId,
          createdAt: at,
        });
      });
      const target = { weekRunId: week.weekRunId, category: 'cyberattack', output: 'roundup' };
      expect(
        await kindOf(
          publishedOutput(rt, persisted.reader, week.weekRunId, 'cyberattack', 'roundup'),
        ),
      ).toBe('not_found');
      expect(await publishedList(rt, persisted.reader)).toEqual([]);
      for (const role of ['reader', 'editor', 'admin'] as const) {
        expect(await kindOf(publishOutput(rt, persisted[role], { ...target, revision: 0 }))).toBe(
          'authorization',
        );
      }
      expect(await kindOf(publishOutput(rt, persisted.owner, { ...target, revision: 7 }))).toBe(
        'validation',
      );
      await publishOutput(rt, persisted.owner, { ...target, revision: 0 });
      const listed = await publishedList(rt, persisted.reader);
      expect(listed.map((e) => [e.output, e.revision, e.category])).toEqual([
        ['roundup', 0, 'cyberattack'],
      ]);
      const page = await publishedOutput(
        rt,
        persisted.reader,
        week.weekRunId,
        'cyberattack',
        'roundup',
      );
      expect(page.markdown).toBe('## Rundown\n\n**Revision zero**');
      expect(Object.keys(page).sort()).toEqual([
        'category',
        'markdown',
        'output',
        'publishedAt',
        'revision',
        'stories',
        'week',
      ]);
      // A deterministic revision's headlines are the sources' own titles: nothing to share (D48, 3).
      expect(page.stories).toEqual([]);
      // Editors and the owner may read the public page; nobody but the owner unmarks it.
      expect(
        (await publishedOutput(rt, persisted.editor, week.weekRunId, 'cyberattack', 'roundup'))
          .revision,
      ).toBe(0);
      expect(await kindOf(unpublishOutput(rt, persisted.admin, target))).toBe('authorization');
      await unpublishOutput(rt, persisted.owner, target);
      expect(
        await kindOf(
          publishedOutput(rt, persisted.reader, week.weekRunId, 'cyberattack', 'roundup'),
        ),
      ).toBe('not_found');
      expect(await kindOf(unpublishOutput(rt, persisted.owner, target))).toBe('validation');
      const marks = (await persistent.audit.list(100)).filter(
        (e) => e.kind === 'output_published' || e.kind === 'output_unpublished',
      );
      expect(marks.map((e) => `${e.kind}:${e.code}`).sort()).toEqual([
        'output_published:roundup_0',
        'output_unpublished:roundup_0',
      ]);
    });
  });

  describe('the supporter tier (CAS-008)', () => {
    const SECRET = 'whsec_' + 's'.repeat(32);
    // One identifier per hand-off across the block, as Stripe would issue.
    let sessions = 0;
    function fakeStripe() {
      const calls: unknown[] = [];
      const client: StripeClient = {
        createCheckoutSession: async (input) => {
          calls.push(input);
          sessions += 1;
          const id = `cs_test_dal${String(sessions).padStart(8, '0')}`;
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
        createPortalSession: async (input) => {
          calls.push(input);
          return { url: 'https://billing.stripe.com/p/session?secret=x' };
        },
      };
      return { calls, client };
    }
    const envelope = (id: string, type: string, created: number, object: Record<string, unknown>) =>
      JSON.stringify({ id, object: 'event', created, livemode: false, type, data: { object } });
    const signed = (body: string, at: number, now: number = at) => ({
      body,
      signatureHeader: `t=${at},v1=${signPayload(SECRET, at, body)}`,
      networkKey: 'direct',
      now: new Date(now * 1000),
    });
    const kindOf = async (call: Promise<unknown>): Promise<string> => {
      try {
        await call;
      } catch (error) {
        return isDashboardError(error) ? `${error.kind}:${error.code}` : 'unexpected';
      }
      return 'succeeded';
    };

    it('hands off once per request, records the session, derives the mark from signed webhooks by event instant, and lets a replay or a forgery change nothing', async () => {
      const stripe = fakeStripe();
      const { rt, persisted, persistent } = await persistentRuntime(null, isolated, null, {
        publicUrl: 'https://dashboard.example.org',
        support: {
          stripe: stripe.client,
          webhookSecret: SECRET,
          priceId: 'price_Test00000001',
          mode: 'test',
        },
      });
      const reader = persisted.reader;
      expect(await supportView(rt, reader)).toEqual({
        configured: true,
        mode: 'test',
        mark: 'none',
        asOf: null,
      });
      const { url } = await startCheckout(rt, reader, { networkKey: 'direct' });
      expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_dal00000001');
      expect(stripe.calls[0]).toMatchObject({
        priceId: 'price_Test00000001',
        accountId: reader.accountId,
        customerId: null,
        customerEmail: null,
        successUrl: 'https://dashboard.example.org/support?notice=checkout_returned',
        cancelUrl: 'https://dashboard.example.org/support?notice=checkout_cancelled',
      });
      expect((stripe.calls[0] as { idempotencyKey: string }).idempotencyKey).toMatch(
        /^[0-9a-f-]{36}$/u,
      );
      // Stripe completes the session, binding the customer and the subscription to the account.
      const t0 = 1_800_000_000;
      const completed = envelope('evt_dal_0000000001', 'checkout.session.completed', t0, {
        id: 'cs_test_dal00000001',
        customer: 'cus_dal00000001',
        subscription: 'sub_dal00000001',
        client_reference_id: reader.accountId,
      });
      expect(await recordWebhook(rt, signed(completed, t0 + 5))).toEqual({
        status: 200,
        code: 'webhook_recorded',
      });
      // The subscription events arrive out of order: the later cancellation first.
      const canceled = envelope('evt_dal_0000000003', 'customer.subscription.deleted', t0 + 200, {
        id: 'sub_dal00000001',
        customer: 'cus_dal00000001',
        status: 'canceled',
      });
      const active = envelope('evt_dal_0000000002', 'customer.subscription.created', t0 + 100, {
        id: 'sub_dal00000001',
        customer: 'cus_dal00000001',
        status: 'active',
      });
      expect((await recordWebhook(rt, signed(canceled, t0 + 210))).code).toBe('webhook_recorded');
      expect((await supportView(rt, reader)).mark).toBe('none');
      expect((await recordWebhook(rt, signed(active, t0 + 220))).code).toBe('webhook_recorded');
      // The activation's own instant precedes the cancellation's: still no supporter.
      expect((await supportView(rt, reader)).mark).toBe('none');
      // A replay, a forgery, a stale signature and a malformed body change nothing.
      expect(await recordWebhook(rt, signed(active, t0 + 230))).toEqual({
        status: 200,
        code: 'webhook_replay',
      });
      expect(
        await recordWebhook(rt, {
          body: active,
          signatureHeader: `t=${t0 + 230},v1=${'0'.repeat(64)}`,
          networkKey: 'direct',
          now: new Date((t0 + 230) * 1000),
        }),
      ).toEqual({ status: 400, code: 'webhook_signature_mismatch' });
      expect(await recordWebhook(rt, signed(active, t0 + 230, t0 + 1_000))).toEqual({
        status: 400,
        code: 'webhook_signature_stale',
      });
      expect(await recordWebhook(rt, signed('{"object":"event"}', t0 + 240))).toEqual({
        status: 400,
        code: 'webhook_body_malformed',
      });
      // A reactivation later by its own instant makes the reader a supporter.
      const again = envelope('evt_dal_0000000004', 'customer.subscription.updated', t0 + 300, {
        id: 'sub_dal00000001',
        customer: 'cus_dal00000001',
        status: 'active',
      });
      expect((await recordWebhook(rt, signed(again, t0 + 310))).code).toBe('webhook_recorded');
      const view = await supportView(rt, reader);
      expect([view.mark, view.asOf]).toEqual([
        'supporter',
        new Date((t0 + 300) * 1000).toISOString().replace('.000Z', '+00:00'),
      ]);
      // The portal opens with the bound customer; an unknown type is recorded and ignored.
      const portal = await openBillingPortal(rt, reader, { networkKey: 'direct' });
      expect(portal.url).toBe('https://billing.stripe.com/p/session?secret=x');
      expect(stripe.calls[1]).toEqual({
        customerId: 'cus_dal00000001',
        returnUrl: 'https://dashboard.example.org/support',
      });
      const unknown = envelope('evt_dal_0000000005', 'charge.succeeded', t0 + 400, { id: 'ch_1' });
      expect(await recordWebhook(rt, signed(unknown, t0 + 405))).toEqual({
        status: 200,
        code: 'webhook_ignored',
      });
      // A supporter and a free account receive the same content (D45): the published list is one list.
      expect(await publishedList(rt, reader)).toEqual(await publishedList(rt, persisted.editor));
      expect(JSON.stringify(reader)).not.toContain('supporter');
      // The audit trail by code; never a body, never an address.
      const events = await persistent.audit.list(200);
      expect(
        events
          .filter((e) => e.kind === 'webhook_received')
          .map((e) => e.code)
          .sort(),
      ).toEqual(
        [
          'webhook_recorded',
          'webhook_recorded',
          'webhook_recorded',
          'webhook_recorded',
          'webhook_replay',
          'webhook_signature_mismatch',
          'webhook_signature_stale',
          'webhook_body_malformed',
          'webhook_ignored',
        ].sort(),
      );
      expect(events.filter((e) => e.kind === 'supporter_changed').map((e) => e.code)).toEqual([
        'supporter',
      ]);
      expect(
        events
          .filter((e) => e.kind === 'checkout_started' && e.actorAccountId === reader.accountId)
          .map((e) => e.code)
          .sort(),
      ).toEqual(['portal_redirected', 'redirected']);
      expect(JSON.stringify(events)).not.toContain('livemode');
    });

    it('limits hand-offs per account, audits the trip once, and fails closed for an account with no customer', async () => {
      const stripe = fakeStripe();
      const { rt, persisted, persistent } = await persistentRuntime(null, isolated, null, {
        publicUrl: 'https://dashboard.example.org',
        support: {
          stripe: stripe.client,
          webhookSecret: SECRET,
          priceId: 'price_Test00000001',
          mode: 'test',
        },
        limits: {
          signupAddress: new WindowLimiter(3, 900),
          signupNetwork: new WindowLimiter(10, 900),
          readerReads: new WindowLimiter(600, 900),
          checkoutAccount: new WindowLimiter(1, 900),
          cardAccount: new WindowLimiter(50, 900),
          cardNetwork: new WindowLimiter(500, 900),
        },
      });
      const editor = persisted.editor;
      expect(await kindOf(openBillingPortal(rt, editor, { networkKey: 'direct' }))).toBe(
        'not_found:no_supporter_record',
      );
      expect(await kindOf(startCheckout(rt, editor, { networkKey: 'direct' }))).toBe('succeeded');
      expect(await kindOf(startCheckout(rt, editor, { networkKey: 'direct' }))).toBe(
        'throttled:checkout_limited',
      );
      expect(await kindOf(startCheckout(rt, editor, { networkKey: 'direct' }))).toBe(
        'throttled:checkout_limited',
      );
      expect(stripe.calls).toHaveLength(1);
      const events = await persistent.audit.list(50);
      expect(
        events.filter((e) => e.kind === 'limit_tripped' && e.code === 'checkout_account'),
      ).toHaveLength(1);
      expect(
        events
          .filter((e) => e.kind === 'checkout_started' && e.actorAccountId === editor.accountId)
          .map((e) => e.code)
          .sort(),
      ).toEqual(['limited', 'limited', 'redirected']);
    });

    it('counts a subscription status delivered before the binding once Checkout binds it, and audits the change then (train review F6)', async () => {
      const stripe = fakeStripe();
      const own = await openMigratedSchema();
      const { rt, persisted, persistent } = await persistentRuntime(null, own, null, {
        publicUrl: 'https://dashboard.example.org',
        support: {
          stripe: stripe.client,
          webhookSecret: SECRET,
          priceId: 'price_Test00000001',
          mode: 'test',
        },
      });
      const reader = persisted.reader;
      const { url } = await startCheckout(rt, reader, { networkKey: 'direct' });
      const sessionId = url.slice(url.lastIndexOf('/') + 1);
      const t0 = 1_800_100_000;
      // The subscription's activation arrives first, naming no session and no known customer.
      const created = envelope('evt_bind_000000001', 'customer.subscription.created', t0, {
        id: 'sub_bind_00000001',
        customer: 'cus_bind_00000001',
        status: 'active',
      });
      expect(await recordWebhook(rt, signed(created, t0 + 5))).toEqual({
        status: 200,
        code: 'webhook_recorded',
      });
      expect((await supportView(rt, reader)).mark).toBe('none');
      // Checkout completes and binds the customer and the subscription: the earlier status now counts.
      const completed = envelope('evt_bind_000000002', 'checkout.session.completed', t0 + 10, {
        id: sessionId,
        customer: 'cus_bind_00000001',
        subscription: 'sub_bind_00000001',
        client_reference_id: reader.accountId,
      });
      expect((await recordWebhook(rt, signed(completed, t0 + 15))).code).toBe('webhook_recorded');
      expect(await supportView(rt, reader)).toMatchObject({ mark: 'supporter' });
      const events = await persistent.audit.list(200);
      expect(
        events
          .filter((e) => e.kind === 'supporter_changed' && e.subjectAccountId === reader.accountId)
          .map((e) => [e.code, e.subjectId]),
      ).toEqual([['supporter', 'evt_bind_000000002']]);
      // The attempt that held the session closed with it; a later hand-off is refused as already active.
      const attempts = await own.db.withClient((c) =>
        c.query<{ closed: boolean }>(
          `SELECT closed_at IS NOT NULL AS closed FROM checkout_attempts WHERE account_id = $1`,
          [reader.accountId],
        ),
      );
      expect(attempts.rows).toEqual([{ closed: true }]);
      expect(await kindOf(startCheckout(rt, reader, { networkKey: 'direct' }))).toBe(
        'conflict:support_already_active',
      );
      await own.close();
    });

    it('opens one subscription per account: a double submission makes one request, a retry reuses the key and the session, an active account is refused, and a second subscription is never hidden by the cancellation of the first (train review F7)', async () => {
      const own = await openMigratedSchema();
      let failNext = 0;
      const calls: {
        idempotencyKey: string;
        customerId: string | null;
        customerEmail: string | null;
      }[] = [];
      const byKey = new Map<string, { id: string; url: string }>();
      let issued = 0;
      const stripe: StripeClient = {
        createCheckoutSession: async (input) => {
          calls.push({
            idempotencyKey: input.idempotencyKey,
            customerId: input.customerId,
            customerEmail: input.customerEmail,
          });
          // The provider is idempotent by key: the same key answers the same session.
          let session = byKey.get(input.idempotencyKey);
          if (session === undefined) {
            issued += 1;
            const id = `cs_test_f7_${String(issued).padStart(8, '0')}`;
            session = { id, url: `https://checkout.stripe.com/c/pay/${id}` };
            byKey.set(input.idempotencyKey, session);
          }
          if (failNext > 0) {
            // The request landed at the provider; the answer was lost on the way back.
            failNext -= 1;
            throw new DashboardError(
              'unavailable',
              'checkout_unavailable',
              'the payment provider did not answer',
            );
          }
          return session;
        },
        createPortalSession: async () => ({ url: 'https://billing.stripe.com/p/session?secret=x' }),
      };
      const { rt, persisted, persistent } = await persistentRuntime(null, own, null, {
        publicUrl: 'https://dashboard.example.org',
        support: { stripe, webhookSecret: SECRET, priceId: 'price_Test00000001', mode: 'test' },
        limits: {
          signupAddress: new WindowLimiter(50, 900),
          signupNetwork: new WindowLimiter(50, 900),
          readerReads: new WindowLimiter(50, 900),
          checkoutAccount: new WindowLimiter(50, 900),
          cardAccount: new WindowLimiter(50, 900),
          cardNetwork: new WindowLimiter(500, 900),
        },
      });
      const editor = persisted.editor;
      // A double submission: one request to the provider; both tabs end on the same session, or
      // the second is refused at once while the first is being prepared.
      const outcomes = await Promise.all(
        [0, 1].map(async () => {
          try {
            return (await startCheckout(rt, editor, { networkKey: 'direct' })).url;
          } catch (error) {
            return isDashboardError(error) ? `${error.kind}:${error.code}` : 'unexpected';
          }
        }),
      );
      expect(calls).toHaveLength(1);
      const urls = outcomes.filter((o) => o.startsWith('https://'));
      expect(urls.length).toBeGreaterThanOrEqual(1);
      expect(new Set(urls).size).toBe(1);
      expect(
        outcomes.every((o) => o.startsWith('https://') || o === 'conflict:checkout_in_progress'),
      ).toBe(true);
      const firstUrl = urls[0] ?? '';
      // A third submission inside the window is the same session again, with no request.
      expect((await startCheckout(rt, editor, { networkKey: 'direct' })).url).toBe(firstUrl);
      expect(calls).toHaveLength(1);
      const sessions = await own.db.withClient((c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM checkout_sessions WHERE account_id = $1`,
          [editor.accountId],
        ),
      );
      expect(sessions.rows[0]?.n).toBe('1');
      // Past the window the attempt closes; a new one asks the provider under a new key.
      const later = new Date(Date.now() + (CHECKOUT_ATTEMPT_MINUTES + 1) * 60_000);
      const second = await startCheckout(rt, editor, { networkKey: 'direct', now: later });
      expect(second.url).not.toBe(firstUrl);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
      // An ambiguous answer: the provider made the session but the answer was lost. The attempt
      // keeps its key; the retry asks under the same key and receives that same session.
      const much = new Date(later.getTime() + (CHECKOUT_ATTEMPT_MINUTES + 1) * 60_000);
      failNext = 1;
      expect(await kindOf(startCheckout(rt, editor, { networkKey: 'direct', now: much }))).toBe(
        'unavailable:checkout_unavailable',
      );
      const retried = await startCheckout(rt, editor, { networkKey: 'direct', now: much });
      expect(calls).toHaveLength(4);
      expect(calls[3]?.idempotencyKey).toBe(calls[2]?.idempotencyKey);
      expect(retried.url).toBe(byKey.get(calls[2]?.idempotencyKey ?? '')?.url);
      // Checkout completes on the retried session: the account is a supporter; a further hand-off is refused.
      const retriedId = retried.url.slice(retried.url.lastIndexOf('/') + 1);
      const t0 = 1_800_200_000;
      const completed = envelope('evt_f7_0000000001', 'checkout.session.completed', t0, {
        id: retriedId,
        customer: 'cus_f7_000000001',
        subscription: 'sub_f7_000000001',
        client_reference_id: editor.accountId,
      });
      expect((await recordWebhook(rt, signed(completed, t0 + 5))).code).toBe('webhook_recorded');
      const active = envelope('evt_f7_0000000002', 'customer.subscription.created', t0 + 10, {
        id: 'sub_f7_000000001',
        customer: 'cus_f7_000000001',
        status: 'active',
      });
      expect((await recordWebhook(rt, signed(active, t0 + 15))).code).toBe('webhook_recorded');
      expect((await supportView(rt, editor)).mark).toBe('supporter');
      expect(await kindOf(startCheckout(rt, editor, { networkKey: 'direct', now: much }))).toBe(
        'conflict:support_already_active',
      );
      expect(calls).toHaveLength(4);
      // A second subscription of the same customer, however it came to be, keeps the mark when the
      // first is cancelled; only when both are cancelled does the mark fall; a hand-off is open again
      // then, and it reuses the customer the account is bound to.
      const secondSub = envelope('evt_f7_0000000003', 'customer.subscription.created', t0 + 20, {
        id: 'sub_f7_000000002',
        customer: 'cus_f7_000000001',
        status: 'active',
      });
      expect((await recordWebhook(rt, signed(secondSub, t0 + 25))).code).toBe('webhook_recorded');
      const cancelFirst = envelope('evt_f7_0000000004', 'customer.subscription.deleted', t0 + 30, {
        id: 'sub_f7_000000001',
        customer: 'cus_f7_000000001',
        status: 'canceled',
      });
      expect((await recordWebhook(rt, signed(cancelFirst, t0 + 35))).code).toBe('webhook_recorded');
      expect((await supportView(rt, editor)).mark).toBe('supporter');
      const cancelSecond = envelope('evt_f7_0000000005', 'customer.subscription.deleted', t0 + 40, {
        id: 'sub_f7_000000002',
        customer: 'cus_f7_000000001',
        status: 'canceled',
      });
      expect((await recordWebhook(rt, signed(cancelSecond, t0 + 45))).code).toBe(
        'webhook_recorded',
      );
      expect((await supportView(rt, editor)).mark).toBe('none');
      const again = await startCheckout(rt, editor, {
        networkKey: 'direct',
        now: new Date(much.getTime() + 60 * 60_000),
      });
      expect(again.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
      expect(calls[4]).toMatchObject({ customerId: 'cus_f7_000000001', customerEmail: null });
      const changes = (await persistent.audit.list(300))
        .filter((e) => e.kind === 'supporter_changed' && e.subjectAccountId === editor.accountId)
        .map((e) => e.code)
        .reverse();
      expect(changes).toEqual(['supporter', 'none']);
      await own.close();
    });
  });

  describe('story cards (CAS-009)', () => {
    /** A round-up of three one-row stories, generated through the real path and published at revision 1. */
    async function publishedRoundup(own: IsolatedSchema, limits?: Limits) {
      const week = await seedLargeWeek(own.db, 3, 1);
      const loaded = await loadTemplate();
      const marker = sectionOf(loaded.template, 'extras').marker ?? '';
      const transport = {
        async generate(request: { user: string; model: string }) {
          const seen = JSON.parse(request.user) as {
            incidents: { rows: { url: string; sourceRowId: string }[] }[];
          };
          return {
            raw: {
              rundown: seen.incidents.map((incident, i) => ({
                headline: `Card headline ${i + 1}`,
                summary: 'A summary the card never carries.',
                sources: incident.rows.map((row) => row.url),
                citations: incident.rows.map((row) => row.sourceRowId),
              })),
              extras: marker,
            },
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      };
      const { rt, persisted, persistent } = await persistentRuntime(
        transport,
        own,
        null,
        limits === undefined ? {} : { limits },
      );
      const table = await weekTable(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        undefined,
        undefined,
      );
      expect(table.rows.length).toBe(3);
      for (const row of table.rows) {
        await selectStory(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          clusteringRunId: week.clusteringRunId,
          incidentId: row.incidentId,
          state: 'selected',
          note: null,
        });
      }
      await generateRoundup(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedTemplateHash: loaded.hash,
      });
      const target = { weekRunId: week.weekRunId, category: 'cyberattack', output: 'roundup' };
      await publishOutput(rt, persisted.owner, { ...target, revision: 1 });
      return { week, rt, persisted, persistent, target };
    }
    const story = (weekRunId: string, entryIndex: number) => ({
      weekRunId,
      category: 'cyberattack',
      output: 'roundup',
      entryIndex,
    });
    const kindCode = async (call: Promise<unknown>): Promise<string> => {
      try {
        await call;
      } catch (error) {
        return isDashboardError(error) ? `${error.kind}:${error.code}` : 'unexpected';
      }
      return 'succeeded';
    };

    it('makes one card per story for anyone who may read published outputs, serves it without a session from the published text, and counts each origin view', async () => {
      const own = await openMigratedSchema();
      const { week, rt, persisted, persistent } = await publishedRoundup(own);
      const made = await makeCard(rt, persisted.reader, story(week.weekRunId, 0));
      expect(made.created).toBe(true);
      expect(made.id).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      // The same story again, by anyone: the same address, nothing new.
      for (const role of ['editor', 'owner', 'reader'] as const) {
        expect(await makeCard(rt, persisted[role], story(week.weekRunId, 0))).toEqual({
          id: made.id,
          created: false,
        });
      }
      expect(await kindCode(makeCard(rt, null, story(week.weekRunId, 0)))).toBe(
        'authentication:session_required',
      );
      for (const bad of [
        { ...story(week.weekRunId, 0), entryIndex: 'x' },
        { ...story(week.weekRunId, 0), output: 'draft' },
        { ...story(week.weekRunId, 0), output: 'article', entryIndex: 1 },
        { ...story(week.weekRunId, 0), category: 'Not A Category' },
      ]) {
        expect((await kindCode(makeCard(rt, persisted.reader, bad))).split(':')[0]).toBe(
          'validation',
        );
      }
      expect(await kindCode(makeCard(rt, persisted.reader, story(week.weekRunId, 99)))).toBe(
        'not_found:story_not_shareable',
      );
      // The public read: the allowlist and nothing else, the published headline, the hosts.
      const first = await cardPage(rt, made.id, 'direct');
      expect(Object.keys(first.card)).toEqual([...STORY_CARD_FIELDS]);
      expect(first.card).toMatchObject({
        id: made.id,
        output: 'roundup',
        category: 'cyberattack',
        revision: 1,
        headline: 'Card headline 1',
      });
      expect(first.card.publishers.length).toBeGreaterThan(0);
      expect(JSON.stringify(first.card)).not.toMatch(/summary the card|https?:|citation/u);
      expect(first.views).toBe(1);
      expect((await cardPage(rt, made.id, 'direct')).views).toBe(2);
      expect(first.publishedPath).toBe(
        `/published/${week.weekRunId}?category=cyberattack&output=roundup`,
      );
      expect(await kindCode(cardPage(rt, 'A'.repeat(22), 'direct'))).toBe(
        'not_found:story_not_shareable',
      );
      expect(await kindCode(cardPage(rt, 'not-a-card', 'direct'))).toBe(
        'not_found:story_not_shareable',
      );
      // The published page lists the stories it can share, as the published text states them.
      const view = await publishedOutput(
        rt,
        persisted.reader,
        week.weekRunId,
        'cyberattack',
        'roundup',
      );
      expect(view.stories.map((s) => [s.entryIndex, s.headline])).toEqual([
        [0, 'Card headline 1'],
        [1, 'Card headline 2'],
        [2, 'Card headline 3'],
      ]);
      // One audit event for the card made, with its identifier and kind, no text.
      const made_ = (await persistent.audit.list(200)).filter((e) => e.kind === 'card_created');
      expect(made_.map((e) => [e.code, e.subjectId, e.actorAccountId])).toEqual([
        ['roundup', made.id, persisted.reader.accountId],
      ]);
      expect(JSON.stringify(made_)).not.toContain('Card headline');
      await own.close();
    });

    it('follows the current published revision: a correction shows at the same address, and a removed entry, a deterministic revision or an unpublished output answers not found', async () => {
      const own = await openMigratedSchema();
      const { week, rt, persisted, target } = await publishedRoundup(own);
      const { id } = await makeCard(rt, persisted.reader, story(week.weekRunId, 1));
      const published = await publishedOutput(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        'roundup',
      );
      const corrected = published.markdown.replace('**Card headline 2**', '**Corrected headline**');
      expect(corrected).not.toBe(published.markdown);
      expect(
        await saveRoundupRevision(rt, persisted.owner, {
          weekRunId: week.weekRunId,
          category: 'cyberattack',
          expectedRevision: 1,
          markdown: corrected,
        }),
      ).toEqual({ revision: 2 });
      // Revision 2 exists but is not published: the card still shows revision 1.
      expect((await cardPage(rt, id, 'direct')).card).toMatchObject({
        revision: 1,
        headline: 'Card headline 2',
      });
      await publishOutput(rt, persisted.owner, { ...target, revision: 2 });
      expect((await cardPage(rt, id, 'direct')).card).toMatchObject({
        id,
        revision: 2,
        headline: 'Corrected headline',
      });
      // The owner removes that story's block: the card answers not found, and no card can be made for it.
      const start = corrected.indexOf('**Corrected headline**');
      const end = corrected.indexOf('**Card headline 3**');
      const removed = corrected.slice(0, start) + corrected.slice(end);
      await saveRoundupRevision(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedRevision: 2,
        markdown: removed,
      });
      await publishOutput(rt, persisted.owner, { ...target, revision: 3 });
      expect(await kindCode(cardPage(rt, id, 'direct'))).toBe('not_found:story_not_shareable');
      expect(await kindCode(makeCard(rt, persisted.reader, story(week.weekRunId, 1)))).toBe(
        'not_found:story_not_shareable',
      );
      // The deterministic revision carries the sources' own titles: never a card (D48, 3).
      await publishOutput(rt, persisted.owner, { ...target, revision: 0 });
      expect(await kindCode(cardPage(rt, id, 'direct'))).toBe('not_found:story_not_shareable');
      // Back to the correction: the same address serves again.
      await publishOutput(rt, persisted.owner, { ...target, revision: 2 });
      expect((await cardPage(rt, id, 'direct')).card.headline).toBe('Corrected headline');
      // Unpublished: not found at once.
      await unpublishOutput(rt, persisted.owner, target);
      expect(await kindCode(cardPage(rt, id, 'direct'))).toBe('not_found:story_not_shareable');
      expect(await kindCode(cardImage(rt, id, 'png', 'direct'))).toBe(
        'not_found:story_not_shareable',
      );
      await own.close();
    });

    it('serves the image stored for the revision the same read found current, never another revision’s (the owner’s merge condition)', async () => {
      const own = await openMigratedSchema();
      const { week, rt, persisted, target } = await publishedRoundup(own);
      const { id } = await makeCard(rt, persisted.reader, story(week.weekRunId, 0));
      const first = (await cardImage(rt, id, 'png', 'direct')).body as Uint8Array;
      const published = await publishedOutput(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        'roundup',
      );
      await saveRoundupRevision(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedRevision: 1,
        markdown: published.markdown.replace('**Card headline 1**', '**Corrected headline**'),
      });
      // A sentinel stored under revision 2 before revision 2 is published.
      const sentinel = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x53, 0x45, 0x4e, 0x54,
      ]);
      await own.db.withTransaction((tx) =>
        insertStoryCardImage(tx, {
          cardId: id,
          revision: 2,
          png: sentinel,
          pngSha256: 'f'.repeat(64),
          createdAt: new Date().toISOString(),
        }),
      );
      const bytes = async () => [
        ...((await cardImage(rt, id, 'png', 'direct')).body as Uint8Array),
      ];
      // Revision 1 current: revision 1's image, never revision 2's.
      expect(await bytes()).toEqual([...first]);
      // Revision 2 current: exactly what is stored under revision 2.
      await publishOutput(rt, persisted.owner, { ...target, revision: 2 });
      expect(await bytes()).toEqual([...sentinel]);
      // Revision 1 current again: revision 1's image again.
      await publishOutput(rt, persisted.owner, { ...target, revision: 1 });
      expect(await bytes()).toEqual([...first]);
      await own.close();
    });

    it('rasterizes the PNG once per card and published revision, serves the SVG, and limits views per source and new cards per account', async () => {
      const own = await openMigratedSchema();
      const { week, rt, persisted, persistent, target } = await publishedRoundup(own, {
        signupAddress: new WindowLimiter(50, 900),
        signupNetwork: new WindowLimiter(50, 900),
        readerReads: new WindowLimiter(500, 900),
        checkoutAccount: new WindowLimiter(50, 900),
        cardAccount: new WindowLimiter(1, 900),
        cardNetwork: new WindowLimiter(5, 900),
      });
      const { id } = await makeCard(rt, persisted.reader, story(week.weekRunId, 0));
      const images = async () =>
        (
          await own.db.withClient((c) =>
            c.query<{ revision: number }>(
              `SELECT revision FROM story_card_images WHERE card_id = $1 ORDER BY revision`,
              [id],
            ),
          )
        ).rows.map((r) => r.revision);
      // Rasterized at creation, served from the cache after.
      expect(await images()).toEqual([1]);
      const png = await cardImage(rt, id, 'png', 'source-a');
      expect(Buffer.from((png.body as Uint8Array).subarray(0, 8)).toString('hex')).toBe(
        '89504e470d0a1a0a',
      );
      await cardImage(rt, id, 'png', 'source-a');
      expect(await images()).toEqual([1]);
      // A correction published: one more rasterization, for the new revision.
      const published = await publishedOutput(
        rt,
        persisted.owner,
        week.weekRunId,
        'cyberattack',
        'roundup',
      );
      await saveRoundupRevision(rt, persisted.owner, {
        weekRunId: week.weekRunId,
        category: 'cyberattack',
        expectedRevision: 1,
        markdown: published.markdown.replace(
          '**Card headline 1**',
          '**A \\<corrected\\> & quoted headline**',
        ),
      });
      await publishOutput(rt, persisted.owner, { ...target, revision: 2 });
      expect(
        (await publishedOutput(rt, persisted.owner, week.weekRunId, 'cyberattack', 'roundup'))
          .revision,
      ).toBe(2);
      expect((await cardImage(rt, id, 'png', 'source-a')).revision).toBe(2);
      expect(await images()).toEqual([1, 2]);
      const svg = await cardImage(rt, id, 'svg', 'source-a');
      expect(svg.body).toContain('A &lt;corrected&gt; &amp; quoted headline');
      // Four requests from source-a so far; the fifth is the last allowed, the sixth refused.
      expect((await cardPage(rt, id, 'source-a')).card.revision).toBe(2);
      expect(await kindCode(cardPage(rt, id, 'source-a'))).toBe('throttled:card_views_limited');
      expect(await kindCode(cardImage(rt, id, 'png', 'source-a'))).toBe(
        'throttled:card_views_limited',
      );
      expect((await cardPage(rt, id, 'source-b')).card.id).toBe(id);
      // One new card per account in the window: the existing one is returned without spending it.
      expect(await kindCode(makeCard(rt, persisted.reader, story(week.weekRunId, 2)))).toBe(
        'throttled:card_limited',
      );
      expect(await makeCard(rt, persisted.reader, story(week.weekRunId, 0))).toEqual({
        id,
        created: false,
      });
      expect((await makeCard(rt, persisted.editor, story(week.weekRunId, 2))).created).toBe(true);
      const trips = (await persistent.audit.list(200)).filter((e) => e.kind === 'limit_tripped');
      expect(trips.map((e) => e.code).sort()).toEqual(['card_account', 'card_network']);
      await own.close();
    });
  });
});
