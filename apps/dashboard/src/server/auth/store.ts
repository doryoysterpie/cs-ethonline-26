import 'server-only';

import type { ReviewState } from '@cas/contracts';

import type { Role } from './roles.ts';

/**
 * The persistence interfaces of the dashboard.
 *
 * Every record here is a plain, explicit shape; nothing is a database row.
 * The interfaces are what the session service, the data-access layer and the
 * provisioning command program against. One implementation exists in this
 * track, `MemoryStores`, for development and tests. The PostgreSQL
 * implementation is deliberately absent: authentication persistence is paused
 * until the next migration number is allocated after the Sprint 5 correction
 * (coordination note of 10 September 2026), and a store that pretended to
 * persist would be worse than one that says it cannot.
 *
 * Every write is an insert or a narrowly named state change; nothing here
 * updates a password hash in place except `setPasswordHash`, which is the
 * one-time provisioning command's rotation path, and nothing deletes.
 */

export interface AccountRecord {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  /** Argon2id PHC string. Never leaves the server tree. */
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly passwordChangedAt: string;
  readonly disabledAt: string | null;
  /** Required for a judge; optional otherwise. Past this instant the account cannot sign in. */
  readonly expiresAt: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly accountId: string;
  /** SHA-256 of the token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export const AUDIT_EVENT_KINDS = [
  'login_succeeded',
  'login_failed',
  'login_throttled',
  'login_busy',
  'logout',
  'session_rejected',
  'session_rotated',
  'sessions_revoked',
  'account_provisioned',
  'account_password_rotated',
  'account_disabled',
  'account_role_assigned',
  'account_expiry_set',
  'queue_reviewed',
  'incident_merged',
  'incident_split',
  'evidence_decided',
  'draft_revision_saved',
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

/**
 * One security event. Carries identifiers, a fixed kind, a fixed code and a
 * network key; never a credential, a token, a submitted username that matched
 * no account, a note, a rationale or any stored text.
 */
export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: AuditEventKind;
  readonly outcome: 'success' | 'failure';
  readonly code: string;
  readonly actorAccountId: string | null;
  readonly subjectAccountId: string | null;
  readonly sessionId: string | null;
  readonly networkKey: string | null;
  /** An identifier the event is about (a run, an incident, a draft key), or null. */
  readonly subjectId: string | null;
}

export interface DraftRevision {
  /** `<evidenceRunId>:<periodStart>:<periodEnd>`, the identity of one generated draft. */
  readonly draftKey: string;
  /** 1 for the first human edit; the generated draft is revision 0 and is never stored. */
  readonly revision: number;
  readonly markdown: string;
  readonly savedByAccountId: string;
  readonly savedAt: string;
}

export interface QueueDecision {
  readonly id: string;
  readonly classificationRunId: string;
  readonly sourceRowId: string;
  readonly reviewState: ReviewState;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly actorAccountId: string;
  readonly createdAt: string;
}

export interface AccountStore {
  findByUsername(username: string): Promise<AccountRecord | null>;
  getById(id: string): Promise<AccountRecord | null>;
  list(): Promise<AccountRecord[]>;
  /** Refuses a username that exists. */
  insert(account: AccountRecord): Promise<void>;
  setPasswordHash(id: string, passwordHash: string, at: string): Promise<void>;
  setDisabled(id: string, at: string): Promise<void>;
  setRole(id: string, role: Role, expiresAt: string | null): Promise<void>;
  setExpiresAt(id: string, expiresAt: string | null): Promise<void>;
}

export interface SessionStore {
  insert(session: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: string): Promise<void>;
  revoke(id: string, at: string, reason: string): Promise<void>;
  /** Revokes every live session of the account, optionally keeping one. Returns how many. */
  revokeAllForAccount(
    accountId: string,
    at: string,
    reason: string,
    exceptSessionId: string | null,
  ): Promise<number>;
  listForAccount(accountId: string): Promise<SessionRecord[]>;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  /** Newest first, bounded. */
  list(limit: number): Promise<AuditEvent[]>;
}

export interface DraftStore {
  latest(draftKey: string): Promise<DraftRevision | null>;
  list(draftKey: string): Promise<DraftRevision[]>;
  /** Refuses a revision number that already exists for the key. */
  append(revision: DraftRevision): Promise<void>;
}

export interface QueueDecisionStore {
  append(decision: QueueDecision): Promise<void>;
  listForRun(classificationRunId: string): Promise<QueueDecision[]>;
}

export interface Stores {
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly audit: AuditStore;
  readonly drafts: DraftStore;
  readonly queueDecisions: QueueDecisionStore;
}

export const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/u;

export function isUsernameShaped(value: unknown): value is string {
  return typeof value === 'string' && USERNAME.test(value);
}
