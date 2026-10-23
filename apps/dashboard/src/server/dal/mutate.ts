import 'server-only';

import type { Queryable } from '@cas/database';

import { randomUUID } from 'node:crypto';

import { REVIEW_STATES, type ReviewState } from '@cas/contracts';

import { normalizeEmail } from '../auth/email.ts';
import { assertPassword, hashPassword } from '../auth/password.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import { displayIdentity, type Principal } from '../auth/session.ts';
import { isUsernameShaped, type AccountRecord, type AuditEvent } from '../auth/store.ts';
import { DashboardError, isDashboardError, validation } from '../errors.ts';
import {
  boundedText,
  enumOf,
  instant,
  integer,
  optionalInstant,
  optionalText,
  uuid,
  uuidList,
} from '../input.ts';
import type { ArticleInput } from '@cas/article';
import type { SourceOutcome } from '@cas/source-reader';

import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';
import { draftKeyOf, monthBounds } from './read.ts';

/**
 * Mutation side of the data-access layer.
 *
 * Every function begins with `requireCapability`, validates every field of
 * its input again (the action layer validated the request's shape; this
 * layer validates what it is about to write), performs the object-level check
 * that the target belongs to the run it was named under, writes through the
 * worker's audited append-only APIs or the dashboard's own append-only
 * stores, and appends a security audit event. Nothing here updates a machine
 * record: a merge, a split and an evidence decision are new rows; a queue
 * decision and a draft edit are new rows; a completed run is never touched.
 */

const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const NOTE = { min: 1, max: 280 } as const;
export const MAX_DRAFT_CHARACTERS = 200_000;
/** Revisions one draft keeps. Append-only, so the bound is a refusal, never a deletion (CAS-006, blocker 7). */
export const MAX_DRAFT_REVISIONS = 1_000;
/** Decisions one queue row of one run keeps. */
export const MAX_QUEUE_DECISIONS_PER_ENTRY = 100;
const MAX_MERGE = 64;
const MAX_SPLIT = 500;

function reasonCode(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REASON_CODE.test(value)) {
    throw validation(`${field}_invalid`, `${field} must be a lower-case reason code`);
  }
  return value;
}

async function audit(
  runtime: Pick<Runtime, 'stores'>,
  event: Omit<AuditEvent, 'id' | 'at' | 'networkKey'>,
): Promise<void> {
  await runtime.stores.audit.append({
    id: randomUUID(),
    at: new Date().toISOString(),
    networkKey: null,
    ...event,
  });
}

// ---------------------------------------------------------------- queue

export interface QueueReviewInput {
  readonly classificationRunId: unknown;
  readonly sourceRowId: unknown;
  readonly reviewState: unknown;
  readonly reasonCode: unknown;
  readonly note: unknown;
}

/**
 * Records a human `ReviewState` for one queue row. Append-only in the
 * dashboard's own store: the weekly review tables are never written, because
 * a source row may carry only one snapshot entry and a dashboard decision is
 * a separate human record with its own actor and reason.
 */
export async function reviewQueueEntry(
  runtime: Runtime,
  who: Principal | null,
  input: QueueReviewInput,
): Promise<{ readonly decisionId: string }> {
  const principal = requireCapability(who, 'review:queue');
  const runId = uuid(input.classificationRunId, 'classificationRunId');
  const sourceRowId = uuid(input.sourceRowId, 'sourceRowId');
  const reviewState = enumOf<ReviewState>(input.reviewState, REVIEW_STATES, 'reviewState');
  const reason = reasonCode(input.reasonCode, 'reasonCode');
  const note = optionalText(input.note, 'note', NOTE);
  const packages = await workspace();
  const { findReviewQueueEntry } = packages.database;
  try {
    // The bound is checked before the queue lookup: it depends only on the
    // dashboard's own append-only store, so a row that has reached it is
    // refused whatever the queue says, and the rule is testable on its own.
    // A row outside the queue holds no decisions and still answers not_found.
    const prior = await runtime.stores.queueDecisions.countForEntry(runId, sourceRowId);
    if (prior >= MAX_QUEUE_DECISIONS_PER_ENTRY) {
      throw validation(
        'decision_limit',
        `A queue row keeps at most ${MAX_QUEUE_DECISIONS_PER_ENTRY} decisions.`,
      );
    }
    const entry = await runtime.database.withClient((client) =>
      findReviewQueueEntry(client, runId, sourceRowId, { withText: false, maxTextCharacters: 1 }),
    );
    if (entry === null) {
      throw new DashboardError(
        'not_found',
        'queue_entry_not_found',
        'That row is not in this run’s review queue.',
      );
    }
    const decisionId = randomUUID();
    // The bound is enforced where the write happens, atomically with it: the
    // early check above is a fast refusal, this is the one that holds when two
    // reviews of the same row arrive together (Codex review of 22 October 2026).
    const appended = await runtime.stores.queueDecisions.appendIfBelow(
      {
        id: decisionId,
        classificationRunId: runId,
        sourceRowId,
        reviewState,
        reasonCode: reason,
        note,
        actorAccountId: principal.accountId,
        createdAt: new Date().toISOString(),
      },
      MAX_QUEUE_DECISIONS_PER_ENTRY,
    );
    if (appended === 'limit') {
      throw validation(
        'decision_limit',
        `A queue row keeps at most ${MAX_QUEUE_DECISIONS_PER_ENTRY} decisions.`,
      );
    }
    await audit(runtime, {
      kind: 'queue_reviewed',
      outcome: 'success',
      code: reviewState,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: sourceRowId,
    });
    return { decisionId };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ------------------------------------------------------------ incidents

export interface MergeInput {
  readonly clusteringRunId: unknown;
  readonly incidentIds: unknown;
  readonly reasonCode: unknown;
  readonly note: unknown;
  readonly expectedRevision: unknown;
}

export async function mergeIncidentsAction(
  runtime: Runtime,
  who: Principal | null,
  input: MergeInput,
): Promise<{ readonly actionId: string; readonly revision: number; readonly outcome: string }> {
  const principal = requireCapability(who, 'review:incidents');
  const runId = uuid(input.clusteringRunId, 'clusteringRunId');
  const incidentIds = uuidList(input.incidentIds, 'incidentIds', MAX_MERGE);
  const reason = reasonCode(input.reasonCode, 'reasonCode');
  const note = optionalText(input.note, 'note', NOTE);
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', {
    min: 0,
    max: 1_000_000,
  });
  const packages = await workspace();
  const { mergeIncidents } = packages.worker;
  try {
    const outcome = await mergeIncidents(runtime.database, {
      runId,
      incidentIds,
      reasonCode: reason,
      note,
      actor: displayIdentity(principal),
      expectedRevision,
    });
    await audit(runtime, {
      kind: 'incident_merged',
      outcome: 'success',
      code: outcome.outcome,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: outcome.action.id,
    });
    return { actionId: outcome.action.id, revision: outcome.revision, outcome: outcome.outcome };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export interface SplitInput {
  readonly clusteringRunId: unknown;
  readonly incidentId: unknown;
  readonly membershipIds: unknown;
  readonly reasonCode: unknown;
  readonly note: unknown;
  readonly expectedRevision: unknown;
}

export async function splitIncidentAction(
  runtime: Runtime,
  who: Principal | null,
  input: SplitInput,
): Promise<{ readonly actionId: string; readonly revision: number; readonly outcome: string }> {
  const principal = requireCapability(who, 'review:incidents');
  const runId = uuid(input.clusteringRunId, 'clusteringRunId');
  const incidentId = uuid(input.incidentId, 'incidentId');
  const membershipIds = uuidList(input.membershipIds, 'membershipIds', MAX_SPLIT);
  const reason = reasonCode(input.reasonCode, 'reasonCode');
  const note = optionalText(input.note, 'note', NOTE);
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', {
    min: 0,
    max: 1_000_000,
  });
  const packages = await workspace();
  const { splitIncident } = packages.worker;
  try {
    const outcome = await splitIncident(runtime.database, {
      runId,
      incidentId,
      membershipIds,
      reasonCode: reason,
      note,
      actor: displayIdentity(principal),
      expectedRevision,
    });
    await audit(runtime, {
      kind: 'incident_split',
      outcome: 'success',
      code: outcome.outcome,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: outcome.action.id,
    });
    return { actionId: outcome.action.id, revision: outcome.revision, outcome: outcome.outcome };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ------------------------------------------------------------- evidence

export interface EvidenceDecisionInput {
  readonly evidenceRunId: unknown;
  readonly associationId: unknown;
  readonly operation: unknown;
  readonly relation: unknown;
  readonly claimId: unknown;
  readonly reasonCode: unknown;
  readonly rationale: unknown;
}

export async function decideEvidence(
  runtime: Runtime,
  who: Principal | null,
  input: EvidenceDecisionInput,
): Promise<{ readonly actionId: string; readonly revision: number; readonly outcome: string }> {
  const principal = requireCapability(who, 'review:evidence');
  const runId = uuid(input.evidenceRunId, 'evidenceRunId');
  const associationId = uuid(input.associationId, 'associationId');
  const operation = enumOf(input.operation, ['accept', 'reject'] as const, 'operation');
  const relation = enumOf(
    input.relation,
    ['supports', 'conflicts', 'context'] as const,
    'relation',
  );
  const claimId =
    input.claimId === undefined || input.claimId === null || input.claimId === ''
      ? null
      : uuid(input.claimId, 'claimId');
  const reason = reasonCode(input.reasonCode, 'reasonCode');
  const rationale = optionalText(input.rationale, 'rationale', NOTE);
  const packages = await workspace();
  const { getEvidenceRun } = packages.database;
  const { decideAssociation } = packages.worker;
  try {
    // Object-level check before the worker's own: the association is read
    // under the named run inside `decideAssociation`, and the run itself is
    // checked here so a caller cannot probe association identifiers across runs.
    const run = await runtime.database.withClient((client) => getEvidenceRun(client, runId));
    if (run === null)
      throw new DashboardError(
        'not_found',
        'evidence_run_not_found',
        'No evidence run with that id.',
      );
    const outcome = await decideAssociation(runtime.database, {
      runId,
      associationId,
      operation,
      relation,
      claimId,
      reasonCode: reason,
      actor: displayIdentity(principal),
      rationale,
    });
    await audit(runtime, {
      kind: 'evidence_decided',
      outcome: 'success',
      code: `${operation}_${outcome.outcome}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: outcome.action.id,
    });
    return { actionId: outcome.action.id, revision: outcome.revision, outcome: outcome.outcome };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// --------------------------------------------------------------- drafts

export interface DraftEditInput {
  readonly evidenceRunId: unknown;
  readonly periodStart: unknown;
  readonly periodEnd: unknown;
  readonly expectedRevision: unknown;
  readonly markdown: unknown;
}

const char = (code: number): string => String.fromCodePoint(code);
/** Everything a draft body refuses: controls other than tab, newline and carriage return; C1; line separators; bidi controls. */
const DRAFT_FORBIDDEN = new RegExp(
  `[${char(0x00)}-${char(0x08)}${char(0x0b)}${char(0x0c)}${char(0x0e)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`,
  'u',
);

/**
 * Appends a human revision of a draft. Optimistic concurrency: the caller
 * declares the revision it edited, and the store refuses any other number,
 * so two editors cannot silently overwrite each other. The generated draft
 * (revision 0) is never stored and never changes.
 */
export async function saveDraftRevision(
  runtime: Runtime,
  who: Principal | null,
  input: DraftEditInput,
): Promise<{ readonly revision: number }> {
  const principal = requireCapability(who, 'edit:draft');
  const runId = uuid(input.evidenceRunId, 'evidenceRunId');
  const start = instant(input.periodStart, 'periodStart');
  const end = instant(input.periodEnd, 'periodEnd');
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', {
    min: 0,
    max: 1_000_000,
  });
  if (typeof input.markdown !== 'string')
    throw validation('markdown_invalid', 'The draft body must be text.');
  const markdown = input.markdown.replace(/\r\n/gu, '\n');
  if (markdown.length < 1 || markdown.length > MAX_DRAFT_CHARACTERS) {
    throw validation(
      'markdown_length',
      `The draft body must be between 1 and ${MAX_DRAFT_CHARACTERS} characters.`,
    );
  }
  if (DRAFT_FORBIDDEN.test(markdown)) {
    throw validation(
      'markdown_control',
      'The draft body must not contain a control or bidirectional character.',
    );
  }
  const packages = await workspace();
  const { getEvidenceRun } = packages.database;
  try {
    const run = await runtime.database.withClient((client) => getEvidenceRun(client, runId));
    if (run === null || run.status !== 'completed') {
      throw new DashboardError(
        'not_found',
        'evidence_run_not_completed',
        'No completed evidence run with that id.',
      );
    }
    const key = draftKeyOf(runId, start, end);
    const latest = await runtime.stores.drafts.latest(key);
    const current = latest?.revision ?? 0;
    if (current >= MAX_DRAFT_REVISIONS) {
      throw validation('revision_limit', `A draft keeps at most ${MAX_DRAFT_REVISIONS} revisions.`);
    }
    if (expectedRevision !== current) {
      throw new DashboardError(
        'conflict',
        'draft_revision_conflict',
        'The draft was revised by someone else; reload and try again.',
      );
    }
    const revision = current + 1;
    await runtime.stores.drafts.append({
      draftKey: key,
      revision,
      markdown,
      savedByAccountId: principal.accountId,
      savedAt: new Date().toISOString(),
    });
    await audit(runtime, {
      kind: 'draft_revision_saved',
      outcome: 'success',
      code: `revision_${revision}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: key,
    });
    return { revision };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ------------------------------------------------------------- accounts

export interface ProvisionInput {
  readonly username: unknown;
  readonly role: unknown;
  readonly expiresAt: unknown;
  readonly password: unknown;
  /** When true an existing account's password is replaced and its sessions revoked. */
  readonly rotate: boolean;
}

function assertUsername(value: unknown): string {
  if (!isUsernameShaped(value)) {
    throw validation(
      'username_invalid',
      'A username is 3 to 32 characters: a lower-case letter, then letters, digits, underscores or hyphens.',
    );
  }
  return value;
}

function assertRoleExpiry(role: Role, expiresAt: string | null, now: Date): void {
  if (role === 'reader' && expiresAt === null) {
    throw validation('reader_expiry_required', 'A reader account requires an expiry instant.');
  }
  if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
    throw validation('expiry_in_past', 'The expiry instant must be in the future.');
  }
}

/**
 * The one-time provisioning path, shared by the command line and the
 * administrator's page. Validates, hashes with a fresh salt, stores the hash
 * and nothing else, and audits. With `rotate` an existing account's hash is
 * replaced and every session of that account is revoked.
 */
export async function provisionAccount(
  runtime: Pick<Runtime, 'stores' | 'sessions'>,
  who: Principal | null,
  input: ProvisionInput,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly fromCommandLine?: boolean | undefined;
  } = {},
): Promise<{ readonly accountId: string; readonly outcome: 'created' | 'rotated' }> {
  const principal =
    options.fromCommandLine === true ? null : requireCapability(who, 'admin:accounts');
  const now = (options.now ?? (() => new Date()))();
  const username = assertUsername(input.username);
  const role = enumOf<Role>(input.role, ROLES, 'role');
  const expiresAt = optionalInstant(input.expiresAt, 'expiresAt');
  assertRoleExpiry(role, expiresAt, now);
  if (typeof input.password !== 'string')
    throw validation('password_invalid', 'A password is required.');
  const normalized = assertPassword(input.password, username);
  const passwordHash = await hashPassword(normalized);
  const existing = await runtime.stores.accounts.findByUsername(username);
  if (existing === null) {
    const account: AccountRecord = {
      id: randomUUID(),
      username,
      role,
      passwordHash,
      createdAt: now.toISOString(),
      passwordChangedAt: now.toISOString(),
      disabledAt: null,
      expiresAt,
      normalizedEmail: null,
    };
    await runtime.stores.accounts.insert(account);
    await audit(runtime, {
      kind: 'account_provisioned',
      outcome: 'success',
      code: role,
      actorAccountId: principal?.accountId ?? null,
      subjectAccountId: account.id,
      sessionId: principal?.sessionId ?? null,
      subjectId: null,
    });
    return { accountId: account.id, outcome: 'created' };
  }
  if (!input.rotate) {
    throw new DashboardError(
      'conflict',
      'account_exists',
      'An account with that username exists; rotate it explicitly.',
    );
  }
  if (existing.role !== role || existing.expiresAt !== expiresAt) {
    throw validation(
      'rotation_changes_role',
      'A rotation may not change the role or the expiry; assign those separately.',
    );
  }
  await runtime.stores.accounts.setPasswordHash(existing.id, passwordHash, now.toISOString());
  await runtime.sessions.revokeAllSessions(principal, existing.id, 'password_rotated', null);
  await audit(runtime, {
    kind: 'account_password_rotated',
    outcome: 'success',
    code: role,
    actorAccountId: principal?.accountId ?? null,
    subjectAccountId: existing.id,
    sessionId: principal?.sessionId ?? null,
    subjectId: null,
  });
  return { accountId: existing.id, outcome: 'rotated' };
}

export interface InviteInput {
  readonly email: unknown;
  readonly role: unknown;
  readonly expiresAt: unknown;
}

/**
 * Invite-only account approval: an administrator names an approved email and
 * a role. Unlike `provisionAccount` there is no secret to enter, so there is
 * no TTY-only requirement — an email address is not a credential — and no
 * rotation path: an email identity, like a username, does not change once
 * an account exists.
 */
export async function inviteAccount(
  runtime: Pick<Runtime, 'stores'>,
  who: Principal | null,
  input: InviteInput,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly fromCommandLine?: boolean | undefined;
  } = {},
): Promise<{ readonly accountId: string }> {
  const principal =
    options.fromCommandLine === true ? null : requireCapability(who, 'admin:accounts');
  const now = (options.now ?? (() => new Date()))();
  const normalized = normalizeEmail(input.email);
  if (normalized === null) {
    throw validation('email_invalid', 'A valid email address is required.');
  }
  const role = enumOf<Role>(input.role, ROLES, 'role');
  const expiresAt = optionalInstant(input.expiresAt, 'expiresAt');
  assertRoleExpiry(role, expiresAt, now);
  const existing = await runtime.stores.accounts.findByNormalizedEmail(normalized);
  if (existing !== null) {
    throw new DashboardError('conflict', 'account_exists', 'An account with that email exists.');
  }
  const account: AccountRecord = {
    id: randomUUID(),
    username: null,
    role,
    passwordHash: null,
    createdAt: now.toISOString(),
    passwordChangedAt: now.toISOString(),
    disabledAt: null,
    expiresAt,
    normalizedEmail: normalized,
  };
  await runtime.stores.accounts.insert(account);
  await audit(runtime, {
    kind: 'account_provisioned',
    outcome: 'success',
    code: role,
    actorAccountId: principal?.accountId ?? null,
    subjectAccountId: account.id,
    sessionId: principal?.sessionId ?? null,
    subjectId: null,
  });
  return { accountId: account.id };
}

export async function disableAccount(
  runtime: Runtime,
  who: Principal | null,
  accountId: unknown,
): Promise<void> {
  const principal = requireCapability(who, 'admin:accounts');
  const id = uuid(accountId, 'accountId');
  if (id === principal.accountId) {
    throw validation('cannot_disable_self', 'An administrator cannot disable their own account.');
  }
  const account = await runtime.stores.accounts.getById(id);
  if (account === null)
    throw new DashboardError('not_found', 'account_not_found', 'No account with that id.');
  const now = new Date().toISOString();
  await runtime.stores.accounts.setDisabled(id, now);
  await runtime.sessions.revokeAllSessions(principal, id, 'account_disabled', null);
  await audit(runtime, {
    kind: 'account_disabled',
    outcome: 'success',
    code: account.role,
    actorAccountId: principal.accountId,
    subjectAccountId: id,
    sessionId: principal.sessionId,
    subjectId: null,
  });
}

export interface RoleAssignment {
  readonly accountId: unknown;
  readonly role: unknown;
  readonly expiresAt: unknown;
}

/**
 * Assigns a role and, with it, the expiry. Every session of the subject is
 * revoked, so a token issued under the old privilege stops working. An
 * administrator cannot change their own role, which keeps the last
 * administrator from locking everyone out by accident.
 */
export async function assignRole(
  runtime: Runtime,
  who: Principal | null,
  input: RoleAssignment,
): Promise<void> {
  const principal = requireCapability(who, 'admin:accounts');
  const id = uuid(input.accountId, 'accountId');
  const role = enumOf<Role>(input.role, ROLES, 'role');
  const expiresAt = optionalInstant(input.expiresAt, 'expiresAt');
  const now = new Date();
  assertRoleExpiry(role, expiresAt, now);
  if (id === principal.accountId) {
    throw validation('cannot_change_own_role', 'An administrator cannot change their own role.');
  }
  const account = await runtime.stores.accounts.getById(id);
  if (account === null)
    throw new DashboardError('not_found', 'account_not_found', 'No account with that id.');
  await runtime.stores.accounts.setRole(id, role, expiresAt);
  await runtime.sessions.revokeAllSessions(principal, id, 'role_assigned', null);
  await audit(runtime, {
    kind: 'account_role_assigned',
    outcome: 'success',
    code: role,
    actorAccountId: principal.accountId,
    subjectAccountId: id,
    sessionId: principal.sessionId,
    subjectId: null,
  });
}

export async function setAccountExpiry(
  runtime: Runtime,
  who: Principal | null,
  accountId: unknown,
  expiresAt: unknown,
): Promise<void> {
  const principal = requireCapability(who, 'admin:accounts');
  const id = uuid(accountId, 'accountId');
  const at = optionalInstant(expiresAt, 'expiresAt');
  const account = await runtime.stores.accounts.getById(id);
  if (account === null)
    throw new DashboardError('not_found', 'account_not_found', 'No account with that id.');
  assertRoleExpiry(account.role, at, new Date());
  await runtime.stores.accounts.setExpiresAt(id, at);
  await audit(runtime, {
    kind: 'account_expiry_set',
    outcome: 'success',
    code: at === null ? 'cleared' : 'set',
    actorAccountId: principal.accountId,
    subjectAccountId: id,
    sessionId: principal.sessionId,
    subjectId: null,
  });
}

export async function revokeAccountSessions(
  runtime: Runtime,
  who: Principal | null,
  accountId: unknown,
): Promise<{ readonly revoked: number }> {
  const principal = requireCapability(who, 'admin:sessions');
  const id = uuid(accountId, 'accountId');
  const account = await runtime.stores.accounts.getById(id);
  if (account === null)
    throw new DashboardError('not_found', 'account_not_found', 'No account with that id.');
  const except = id === principal.accountId ? principal.sessionId : null;
  const revoked = await runtime.sessions.revokeAllSessions(
    principal,
    id,
    'administrator_revocation',
    except,
  );
  return { revoked };
}

/** Bounded text helper re-exported for the action layer's own use. */
export { boundedText };

// ------------------------------------------------------------ the editorial week (CAS-003)

export interface StorySelectionInput {
  readonly weekRunId: unknown;
  readonly clusteringRunId: unknown;
  readonly incidentId: unknown;
  readonly state: unknown;
  readonly note: unknown;
}

const SELECTION_STATES = ['selected', 'unselected'] as const;
const SELECTION_NOTE = { min: 1, max: 2000 } as const;

/**
 * Records the owner's decision on one incident for one week (D38): an
 * append-only record with the next revision, carrying the incident's member
 * rows as references. The capability is `select:stories`; the week must be
 * completed; the clustering run must be the one the week recorded for its
 * category (the database guard enforces it too). A concurrent record for the
 * same incident is a conflict, never a silent overwrite.
 */
export async function selectStory(
  runtime: Runtime,
  who: Principal | null,
  input: StorySelectionInput,
): Promise<{ readonly selectionId: string; readonly revision: number }> {
  try {
    return await selectStoryUnaudited(runtime, who, input);
  } catch (error) {
    // Every refusal with a known actor is audited with its fixed code and the
    // incident it named when that is a well-formed identifier, never content
    // (review of 22 October 2026, F4). An unauthenticated caller has no actor
    // to record; the conflict path records itself.
    if (
      who !== null &&
      isDashboardError(error) &&
      error.kind !== 'unavailable' &&
      error.code !== 'selection_conflict'
    ) {
      await audit(runtime, {
        kind: 'story_selected',
        outcome: 'failure',
        code: error.code,
        actorAccountId: who.accountId,
        subjectAccountId: null,
        sessionId: who.sessionId,
        subjectId:
          typeof input.incidentId === 'string' && UUID_SHAPE.test(input.incidentId)
            ? input.incidentId
            : null,
      });
    }
    throw error;
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function selectStoryUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: StorySelectionInput,
): Promise<{ readonly selectionId: string; readonly revision: number }> {
  const principal = requireCapability(who, 'select:stories');
  // A selection names its actor by a foreign key to the accounts table, so it
  // exists only where accounts are persistent. The memory account store of a
  // local run cannot carry that provenance, and says so rather than failing
  // opaquely.
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Selecting stories needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  const clusteringRunId = uuid(input.clusteringRunId, 'clusteringRunId');
  const incidentId = uuid(input.incidentId, 'incidentId');
  const state = enumOf(input.state, SELECTION_STATES, 'state');
  const note = optionalText(input.note, 'note', SELECTION_NOTE);
  const packages = await workspace();
  const {
    getWeekRun,
    insertIssueSelection,
    isDatabaseError,
    lastSelectionRevision,
    listIncidentMemberRefs,
    listWeekRunChildren,
  } = packages.database;
  try {
    const week = await runtime.database.withClient((client) => getWeekRun(client, weekRunId));
    if (week === null) {
      throw new DashboardError('not_found', 'week_run_not_found', 'No week run with that id.');
    }
    if (week.status !== 'completed') {
      throw validation('week_not_completed', 'Only a completed week can be selected from.');
    }
    const children = await runtime.database.withClient((client) =>
      listWeekRunChildren(client, weekRunId),
    );
    const child = children.find(
      (c) => c.kind === 'clustering' && c.clusteringRunId === clusteringRunId,
    );
    if (child === undefined || child.category === null) {
      throw new DashboardError(
        'not_found',
        'clustering_run_not_in_week',
        'That clustering run is not one this week recorded.',
      );
    }
    const category = child.category;
    const members = await runtime.database.withClient((client) =>
      listIncidentMemberRefs(client, clusteringRunId, incidentId),
    );
    if (members.length === 0) {
      throw new DashboardError(
        'not_found',
        'incident_not_found',
        'No incident with that id in this run.',
      );
    }
    const selectionId = randomUUID();
    let revision = 0;
    try {
      revision = await runtime.database.withTransaction(async (tx) => {
        const next = (await lastSelectionRevision(tx, weekRunId, incidentId)) + 1;
        await insertIssueSelection(
          tx,
          {
            id: selectionId,
            weekRunId,
            batchId: week.batchId,
            clusteringRunId,
            incidentId,
            category,
            state,
            revision: next,
            actorAccountId: principal.accountId,
            note,
            createdAt: new Date().toISOString(),
          },
          members,
        );
        return next;
      });
    } catch (error) {
      if (isDatabaseError(error) && (error.code === '23505' || error.code === 'P0001')) {
        await audit(runtime, {
          kind: 'story_selected',
          outcome: 'failure',
          code: 'selection_conflict',
          actorAccountId: principal.accountId,
          subjectAccountId: null,
          sessionId: principal.sessionId,
          subjectId: incidentId,
        });
        throw new DashboardError(
          'conflict',
          'selection_conflict',
          'The selection changed while you were working; reload and try again.',
        );
      }
      throw error;
    }
    await audit(runtime, {
      kind: 'story_selected',
      outcome: 'success',
      code: state,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: incidentId,
    });
    return { selectionId, revision };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ------------------------------------------------------------ the round-up (CAS-004)

export interface RoundupGenerationInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  /** The template hash the page showed; a mismatch refuses (D40). */
  readonly expectedTemplateHash: unknown;
}

export interface RoundupEditInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  readonly expectedRevision: unknown;
  readonly markdown: unknown;
}

/** The most selected rows a generation accepts; one more is fetched, and a full page refuses (review F5). */
const SELECTION_ROWS_FOR_GENERATION = 10_000;
/** The most flagged entries a revision can hold (the stored slot schema's bound; review F6). */
const FLAGGED_FOR_GENERATION = 200;
/**
 * The most characters a round-up revision holds: migration 0015's bound and
 * the package's MAX_MARKDOWN_CHARACTERS, repeated here because the layer may
 * not import the package statically; a test holds the three equal. The
 * editor's bound is the stored bound, so every generated revision is editable
 * (re-review RR3).
 */
export const MAX_ROUNDUP_CHARACTERS = 400_000;

/**
 * One generation at a time per schema (review F4, re-review RR2). The lock
 * is tried, never waited for, on one connection, and every protected read
 * and write runs on that same connection, so a generation holds exactly one
 * pooled connection whatever the pool size: a concurrent submission is
 * refused at once with a fixed conflict instead of queueing with a
 * connection in hand, which at pool-sized concurrency starved the holder.
 * Released on every exit.
 */
async function withGenerationLock<T>(
  runtime: Runtime,
  work: (holder: Queryable) => Promise<T>,
): Promise<T> {
  const key = `${runtime.database.schema}:roundup-generation`;
  return runtime.database.withClient(async (holder) => {
    const claimed = await holder.query<{ locked: boolean }>(
      'SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',
      [key],
    );
    if (claimed.rows[0]?.locked !== true) {
      throw new DashboardError(
        'conflict',
        'roundup_generation_in_progress',
        'A generation is in progress; wait for it to finish.',
      );
    }
    try {
      return await work(holder);
    } finally {
      await holder.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))', [key]);
    }
  });
}

/** A transaction on one given connection, for work that must not take a second one. */
async function transactionOn<T>(client: Queryable, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const CATEGORY_SHAPE = /^[a-z][a-z0-9_]{1,31}$/u;
const HASH_SHAPE = /^[0-9a-f]{64}$/u;
const CARRIED_REASON = 'first seen after the previous week’s freeze; carried per D10';

interface SnapshotRow {
  readonly sourceRowId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string;
  readonly publisher: string;
  readonly postedAt: string | null;
}

/**
 * One generation for one week and category (report, sections 1.3 to 1.8):
 * the owner's capability, persistent accounts, a completed week, the
 * selection snapshot and nothing else as input, the deterministic flagged
 * entries, the cap from the ledger, one request through the runtime's
 * transport, and both revisions written with the ledger row in one
 * transaction. Every refusal is a fixed code, recorded in the ledger and the
 * audit log without content. A second generation is refused: the owner edits.
 */
export async function generateRoundup(
  runtime: Runtime,
  who: Principal | null,
  input: RoundupGenerationInput,
): Promise<RoundupGenerationResult> {
  try {
    return await generateRoundupUnaudited(runtime, who, input);
  } catch (error) {
    // Every refusal with a known actor is audited once, at this boundary, with
    // its fixed code and the week it named when well formed, never content
    // (the rule review F4 set for selections). A database outage is not a
    // refusal and is not audited; a model-side failure is, by its code.
    if (
      who !== null &&
      isDashboardError(error) &&
      (error.kind !== 'unavailable' || MODEL_FAILURE_CODE.test(error.code))
    ) {
      await audit(runtime, {
        kind: 'roundup_refused',
        outcome: 'failure',
        code: error.code,
        actorAccountId: who.accountId,
        subjectAccountId: null,
        sessionId: who.sessionId,
        subjectId:
          typeof input.weekRunId === 'string' && UUID_SHAPE.test(input.weekRunId)
            ? input.weekRunId
            : null,
      });
    }
    throw error;
  }
}

const MODEL_FAILURE_CODE = /^(?:model_|response_)/u;

interface RoundupGenerationResult {
  readonly revision: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
}

async function generateRoundupUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: RoundupGenerationInput,
): Promise<RoundupGenerationResult> {
  const principal = requireCapability(who, 'generate:roundup');
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Generating a round-up needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  const category = input.category;
  if (
    typeof input.expectedTemplateHash !== 'string' ||
    !HASH_SHAPE.test(input.expectedTemplateHash)
  ) {
    throw validation('template_hash_invalid', 'The template hash is not valid.');
  }
  const expectedTemplateHash = input.expectedTemplateHash;
  const packages = await workspace();
  const {
    getWeekRun,
    insertModelCall,
    insertRoundupRevision,
    listCarriedIncidents,
    listOmittedIncidents,
    listRoundupRevisions,
    listSelectedRows,
    listWeekRunChildren,
    spendBetween,
  } = packages.database;
  const {
    costMicrodollars,
    generateRoundup: runGeneration,
    isRoundupError,
    loadTemplate,
    MODEL_ID,
    publisherOf,
  } = packages.roundup;
  try {
    const week = await runtime.database.withClient((client) => getWeekRun(client, weekRunId));
    if (week === null) {
      throw new DashboardError('not_found', 'week_run_not_found', 'No week run with that id.');
    }
    if (week.status !== 'completed' || !week.categories.includes(category)) {
      throw validation('week_not_ready', 'The week must be completed and cover that category.');
    }
    const assertNotGenerated = async (client: Queryable): Promise<void> => {
      const existing = await listRoundupRevisions(client, weekRunId, category);
      if (existing.length > 0) {
        throw validation(
          'roundup_already_generated',
          'This round-up was generated; edit it instead.',
        );
      }
    };
    await runtime.database.withClient(assertNotGenerated);
    const children = await runtime.database.withClient((client) =>
      listWeekRunChildren(client, weekRunId),
    );
    const clustering = children.find((c) => c.kind === 'clustering' && c.category === category);
    if (clustering === undefined || clustering.clusteringRunId === null) {
      throw new DashboardError(
        'not_found',
        'week_category_not_clustered',
        'This week has no clustering run for that category.',
      );
    }
    const clusteringRunId = clustering.clusteringRunId;

    // The input: the selection snapshot in selection order, and the
    // deterministic flagged entries. Nothing else crosses to the model.
    const rows = await runtime.database.withClient((client) =>
      listSelectedRows(client, weekRunId, category, SELECTION_ROWS_FOR_GENERATION + 1),
    );
    if (rows.length > SELECTION_ROWS_FOR_GENERATION) {
      // Never a prefix: a selection past the bound is refused whole (review F5).
      throw validation(
        'selection_too_large',
        'The selection holds more rows than one round-up can carry.',
      );
    }
    const incidents: { incidentId: string; rows: SnapshotRow[] }[] = [];
    for (const row of rows) {
      let incident = incidents.find((i) => i.incidentId === row.incidentId);
      if (incident === undefined) {
        incident = { incidentId: row.incidentId, rows: [] };
        incidents.push(incident);
      }
      incident.rows.push({
        sourceRowId: row.sourceRowId,
        title: row.title,
        summary: row.summary,
        url: row.url,
        publisher: publisherOf(row.url),
        postedAt: row.postedAt,
      });
    }
    const omitted = await runtime.database.withClient((client) =>
      listOmittedIncidents(client, weekRunId, category, FLAGGED_FOR_GENERATION + 1),
    );
    if (omitted.length > FLAGGED_FOR_GENERATION) {
      throw validation(
        'flagged_too_many',
        'The week has more omitted incidents than one round-up can list.',
      );
    }
    // The carried incidents, exhaustively: not a page of the sift table (its
    // 1,000-row page dropped the rest silently, re-review RR4) but a read of
    // every carried, unselected, un-omitted incident, bound plus one.
    const carried = await runtime.database.withClient((client) =>
      listCarriedIncidents(client, {
        clusteringRunId,
        weekRunId,
        category,
        windowStart: week.windowStart,
        windowEnd: week.windowEnd,
        limit: FLAGGED_FOR_GENERATION + 1,
      }),
    );
    if (omitted.length + carried.length > FLAGGED_FOR_GENERATION) {
      throw validation(
        'flagged_too_many',
        'The week has more flagged incidents than one round-up can list.',
      );
    }
    const flagged = [
      ...omitted.map((entry) => ({
        incidentId: entry.incidentId,
        headline: entry.title,
        reason: entry.reason,
        disposition: 'omit' as const,
      })),
      ...carried.map((row) => ({
        incidentId: row.incidentId,
        headline: row.title.length > 0 ? row.title : 'untitled',
        reason: CARRIED_REASON,
        disposition: 'carry' as const,
      })),
    ];
    const snapshot = {
      weekRunId,
      category,
      windowStart: week.windowStart,
      windowEnd: week.windowEnd,
      incidents,
      flagged,
    };
    if (flagged.length > FLAGGED_FOR_GENERATION) {
      throw validation(
        'flagged_too_many',
        'The week has more flagged incidents than one round-up can list.',
      );
    }
    const loaded = await loadTemplate();
    await audit(runtime, {
      kind: 'roundup_requested',
      outcome: 'success',
      code: category,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    const ledger = (
      holder: Queryable,
      outcome: 'completed' | 'refused' | 'failed',
      code: string,
      usage: { inputTokens: number; outputTokens: number; costMicrodollars: number },
      model: string,
    ): Promise<void> =>
      transactionOn(holder, () =>
        insertModelCall(holder, {
          id: randomUUID(),
          kind: 'roundup',
          weekRunId,
          category,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrodollars: usage.costMicrodollars,
          outcome,
          code,
          actorAccountId: principal.accountId,
          createdAt: new Date().toISOString(),
        }),
      );
    // One generation at a time per schema (review F4): the claim, the cap
    // check, the one request, the ledger row and the revisions happen under
    // an advisory lock held on a dedicated connection, so two submissions
    // cannot both observe an empty round-up and both call the model. The
    // ledger row is written in its own transaction before the revisions, so
    // a billed request keeps its record even if persistence fails after it.
    const generation = await withGenerationLock(runtime, async (holder) => {
      await assertNotGenerated(holder);
      const bounds = monthBounds(new Date());
      const spentThisMonth = await spendBetween(holder, 'roundup', bounds.from, bounds.to);
      let produced;
      try {
        produced = await runGeneration(snapshot, loaded, runtime.model, {
          spentThisMonth,
          expectedTemplateHash,
        });
      } catch (error) {
        if (!isRoundupError(error)) throw error;
        const refused =
          error.code === 'spend_cap_exceeded' ||
          error.code === 'template_hash_mismatch' ||
          error.code === 'model_key_missing' ||
          error.code === 'input_empty' ||
          error.code === 'input_invalid' ||
          error.code === 'input_too_long';
        // A request the model answered is billed whatever the verdict on the
        // answer (review F3): the ledger records its real usage and cost.
        const billed = error.billed;
        await ledger(
          holder,
          refused ? 'refused' : 'failed',
          error.code,
          billed === null
            ? { inputTokens: 0, outputTokens: 0, costMicrodollars: 0 }
            : {
                inputTokens: billed.inputTokens,
                outputTokens: billed.outputTokens,
                costMicrodollars: costMicrodollars(billed),
              },
          billed?.model ?? MODEL_ID,
        );
        if (
          error.code === 'model_key_missing' ||
          error.code === 'model_failed' ||
          error.code === 'model_refused'
        ) {
          throw new DashboardError(
            'unavailable',
            error.code,
            'The model request could not be completed; nothing was written.',
          );
        }
        if (error.code.startsWith('response_')) {
          throw new DashboardError(
            'unavailable',
            error.code,
            'The response was rejected; nothing was written.',
          );
        }
        throw validation(error.code, error.message);
      }
      await ledger(
        holder,
        'completed',
        'completed',
        {
          inputTokens: produced.provenance.inputTokens,
          outputTokens: produced.provenance.outputTokens,
          costMicrodollars: produced.provenance.costMicrodollars,
        },
        produced.provenance.model,
      );
      const now = new Date().toISOString();
      await transactionOn(holder, async () => {
        await insertRoundupRevision(holder, {
          weekRunId,
          category,
          revision: 0,
          kind: 'deterministic',
          slots: produced.deterministic.slots,
          markdown: produced.deterministic.markdown,
          provenance: null,
          savedByAccountId: principal.accountId,
          createdAt: now,
        });
        await insertRoundupRevision(holder, {
          weekRunId,
          category,
          revision: 1,
          kind: 'generated',
          slots: produced.generated.slots,
          markdown: produced.generated.markdown,
          provenance: produced.provenance,
          savedByAccountId: principal.accountId,
          createdAt: now,
        });
      });
      return produced;
    });
    await audit(runtime, {
      kind: 'roundup_completed',
      outcome: 'success',
      code: `cost_${generation.provenance.costMicrodollars}_in_${generation.provenance.inputTokens}_out_${generation.provenance.outputTokens}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    return {
      revision: 1,
      inputTokens: generation.provenance.inputTokens,
      outputTokens: generation.provenance.outputTokens,
      costMicrodollars: generation.provenance.costMicrodollars,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

/** The owner's edit: the next revision, under the expected one, like a draft revision. */
export async function saveRoundupRevision(
  runtime: Runtime,
  who: Principal | null,
  input: RoundupEditInput,
): Promise<{ readonly revision: number }> {
  try {
    return await saveRoundupRevisionUnaudited(runtime, who, input);
  } catch (error) {
    // As for the generation: every refusal with a known actor, including a
    // revision conflict, is audited once here with its fixed code.
    if (who !== null && isDashboardError(error) && error.kind !== 'unavailable') {
      await audit(runtime, {
        kind: 'roundup_edited',
        outcome: 'failure',
        code: error.code,
        actorAccountId: who.accountId,
        subjectAccountId: null,
        sessionId: who.sessionId,
        subjectId:
          typeof input.weekRunId === 'string' && UUID_SHAPE.test(input.weekRunId)
            ? input.weekRunId
            : null,
      });
    }
    throw error;
  }
}

async function saveRoundupRevisionUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: RoundupEditInput,
): Promise<{ readonly revision: number }> {
  const principal = requireCapability(who, 'edit:output');
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Editing a round-up needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  const category = input.category;
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', {
    min: 0,
    max: 1_000_000,
  });
  if (typeof input.markdown !== 'string')
    throw validation('markdown_invalid', 'The round-up body must be text.');
  const markdown = input.markdown.replace(/\r\n/gu, '\n');
  if (markdown.length < 1 || markdown.length > MAX_ROUNDUP_CHARACTERS) {
    throw validation(
      'markdown_length',
      `The round-up body must be between 1 and ${MAX_ROUNDUP_CHARACTERS} characters.`,
    );
  }
  if (DRAFT_FORBIDDEN.test(markdown)) {
    throw validation(
      'markdown_control',
      'The round-up body must not contain a control or bidirectional character.',
    );
  }
  const packages = await workspace();
  const { insertRoundupRevision, isDatabaseError, latestRoundupRevision } = packages.database;
  try {
    const latest = await runtime.database.withClient((client) =>
      latestRoundupRevision(client, weekRunId, category),
    );
    if (latest === null) {
      throw new DashboardError(
        'not_found',
        'roundup_not_generated',
        'No round-up exists for that week and category.',
      );
    }
    if (latest.revision >= MAX_DRAFT_REVISIONS) {
      throw validation(
        'revision_limit',
        `A round-up keeps at most ${MAX_DRAFT_REVISIONS} revisions.`,
      );
    }
    if (expectedRevision !== latest.revision) {
      throw new DashboardError(
        'conflict',
        'roundup_revision_conflict',
        'The round-up was revised by someone else; reload and try again.',
      );
    }
    const revision = latest.revision + 1;
    try {
      await runtime.database.withTransaction((tx) =>
        insertRoundupRevision(tx, {
          weekRunId,
          category,
          revision,
          kind: 'edited',
          slots: latest.slots,
          markdown,
          provenance: null,
          savedByAccountId: principal.accountId,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isDatabaseError(error) && (error.code === '23505' || error.code === 'P0001')) {
        throw new DashboardError(
          'conflict',
          'roundup_revision_conflict',
          'The round-up was revised by someone else; reload and try again.',
        );
      }
      throw error;
    }
    await audit(runtime, {
      kind: 'roundup_edited',
      outcome: 'success',
      code: `revision_${revision}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    return { revision };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ---------------------------------------------------------------- the article (CAS-005)

export interface ArticleReadingInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
}

export interface ArticleGenerationInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  /** The reading the owner confirmed, by its identifier (R17). */
  readonly readingId: unknown;
}

export interface ArticleEditInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  readonly expectedRevision: unknown;
  readonly markdown: unknown;
}

export interface ArticleReadingResult {
  readonly readingId: string;
  readonly read: number;
  readonly partlyRead: number;
  readonly notRead: number;
}

interface ArticleGenerationResult {
  readonly revision: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
  readonly wordCount: number;
}

const READING_ID_SHAPE = /^[0-9a-f]{32}$/u;

async function auditArticleRefusal(
  runtime: Runtime,
  who: Principal | null,
  kind: 'article_refused' | 'article_edited',
  error: unknown,
  weekRunId: unknown,
): Promise<void> {
  // Every refusal with a known actor is audited once, at the boundary, with
  // its fixed code and the week it named when well formed, never content;
  // a database outage is not a refusal, a model-side or reader-side failure
  // is, by its code.
  if (
    who !== null &&
    isDashboardError(error) &&
    (error.kind !== 'unavailable' || /^(?:model_|response_|reader_)/u.test(error.code))
  ) {
    await audit(runtime, {
      kind,
      outcome: 'failure',
      code: error.code,
      actorAccountId: who.accountId,
      subjectAccountId: null,
      sessionId: who.sessionId,
      subjectId: typeof weekRunId === 'string' && UUID_SHAPE.test(weekRunId) ? weekRunId : null,
    });
  }
}

/** The week, the category and the selection an article request names, checked once for all three mutations. */
async function articleSelection(
  runtime: Runtime,
  weekRunId: string,
  category: string,
): Promise<{
  readonly week: Awaited<
    ReturnType<Awaited<ReturnType<typeof workspace>>['database']['getWeekRun']>
  > &
    object;
  readonly rows: Awaited<
    ReturnType<Awaited<ReturnType<typeof workspace>>['database']['listSelectedRows']>
  >;
}> {
  const { getWeekRun, listSelectedRows } = (await workspace()).database;
  const week = await runtime.database.withClient((client) => getWeekRun(client, weekRunId));
  if (week === null) {
    throw new DashboardError('not_found', 'week_run_not_found', 'No week run with that id.');
  }
  if (week.status !== 'completed' || !week.categories.includes(category)) {
    throw validation('week_not_ready', 'The week must be completed and cover that category.');
  }
  const rows = await runtime.database.withClient((client) =>
    listSelectedRows(client, weekRunId, category, SELECTION_ROWS_FOR_GENERATION),
  );
  if (rows.length === 0) {
    throw validation('selection_empty', 'No story is selected for that week and category.');
  }
  return { week, rows };
}

/**
 * The reading stage (R13, R16, R17): every selected source's canonical URL,
 * and nothing else, is read under the fetch policy; one audit event per
 * source carries the row, the outcome code, bytes and duration, never a URL;
 * the reading is held in memory under a random identifier for the owner to
 * confirm. Nothing is written to the database.
 */
export async function readArticleSources(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleReadingInput,
): Promise<ArticleReadingResult> {
  try {
    return await readArticleSourcesUnaudited(runtime, who, input);
  } catch (error) {
    await auditArticleRefusal(runtime, who, 'article_refused', error, input.weekRunId);
    throw error;
  }
}

async function readArticleSourcesUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleReadingInput,
): Promise<ArticleReadingResult> {
  const principal = requireCapability(who, 'generate:article');
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Writing an article needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  const category = input.category;
  const packages = await workspace();
  try {
    const { rows } = await articleSelection(runtime, weekRunId, category);
    const existing = await runtime.database.withClient((client) =>
      packages.database.listArticleRevisions(client, weekRunId, category),
    );
    if (existing.length > 0) {
      throw validation('article_already_generated', 'This article was written; edit it instead.');
    }
    if (runtime.reader === null) {
      throw new DashboardError(
        'unavailable',
        'reader_not_configured',
        'The dashboard has no public address configured; sources cannot be read.',
      );
    }
    const reading = await packages.sourceReader.readSources(
      rows.map((row) => ({ sourceRowId: row.sourceRowId, url: row.url })),
      runtime.reader,
    );
    for (const outcome of reading.outcomes) {
      await audit(runtime, {
        kind: 'source_fetched',
        outcome: outcome.status === 'not_read' ? 'failure' : 'success',
        code: `bytes_${outcome.bytes}_ms_${outcome.ms}_${outcome.code ?? outcome.status}`,
        actorAccountId: principal.accountId,
        subjectAccountId: null,
        sessionId: principal.sessionId,
        subjectId: outcome.sourceRowId,
      });
    }
    const entry = runtime.readings.put({
      weekRunId,
      category,
      accountId: principal.accountId,
      reading,
    });
    return {
      readingId: entry.id,
      read: reading.outcomes.filter((o) => o.status === 'read').length,
      partlyRead: reading.outcomes.filter((o) => o.status === 'partly_read').length,
      notRead: reading.outcomes.filter((o) => o.status === 'not_read').length,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

/**
 * The generation, on the owner's confirmation of a reading: the input is the
 * selection's recorded fields with what the reading left of each page;
 * one request; revision 1 and the ledger row in one transaction; the reading
 * dropped from memory. Every outcome is a ledger row and an audit event with
 * counts and codes, never content.
 */
export async function generateArticle(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleGenerationInput,
): Promise<ArticleGenerationResult> {
  try {
    return await generateArticleUnaudited(runtime, who, input);
  } catch (error) {
    await auditArticleRefusal(runtime, who, 'article_refused', error, input.weekRunId);
    throw error;
  }
}

async function generateArticleUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleGenerationInput,
): Promise<ArticleGenerationResult> {
  const principal = requireCapability(who, 'generate:article');
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Writing an article needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  const category = input.category;
  if (typeof input.readingId !== 'string' || !READING_ID_SHAPE.test(input.readingId)) {
    throw validation('reading_id_invalid', 'The reading identifier is not valid.');
  }
  const readingId = input.readingId;
  const packages = await workspace();
  const { insertArticleRevision, insertModelCall, listArticleRevisions, spendBetween } =
    packages.database;
  const {
    generateArticle: runGeneration,
    isArticleError,
    MODEL_ID,
    publisherOf,
  } = {
    ...packages.article,
    publisherOf: packages.roundup.publisherOf,
  };
  try {
    const { week, rows } = await articleSelection(runtime, weekRunId, category);
    const existing = await runtime.database.withClient((client) =>
      listArticleRevisions(client, weekRunId, category),
    );
    if (existing.length > 0) {
      throw validation('article_already_generated', 'This article was written; edit it instead.');
    }
    const entry = runtime.readings.get(readingId);
    if (
      entry === null ||
      entry.weekRunId !== weekRunId ||
      entry.category !== category ||
      entry.accountId !== principal.accountId
    ) {
      throw validation(
        'reading_not_found',
        'That reading expired or is not yours; read the sources again.',
      );
    }
    const outcomes = new Map<string, SourceOutcome>(
      entry.reading.outcomes.map((outcome) => [outcome.sourceRowId, outcome]),
    );
    // Every selected row must be in the reading, and every reading outcome a
    // selected row: a selection that changed since the reading is read again.
    if (rows.length !== outcomes.size || rows.some((row) => !outcomes.has(row.sourceRowId))) {
      throw validation('reading_stale', 'The selection changed since the reading; read again.');
    }
    const incidents: {
      incidentId: string;
      rows: ArticleInput['incidents'][number]['rows'][number][];
    }[] = [];
    for (const row of rows) {
      let incident = incidents.find((i) => i.incidentId === row.incidentId);
      if (incident === undefined) {
        incident = { incidentId: row.incidentId, rows: [] };
        incidents.push(incident);
      }
      const outcome = outcomes.get(row.sourceRowId) as SourceOutcome;
      incident.rows.push({
        sourceRowId: row.sourceRowId,
        title: row.title,
        summary: row.summary,
        url: row.url,
        publisher: publisherOf(row.url),
        postedAt: row.postedAt,
        reading:
          outcome.status === 'not_read'
            ? {
                status: 'not_read',
                code: outcome.code,
                text: null,
                digest: null,
                bytes: outcome.bytes,
              }
            : {
                status: outcome.status,
                code: outcome.code,
                text: outcome.text,
                digest: outcome.digest,
                bytes: outcome.bytes,
              },
      });
    }
    const articleInput: ArticleInput = {
      weekRunId,
      category,
      windowStart: week.windowStart,
      windowEnd: week.windowEnd,
      incidents,
    };
    const bounds = monthBounds(new Date());
    const spentThisMonth = await runtime.database.withClient((client) =>
      spendBetween(client, 'article', bounds.from, bounds.to),
    );
    await audit(runtime, {
      kind: 'article_requested',
      outcome: 'success',
      code: category,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    const ledger = (
      outcome: 'completed' | 'refused' | 'failed',
      code: string,
      usage: { inputTokens: number; outputTokens: number; costMicrodollars: number },
      model: string,
    ): Promise<void> =>
      runtime.database.withTransaction((tx) =>
        insertModelCall(tx, {
          id: randomUUID(),
          kind: 'article',
          weekRunId,
          category,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrodollars: usage.costMicrodollars,
          outcome,
          code,
          actorAccountId: principal.accountId,
          createdAt: new Date().toISOString(),
        }),
      );
    let generation;
    try {
      generation = await runGeneration(articleInput, runtime.model, { spentThisMonth });
    } catch (error) {
      if (!isArticleError(error)) throw error;
      const refused =
        error.code === 'spend_cap_exceeded' ||
        error.code === 'model_key_missing' ||
        error.code === 'input_empty' ||
        error.code === 'input_invalid' ||
        error.code === 'input_too_large';
      await ledger(
        refused ? 'refused' : 'failed',
        error.code,
        { inputTokens: 0, outputTokens: 0, costMicrodollars: 0 },
        MODEL_ID,
      );
      if (
        error.code === 'model_key_missing' ||
        error.code === 'model_failed' ||
        error.code === 'model_refused'
      ) {
        throw new DashboardError(
          'unavailable',
          error.code,
          'The model request could not be completed; nothing was written.',
        );
      }
      if (error.code.startsWith('response_')) {
        throw new DashboardError(
          'unavailable',
          error.code,
          'The response was rejected; nothing was written.',
        );
      }
      throw validation(error.code, error.message);
    }
    const now = new Date().toISOString();
    await runtime.database.withTransaction(async (tx) => {
      await insertArticleRevision(tx, {
        weekRunId,
        category,
        revision: 1,
        kind: 'generated',
        slots: generation.slots,
        markdown: generation.markdown,
        provenance: {
          model: generation.provenance.model,
          promptVersion: generation.provenance.promptVersion,
          promptHash: generation.provenance.promptHash,
          inputDigest: generation.provenance.inputDigest,
          inputTokens: generation.provenance.inputTokens,
          outputTokens: generation.provenance.outputTokens,
          costMicrodollars: generation.provenance.costMicrodollars,
          wordCount: generation.provenance.wordCount,
          namingBasis: generation.provenance.namingBasis,
          sources: generation.provenance.sources,
        },
        savedByAccountId: principal.accountId,
        createdAt: now,
      });
      await insertModelCall(tx, {
        id: randomUUID(),
        kind: 'article',
        weekRunId,
        category,
        model: generation.provenance.model,
        inputTokens: generation.provenance.inputTokens,
        outputTokens: generation.provenance.outputTokens,
        costMicrodollars: generation.provenance.costMicrodollars,
        outcome: 'completed',
        code: 'completed',
        actorAccountId: principal.accountId,
        createdAt: now,
      });
    });
    runtime.readings.delete(readingId);
    await audit(runtime, {
      kind: 'article_completed',
      outcome: 'success',
      code: `cost_${generation.provenance.costMicrodollars}_in_${generation.provenance.inputTokens}_out_${generation.provenance.outputTokens}_words_${generation.provenance.wordCount}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    return {
      revision: 1,
      inputTokens: generation.provenance.inputTokens,
      outputTokens: generation.provenance.outputTokens,
      costMicrodollars: generation.provenance.costMicrodollars,
      wordCount: generation.provenance.wordCount,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

/** The owner's edit: the next revision, under the expected one, as for the round-up. */
export async function saveArticleRevision(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleEditInput,
): Promise<{ readonly revision: number }> {
  try {
    return await saveArticleRevisionUnaudited(runtime, who, input);
  } catch (error) {
    await auditArticleRefusal(runtime, who, 'article_edited', error, input.weekRunId);
    throw error;
  }
}

async function saveArticleRevisionUnaudited(
  runtime: Runtime,
  who: Principal | null,
  input: ArticleEditInput,
): Promise<{ readonly revision: number }> {
  const principal = requireCapability(who, 'edit:output');
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Editing an article needs the PostgreSQL account store.',
    );
  }
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  const category = input.category;
  const expectedRevision = integer(input.expectedRevision, 'expectedRevision', {
    min: 1,
    max: 1_000_000,
  });
  if (typeof input.markdown !== 'string')
    throw validation('markdown_invalid', 'The article body must be text.');
  const markdown = input.markdown.replace(/\r\n/gu, '\n');
  if (markdown.length < 1 || markdown.length > MAX_DRAFT_CHARACTERS) {
    throw validation(
      'markdown_length',
      `The article body must be between 1 and ${MAX_DRAFT_CHARACTERS} characters.`,
    );
  }
  if (DRAFT_FORBIDDEN.test(markdown)) {
    throw validation(
      'markdown_control',
      'The article body must not contain a control or bidirectional character.',
    );
  }
  const packages = await workspace();
  const { insertArticleRevision, isDatabaseError, latestArticleRevision } = packages.database;
  try {
    const latest = await runtime.database.withClient((client) =>
      latestArticleRevision(client, weekRunId, category),
    );
    if (latest === null) {
      throw new DashboardError(
        'not_found',
        'article_not_generated',
        'No article exists for that week and category.',
      );
    }
    if (latest.revision >= MAX_DRAFT_REVISIONS) {
      throw validation(
        'revision_limit',
        `An article keeps at most ${MAX_DRAFT_REVISIONS} revisions.`,
      );
    }
    if (expectedRevision !== latest.revision) {
      throw new DashboardError(
        'conflict',
        'article_revision_conflict',
        'The article was revised by someone else; reload and try again.',
      );
    }
    const revision = latest.revision + 1;
    try {
      await runtime.database.withTransaction((tx) =>
        insertArticleRevision(tx, {
          weekRunId,
          category,
          revision,
          kind: 'edited',
          slots: latest.slots,
          markdown,
          provenance: null,
          savedByAccountId: principal.accountId,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      if (isDatabaseError(error) && (error.code === '23505' || error.code === 'P0001')) {
        throw new DashboardError(
          'conflict',
          'article_revision_conflict',
          'The article was revised by someone else; reload and try again.',
        );
      }
      throw error;
    }
    await audit(runtime, {
      kind: 'article_edited',
      outcome: 'success',
      code: `revision_${revision}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      subjectId: weekRunId,
    });
    return { revision };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}
