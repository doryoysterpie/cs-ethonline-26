import 'server-only';

import { randomUUID } from 'node:crypto';

import { REVIEW_STATES, type ReviewState } from '@cas/contracts';

import { assertPassword, hashPassword } from '../auth/password.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { isUsernameShaped, type AccountRecord, type AuditEvent } from '../auth/store.ts';
import { DashboardError, validation } from '../errors.ts';
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
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';
import { draftKeyOf } from './read.ts';

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
const MAX_DRAFT_CHARACTERS = 200_000;
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
    await runtime.stores.queueDecisions.append({
      id: decisionId,
      classificationRunId: runId,
      sourceRowId,
      reviewState,
      reasonCode: reason,
      note,
      actorAccountId: principal.accountId,
      createdAt: new Date().toISOString(),
    });
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
      actor: principal.username,
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
      actor: principal.username,
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
      actor: principal.username,
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
  if (role === 'judge' && expiresAt === null) {
    throw validation('judge_expiry_required', 'A judge account requires an expiry instant.');
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
