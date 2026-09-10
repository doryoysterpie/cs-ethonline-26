import 'server-only';

import { generateDraft } from '@cas/drafting';
import { CHAIN_LIMITATION, REPORTING_LIMITATION } from '@cas/evidence';

import { capabilitiesOf } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { DashboardError } from '../errors.ts';
import { instant, integer, optionalInstant, optionalUuid, uuid } from '../input.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import type {
  AdministrationDto,
  AnomalyViewDto,
  CommandCenterDto,
  DraftViewDto,
  EvidenceViewDto,
  IncidentDetailDto,
  IncidentExplorerDto,
  PrincipalDto,
  ReviewQueueDto,
} from './dto.ts';
import { holds, requireCapability } from './guard.ts';
import { mapFailure } from './failures.ts';

/**
 * Read side of the data-access layer.
 *
 * Every function begins with `requireCapability`, validates its identifiers
 * before any query, reads through `@cas/database` and the worker's audited
 * read APIs, and returns a DTO. Source text is requested from the database
 * only for a principal that holds `view:source_text`; for anyone else the
 * statement selects `NULL`, so the text never crosses the wire.
 */

const RUN_LIST = 25;
const INCIDENT_PAGE = 100;
const MEMBER_PAGE = 200;
const QUEUE_PAGE = 100;
const EVIDENCE_PAGE = 500;
const TEXT_BOUND = 1000;
const DRAFT_INCIDENTS = 500;

export function describePrincipal(principal: Principal): PrincipalDto {
  return {
    username: principal.username,
    role: principal.role,
    capabilities: capabilitiesOf(principal.role),
  };
}

export async function commandCenter(
  runtime: Runtime,
  who: Principal | null,
): Promise<CommandCenterDto> {
  requireCapability(who, 'view:command_center');
  const packages = await workspace();
  const {
    countDashboardTotals,
    listClassificationRuns,
    listClusteringRuns,
    listEvidenceRuns,
    listGraphSignalRuns,
  } = packages.database;
  try {
    return await runtime.database.withClient(async (client) => {
      const totals = await countDashboardTotals(client);
      const clustering = await listClusteringRuns(client, RUN_LIST);
      const evidence = await listEvidenceRuns(client, RUN_LIST);
      const signals = await listGraphSignalRuns(client, RUN_LIST);
      const classification = (await listClassificationRuns(client, null))
        .slice(-RUN_LIST)
        .reverse();
      return {
        totals,
        clusteringRuns: clustering.map((run) => ({
          id: run.id,
          dataOrigin: run.dataOrigin,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          incidentCount: run.incidentCount,
          multiSourceIncidentCount: run.multiSourceIncidentCount,
          ambiguousLinkCount: run.ambiguousLinkCount,
          classificationRunId: run.classificationRunId,
        })),
        evidenceRuns: evidence.map((run) => ({
          id: run.id,
          dataOrigin: run.dataOrigin,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          clusteringRunId: run.clusteringRunId,
          signalRunId: run.signalRunId,
          incidentCount: run.incidentCount,
          suggestionCount: run.suggestionCount,
          reportedOnly: run.reportedOnlyCount,
          onchainObserved: run.onchainObservedCount,
          corroborated: run.corroboratedCount,
          contradicted: run.contradictedCount,
        })),
        signalRuns: signals.map((run) => ({
          id: run.id,
          dataOrigin: run.dataOrigin,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          gatewayHost: run.gatewayHost,
          targetCount: run.targetCount,
          signalCount: run.signalCount,
          failedTargetCount: run.failedTargetCount,
        })),
        classificationRuns: classification.map((run) => ({
          id: run.id,
          dataOrigin: run.dataOrigin,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          batchId: run.batchId,
          reviewCount: run.reviewCount,
          includeCount: run.includeCount,
          excludeCount: run.excludeCount,
        })),
      };
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export async function incidentExplorer(
  runtime: Runtime,
  who: Principal | null,
  clusteringRunId: unknown,
  afterId: unknown,
): Promise<IncidentExplorerDto> {
  requireCapability(who, 'view:incidents');
  const runId = uuid(clusteringRunId, 'clusteringRunId');
  const after = optionalUuid(afterId, 'after');
  const packages = await workspace();
  const { getClusteringRun, listIncidentClusters } = packages.database;
  const { effectiveIncidents } = packages.worker;
  try {
    const run = await runtime.database.withClient((client) => getClusteringRun(client, runId));
    if (run === null)
      throw new DashboardError(
        'not_found',
        'clustering_run_not_found',
        'No clustering run with that id.',
      );
    const view =
      run.status === 'completed' ? await effectiveIncidents(runtime.database, runId) : null;
    const incidents = await runtime.database.withClient((client) =>
      listIncidentClusters(client, runId, { afterId: after, limit: INCIDENT_PAGE }),
    );
    return {
      run: {
        id: run.id,
        dataOrigin: run.dataOrigin,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        incidentCount: run.incidentCount,
        batchId: run.batchId,
      },
      reviewRevision: view?.revision ?? 0,
      reviewActions: view?.revision ?? 0,
      effectiveIncidents: view?.incidents.length ?? 0,
      incidents: incidents.map((cluster) => ({
        id: cluster.id,
        kind: cluster.kind,
        memberCount: cluster.memberCount,
        reasonCodes: cluster.reasonCodes,
        subjectChain: cluster.subjectChain,
        subjectProtocolSlug: cluster.subjectProtocolSlug,
        dataOrigin: run.dataOrigin,
      })),
      nextAfterId:
        incidents.length === INCIDENT_PAGE ? (incidents[incidents.length - 1]?.id ?? null) : null,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export async function incidentDetail(
  runtime: Runtime,
  who: Principal | null,
  clusteringRunId: unknown,
  incidentId: unknown,
): Promise<IncidentDetailDto> {
  const principal = requireCapability(who, 'view:incidents');
  const runId = uuid(clusteringRunId, 'clusteringRunId');
  const id = uuid(incidentId, 'incidentId');
  const withText = holds(principal, 'view:source_text');
  const packages = await workspace();
  const { getClusteringRun, getIncidentCluster, listIncidentMembers } = packages.database;
  const { effectiveIncidents } = packages.worker;
  try {
    const run = await runtime.database.withClient((client) => getClusteringRun(client, runId));
    if (run === null)
      throw new DashboardError(
        'not_found',
        'clustering_run_not_found',
        'No clustering run with that id.',
      );
    const cluster = await runtime.database.withClient((client) =>
      getIncidentCluster(client, runId, id),
    );
    if (cluster === null)
      throw new DashboardError(
        'not_found',
        'incident_not_found',
        'No incident with that id in this run.',
      );
    const members = await runtime.database.withClient((client) =>
      listIncidentMembers(client, runId, id, {
        limit: MEMBER_PAGE,
        withText,
        maxTextCharacters: TEXT_BOUND,
      }),
    );
    const view =
      run.status === 'completed' ? await effectiveIncidents(runtime.database, runId) : null;
    return {
      run: {
        id: run.id,
        dataOrigin: run.dataOrigin,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        batchId: run.batchId,
      },
      incident: {
        id: cluster.id,
        kind: cluster.kind,
        memberCount: cluster.memberCount,
        reasonCodes: cluster.reasonCodes,
        subjectChain: cluster.subjectChain,
        subjectProtocolSlug: cluster.subjectProtocolSlug,
        dataOrigin: run.dataOrigin,
      },
      members: members.map((member) => ({
        membershipId: member.membershipId,
        sourceRowId: member.sourceRowId,
        rowNumber: member.rowNumber,
        decision: member.decision,
        postedAt: member.postedAt,
        dataOrigin: member.dataOrigin,
        title: withText ? member.title : null,
        publisher: withText ? member.publisher : null,
        url: withText ? member.url : null,
      })),
      reviewRevision: view?.revision ?? 0,
      isEffective: view?.incidents.some((incident) => incident.effectiveIncidentId === id) ?? false,
      canReview: holds(principal, 'review:incidents'),
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export async function reviewQueue(
  runtime: Runtime,
  who: Principal | null,
  classificationRunId: unknown,
  afterRowNumber: unknown,
): Promise<ReviewQueueDto> {
  const principal = requireCapability(who, 'view:queue');
  const runId = uuid(classificationRunId, 'classificationRunId');
  const after =
    afterRowNumber === undefined || afterRowNumber === null || afterRowNumber === ''
      ? 0
      : integer(afterRowNumber, 'after', { min: 0, max: 100_000_000 });
  const withText = holds(principal, 'view:source_text');
  const packages = await workspace();
  const { getClassificationRun, listReviewQueueEntries } = packages.database;
  try {
    const run = await runtime.database.withClient((client) => getClassificationRun(client, runId));
    if (run === null)
      throw new DashboardError(
        'not_found',
        'classification_run_not_found',
        'No classification run with that id.',
      );
    const entries = await runtime.database.withClient((client) =>
      listReviewQueueEntries(client, runId, {
        afterRowNumber: after,
        limit: QUEUE_PAGE,
        withText,
        maxTextCharacters: TEXT_BOUND,
      }),
    );
    const decisions = await runtime.stores.queueDecisions.listForRun(runId);
    const accounts = new Map<string, string>();
    for (const account of await runtime.stores.accounts.list())
      accounts.set(account.id, account.username);
    const latest = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) latest.set(decision.sourceRowId, decision);
    return {
      run: {
        id: run.id,
        dataOrigin: run.dataOrigin,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        batchId: run.batchId,
        reviewCount: run.reviewCount,
      },
      entries: entries.map((entry) => {
        const decision = latest.get(entry.sourceRowId) ?? null;
        return {
          sourceRowId: entry.sourceRowId,
          rowNumber: entry.rowNumber,
          dataOrigin: entry.dataOrigin,
          rationaleCodes: entry.rationaleCodes,
          signalScore: entry.signalScore,
          postedAt: entry.postedAt,
          title: withText ? entry.title : null,
          summary: withText ? entry.summary : null,
          url: withText ? entry.url : null,
          decision:
            decision === null
              ? null
              : {
                  reviewState: decision.reviewState,
                  reasonCode: decision.reasonCode,
                  note: holds(principal, 'view:notes') ? decision.note : null,
                  decidedBy: accounts.get(decision.actorAccountId) ?? 'unknown',
                  decidedAt: decision.createdAt,
                },
        };
      }),
      nextAfterRowNumber:
        entries.length === QUEUE_PAGE ? (entries[entries.length - 1]?.rowNumber ?? null) : null,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export async function evidenceView(
  runtime: Runtime,
  who: Principal | null,
  evidenceRunId: unknown,
): Promise<EvidenceViewDto> {
  const principal = requireCapability(who, 'view:evidence');
  const runId = uuid(evidenceRunId, 'evidenceRunId');
  const withNotes = holds(principal, 'view:notes');
  const packages = await workspace();
  const {
    getEvidenceRun,
    listAssociationDetails,
    listEvidenceActions,
    listIncidentEvidenceStates,
  } = packages.database;
  try {
    return await runtime.database.withClient(async (client) => {
      const run = await getEvidenceRun(client, runId);
      if (run === null)
        throw new DashboardError(
          'not_found',
          'evidence_run_not_found',
          'No evidence run with that id.',
        );
      const states = await listIncidentEvidenceStates(client, runId, EVIDENCE_PAGE);
      const associations = await listAssociationDetails(client, runId, EVIDENCE_PAGE);
      const actions = await listEvidenceActions(client, runId);
      return {
        run: {
          id: run.id,
          dataOrigin: run.dataOrigin,
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          clusteringRunId: run.clusteringRunId,
          signalRunId: run.signalRunId,
          counts: {
            incidents: run.incidentCount,
            suggestions: run.suggestionCount,
            reportedOnly: run.reportedOnlyCount,
            onchainObserved: run.onchainObservedCount,
            corroborated: run.corroboratedCount,
            contradicted: run.contradictedCount,
          },
        },
        states: states.map((state) => ({
          incidentId: state.incidentId,
          state: state.state,
          reasonCode: state.reasonCode,
          claimId: state.claimId,
          acceptedAssociationCount: state.acceptedAssociationCount,
          hasSubject: state.hasSubject,
        })),
        associations: associations.map((association) => ({
          associationId: association.associationId,
          incidentId: association.incidentId,
          signalId: association.signalId,
          chain: association.chain,
          protocolSlug: association.protocolSlug,
          observedAt: association.observedAt,
          deltaPercent: association.deltaPercent,
          offsetSeconds: association.offsetSeconds,
          reasonCodes: association.reasonCodes,
          suggestedRelation: association.suggestedRelation,
          effectiveRelation: association.effectiveRelation,
          effectiveStatus: association.effectiveStatus,
          effectiveClaimId: association.effectiveClaimId,
        })),
        decisions: actions.map((action) => ({
          associationId: action.associationId,
          operation: action.operation,
          relation: action.relation,
          reasonCode: action.reasonCode,
          rationale: withNotes ? action.rationale : null,
          actor: action.actor,
          resultingRevision: action.resultingRevision,
          createdAt: action.createdAt,
        })),
        revision: actions.reduce(
          (highest, action) => Math.max(highest, action.resultingRevision),
          0,
        ),
        canReview: holds(principal, 'review:evidence'),
        limitations: [
          'A suggestion is not evidence until a named person accepts it.',
          'Absence of an accepted signal never contradicts a claim; it resolves to reported_only.',
          CHAIN_LIMITATION,
        ],
      };
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export interface AnomalyQuery {
  readonly signalRunId: unknown;
  readonly asOf: unknown;
  readonly clusteringRunId: unknown;
  readonly windows: readonly { readonly startsAt: unknown; readonly endsAt: unknown }[];
}

export async function anomalyView(
  runtime: Runtime,
  who: Principal | null,
  query: AnomalyQuery,
): Promise<AnomalyViewDto> {
  requireCapability(who, 'view:anomaly');
  const signalRunId = uuid(query.signalRunId, 'signalRunId');
  const asOf = optionalInstant(query.asOf, 'asOf');
  const clusteringRunId = optionalUuid(query.clusteringRunId, 'clusteringRunId');
  if (query.windows.length > 12) {
    throw new DashboardError(
      'validation',
      'windows_too_many',
      'At most twelve reporting windows may be supplied.',
    );
  }
  const windows = query.windows.map((window) => ({
    startsAt: instant(window.startsAt, 'windowStart'),
    endsAt: instant(window.endsAt, 'windowEnd'),
  }));
  for (const window of windows) {
    if (Date.parse(window.startsAt) >= Date.parse(window.endsAt)) {
      throw new DashboardError(
        'validation',
        'window_order',
        'A reporting window must end after it starts.',
      );
    }
  }
  const packages = await workspace();
  const { getGraphSignalRun } = packages.database;
  const { buildAnomalyFeed } = packages.worker;
  try {
    const run = await runtime.database.withClient((client) =>
      getGraphSignalRun(client, signalRunId),
    );
    if (run === null)
      throw new DashboardError('not_found', 'signal_run_not_found', 'No signal run with that id.');
    const now = asOf === null ? new Date() : new Date(asOf);
    const feed = await buildAnomalyFeed(runtime.database, {
      signalRunId,
      clusteringRunId: clusteringRunId ?? undefined,
      windows: clusteringRunId === null ? undefined : windows,
      now: () => now,
    });
    return {
      run: {
        id: run.id,
        dataOrigin: run.dataOrigin,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        gatewayHost: run.gatewayHost,
        signalCount: run.signalCount,
      },
      asOf: now.toISOString(),
      entries: feed.entries.map((entry) => ({
        signalType: entry.signalType,
        label: entry.label,
        subjectId: entry.subjectId,
        chain: entry.chain,
        protocolSlug: entry.protocolSlug,
        observationWindow: entry.observationWindow,
        baselineWindow: entry.baselineWindow,
        value: entry.value,
        threshold: entry.threshold,
        dataOrigin: entry.dataOrigin,
        provenanceId: entry.provenanceId,
        reasonCodes: entry.reasonCodes,
        evidenceLimitation:
          entry.signalType === 'chain_tvl' ? CHAIN_LIMITATION : REPORTING_LIMITATION,
      })),
      stats: feed.stats,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export function draftKeyOf(evidenceRunId: string, periodStart: string, periodEnd: string): string {
  return `${evidenceRunId}:${periodStart}:${periodEnd}`;
}

export async function draftView(
  runtime: Runtime,
  who: Principal | null,
  evidenceRunId: unknown,
  periodStart: unknown,
  periodEnd: unknown,
): Promise<DraftViewDto> {
  const principal = requireCapability(who, 'view:draft');
  const runId = uuid(evidenceRunId, 'evidenceRunId');
  const start = instant(periodStart, 'periodStart');
  const end = instant(periodEnd, 'periodEnd');
  if (Date.parse(start) >= Date.parse(end)) {
    throw new DashboardError('validation', 'period_order', 'The period must end after it starts.');
  }
  const packages = await workspace();
  const { getEvidenceRun } = packages.database;
  const { buildDraftRequest } = packages.worker;
  try {
    const run = await runtime.database.withClient((client) => getEvidenceRun(client, runId));
    if (run === null)
      throw new DashboardError(
        'not_found',
        'evidence_run_not_found',
        'No evidence run with that id.',
      );
    const request = await buildDraftRequest(runtime.database, {
      evidenceRunId: runId,
      periodStart: start,
      periodEnd: end,
      maximumIncidents: DRAFT_INCIDENTS,
    });
    const generated = generateDraft(request);
    const key = draftKeyOf(runId, start, end);
    const revisions = await runtime.stores.drafts.list(key);
    const latest = revisions[revisions.length - 1] ?? null;
    const accounts = new Map<string, string>();
    for (const account of await runtime.stores.accounts.list())
      accounts.set(account.id, account.username);
    return {
      draftKey: key,
      evidenceRun: {
        id: run.id,
        dataOrigin: run.dataOrigin,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      periodStart: start,
      periodEnd: end,
      status: generated.provenance.status,
      markdown: latest?.markdown ?? generated.markdown,
      revision: latest?.revision ?? 0,
      generatedMarkdown: generated.markdown,
      counts: generated.provenance.counts,
      revisions: revisions.map((revision) => ({
        revision: revision.revision,
        savedBy: accounts.get(revision.savedByAccountId) ?? 'unknown',
        savedAt: revision.savedAt,
      })),
      canEdit: holds(principal, 'edit:draft'),
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export async function administration(
  runtime: Runtime,
  who: Principal | null,
): Promise<AdministrationDto> {
  requireCapability(who, 'admin:accounts');
  requireCapability(who, 'view:audit');
  const accounts = await runtime.stores.accounts.list();
  const usernames = new Map(accounts.map((account) => [account.id, account.username]));
  const dtos = [];
  for (const account of accounts) {
    const sessions = await runtime.stores.sessions.listForAccount(account.id);
    dtos.push({
      id: account.id,
      username: account.username,
      role: account.role,
      createdAt: account.createdAt,
      passwordChangedAt: account.passwordChangedAt,
      disabledAt: account.disabledAt,
      expiresAt: account.expiresAt,
      liveSessions: sessions.filter((session) => session.revokedAt === null).length,
    });
  }
  const audit = await runtime.stores.audit.list(100);
  return {
    accounts: dtos,
    audit: audit.map((event) => ({
      at: event.at,
      kind: event.kind,
      outcome: event.outcome,
      code: event.code,
      actor:
        event.actorAccountId === null ? null : (usernames.get(event.actorAccountId) ?? 'unknown'),
      subject:
        event.subjectAccountId === null
          ? null
          : (usernames.get(event.subjectAccountId) ?? 'unknown'),
      networkKey: event.networkKey,
    })),
  };
}
