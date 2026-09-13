import 'server-only';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DashboardError } from '../errors.ts';
import { isNormalizedEmailShaped } from './email.ts';
import { isVerifiableHash } from './password.ts';
import { LoginThrottle } from './rate-limit.ts';
import { isRole, type Role } from './roles.ts';
import {
  isUsernameShaped,
  type AccountRecord,
  type AccountStore,
  type AuditEvent,
  type AuditStore,
  type DraftRevision,
  type DraftStore,
  type OtpChallengeRecord,
  type OtpChallengeStore,
  type QueueDecision,
  type QueueDecisionStore,
  type SessionRecord,
  type SessionStore,
  type Stores,
} from './store.ts';

/**
 * In-memory stores for development and tests.
 *
 * Accounts alone are read from, and written back to, a seed file, so the
 * one-time provisioning command has somewhere to put a hash in the `local`
 * environment and a development server can load it. The file holds Argon2id
 * hashes, roles and expiries: never a password. Sessions, audit events, draft
 * revisions and queue decisions live in process memory only and vanish with
 * it; that is the documented seam, not a feature.
 *
 * Every collection is append-only or narrowly updated, exactly as the
 * interfaces require, so a test that passes here is a test of the same
 * contract a later PostgreSQL implementation has to meet.
 */

export const SEED_FORMAT = 'cas-dashboard-memory-seed@1';

interface SeedFile {
  readonly format: typeof SEED_FORMAT;
  readonly accounts: readonly AccountRecord[];
}

function configuration(code: string, message: string): DashboardError {
  return new DashboardError('configuration', code, message);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function instantOrNull(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && ISO.test(value)) return value;
  throw configuration(code, 'the seed file carries a malformed instant');
}

function stringOrNull(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw configuration(code, 'the seed file carries a malformed field');
}

/** Validates one seed account as a closed record. Rejections echo nothing. */
export function assertSeedAccount(value: unknown): AccountRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configuration('seed_account_shape', 'a seed account is not an object');
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'createdAt',
    'disabledAt',
    'expiresAt',
    'id',
    'normalizedEmail',
    'passwordChangedAt',
    'passwordHash',
    'role',
    'username',
  ];
  if (keys.join(',') !== expected.join(',')) {
    throw configuration('seed_account_keys', 'a seed account has unexpected keys');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !UUID.test(record.id)) {
    throw configuration('seed_account_id', 'a seed account has a malformed id');
  }
  const username = stringOrNull(record.username, 'seed_account_username');
  if (username !== null && !isUsernameShaped(username)) {
    throw configuration('seed_account_username', 'a seed account has a malformed username');
  }
  const normalizedEmail = stringOrNull(record.normalizedEmail, 'seed_account_email');
  if (normalizedEmail !== null && !isNormalizedEmailShaped(normalizedEmail)) {
    throw configuration('seed_account_email', 'a seed account has a malformed email');
  }
  const passwordHash = stringOrNull(record.passwordHash, 'seed_account_hash');
  if (passwordHash !== null && !isVerifiableHash(passwordHash)) {
    throw configuration('seed_account_hash', 'a seed account has an unusable password hash');
  }
  if (normalizedEmail === null && (username === null || passwordHash === null)) {
    throw configuration(
      'seed_account_identity',
      'a seed account proves neither an email nor a username and password',
    );
  }
  if (!isRole(record.role)) {
    throw configuration('seed_account_role', 'a seed account has an unknown role');
  }
  if (typeof record.createdAt !== 'string' || !ISO.test(record.createdAt)) {
    throw configuration('seed_account_created', 'a seed account has a malformed creation instant');
  }
  if (typeof record.passwordChangedAt !== 'string' || !ISO.test(record.passwordChangedAt)) {
    throw configuration('seed_account_changed', 'a seed account has a malformed rotation instant');
  }
  const disabledAt = instantOrNull(record.disabledAt, 'seed_account_disabled');
  const expiresAt = instantOrNull(record.expiresAt, 'seed_account_expiry');
  if (record.role === 'judge' && expiresAt === null) {
    throw configuration('seed_judge_expiry', 'a judge account in the seed has no expiry');
  }
  return {
    id: record.id,
    username,
    role: record.role,
    passwordHash,
    createdAt: record.createdAt,
    passwordChangedAt: record.passwordChangedAt,
    disabledAt,
    expiresAt,
    normalizedEmail,
  };
}

async function readSeed(seedPath: string): Promise<AccountRecord[]> {
  let text: string;
  try {
    text = await readFile(seedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw configuration('seed_unreadable', 'the memory store seed file could not be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw configuration('seed_not_json', 'the memory store seed file is not JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as SeedFile).format !== SEED_FORMAT ||
    !Array.isArray((parsed as SeedFile).accounts)
  ) {
    throw configuration('seed_format', 'the memory store seed file has an unknown format');
  }
  const accounts = (parsed as SeedFile).accounts.map(assertSeedAccount);
  const names = new Set(
    accounts.flatMap((account) => (account.username === null ? [] : [account.username])),
  );
  if (names.size !== accounts.filter((account) => account.username !== null).length) {
    throw configuration('seed_duplicate_username', 'the seed file repeats a username');
  }
  const emails = new Set(
    accounts.flatMap((account) =>
      account.normalizedEmail === null ? [] : [account.normalizedEmail],
    ),
  );
  if (emails.size !== accounts.filter((account) => account.normalizedEmail !== null).length) {
    throw configuration('seed_duplicate_email', 'the seed file repeats a normalized email');
  }
  return accounts;
}

async function writeSeed(seedPath: string, accounts: readonly AccountRecord[]): Promise<void> {
  const body: SeedFile = { format: SEED_FORMAT, accounts };
  await mkdir(path.dirname(seedPath), { recursive: true, mode: 0o700 });
  const temporary = `${seedPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, seedPath);
}

class MemoryAccounts implements AccountStore {
  private readonly byId = new Map<string, AccountRecord>();

  constructor(
    private readonly seedPath: string | null,
    initial: readonly AccountRecord[],
  ) {
    for (const account of initial) this.byId.set(account.id, account);
  }

  private async persist(): Promise<void> {
    if (this.seedPath === null) return;
    await writeSeed(this.seedPath, [...this.byId.values()]);
  }

  async findByUsername(username: string): Promise<AccountRecord | null> {
    for (const account of this.byId.values()) {
      if (account.username === username) return account;
    }
    return null;
  }

  async findByNormalizedEmail(normalizedEmail: string): Promise<AccountRecord | null> {
    for (const account of this.byId.values()) {
      if (account.normalizedEmail === normalizedEmail) return account;
    }
    return null;
  }

  async getById(id: string): Promise<AccountRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async list(): Promise<AccountRecord[]> {
    const identityOf = (a: AccountRecord): string => a.username ?? a.normalizedEmail ?? a.id;
    return [...this.byId.values()].sort((a, b) => (identityOf(a) < identityOf(b) ? -1 : 1));
  }

  async insert(account: AccountRecord): Promise<void> {
    const usernameTaken =
      account.username !== null && (await this.findByUsername(account.username)) !== null;
    const emailTaken =
      account.normalizedEmail !== null &&
      (await this.findByNormalizedEmail(account.normalizedEmail)) !== null;
    if (this.byId.has(account.id) || usernameTaken || emailTaken) {
      throw new DashboardError(
        'conflict',
        'account_exists',
        'an account with that identity exists',
      );
    }
    this.byId.set(account.id, account);
    await this.persist();
  }

  private async update(id: string, change: Partial<AccountRecord>): Promise<void> {
    const current = this.byId.get(id);
    if (current === undefined) {
      throw new DashboardError('not_found', 'account_not_found', 'no account with that id');
    }
    this.byId.set(id, { ...current, ...change });
    await this.persist();
  }

  setPasswordHash(id: string, passwordHash: string, at: string): Promise<void> {
    return this.update(id, { passwordHash, passwordChangedAt: at });
  }

  setDisabled(id: string, at: string): Promise<void> {
    return this.update(id, { disabledAt: at });
  }

  setRole(id: string, role: Role, expiresAt: string | null): Promise<void> {
    return this.update(id, { role, expiresAt });
  }

  setExpiresAt(id: string, expiresAt: string | null): Promise<void> {
    return this.update(id, { expiresAt });
  }
}

class MemorySessions implements SessionStore {
  private readonly byId = new Map<string, SessionRecord>();
  private readonly byHash = new Map<string, string>();

  async insert(session: SessionRecord): Promise<void> {
    if (this.byId.has(session.id) || this.byHash.has(session.tokenHash)) {
      throw new DashboardError('conflict', 'session_exists', 'a session with that identity exists');
    }
    this.byId.set(session.id, session);
    this.byHash.set(session.tokenHash, session.id);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const id = this.byHash.get(tokenHash);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    const current = this.byId.get(id);
    if (current !== undefined) this.byId.set(id, { ...current, lastSeenAt });
  }

  async revoke(id: string, at: string, reason: string): Promise<void> {
    const current = this.byId.get(id);
    if (current !== undefined && current.revokedAt === null) {
      this.byId.set(id, { ...current, revokedAt: at, revokedReason: reason });
    }
  }

  async revokeAllForAccount(
    accountId: string,
    at: string,
    reason: string,
    exceptSessionId: string | null,
  ): Promise<number> {
    let count = 0;
    for (const [id, session] of this.byId) {
      if (session.accountId !== accountId || session.revokedAt !== null) continue;
      if (id === exceptSessionId) continue;
      this.byId.set(id, { ...session, revokedAt: at, revokedReason: reason });
      count += 1;
    }
    return count;
  }

  async listForAccount(accountId: string): Promise<SessionRecord[]> {
    return [...this.byId.values()]
      .filter((session) => session.accountId === accountId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

class MemoryAudit implements AuditStore {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
  }

  async list(limit: number): Promise<AuditEvent[]> {
    return [...this.events].reverse().slice(0, Math.max(0, limit));
  }
}

class MemoryDrafts implements DraftStore {
  private readonly byKey = new Map<string, DraftRevision[]>();

  async latest(draftKey: string): Promise<DraftRevision | null> {
    const revisions = this.byKey.get(draftKey);
    return revisions === undefined ? null : (revisions[revisions.length - 1] ?? null);
  }

  async list(draftKey: string): Promise<DraftRevision[]> {
    return [...(this.byKey.get(draftKey) ?? [])];
  }

  async append(revision: DraftRevision): Promise<void> {
    const revisions = this.byKey.get(revision.draftKey) ?? [];
    const expected = revisions.length + 1;
    if (revision.revision !== expected) {
      throw new DashboardError(
        'conflict',
        'draft_revision_conflict',
        'the draft was revised by someone else; reload and try again',
      );
    }
    revisions.push(Object.freeze({ ...revision }));
    this.byKey.set(revision.draftKey, revisions);
  }
}

class MemoryQueueDecisions implements QueueDecisionStore {
  private readonly decisions: QueueDecision[] = [];

  async append(decision: QueueDecision): Promise<void> {
    this.decisions.push(Object.freeze({ ...decision }));
  }

  async listForRun(classificationRunId: string): Promise<QueueDecision[]> {
    return this.decisions.filter(
      (decision) => decision.classificationRunId === classificationRunId,
    );
  }
}

class MemoryOtpChallenges implements OtpChallengeStore {
  private readonly byId = new Map<string, OtpChallengeRecord>();

  constructor(private readonly sessions: SessionStore) {}

  async issue(challenge: OtpChallengeRecord): Promise<void> {
    for (const [id, existing] of this.byId) {
      if (
        existing.accountId === challenge.accountId &&
        existing.consumedAt === null &&
        existing.supersededAt === null
      ) {
        this.byId.set(id, { ...existing, supersededAt: challenge.createdAt });
      }
    }
    this.byId.set(challenge.id, challenge);
  }

  async findLive(id: string, now: string): Promise<OtpChallengeRecord | null> {
    const challenge = this.byId.get(id);
    if (
      challenge === undefined ||
      challenge.consumedAt !== null ||
      challenge.supersededAt !== null ||
      challenge.expiresAt <= now
    ) {
      return null;
    }
    return challenge;
  }

  async recordAttempt(id: string, now: string): Promise<number | null> {
    const challenge = await this.findLive(id, now);
    if (challenge === null) return null;
    const attemptCount = challenge.attemptCount + 1;
    this.byId.set(id, { ...challenge, attemptCount });
    return attemptCount;
  }

  async consumeAndCreateSession(
    challengeId: string,
    now: string,
    maxAttempts: number,
    session: SessionRecord,
  ): Promise<boolean> {
    const challenge = await this.findLive(challengeId, now);
    if (challenge === null || challenge.attemptCount >= maxAttempts) return false;
    this.byId.set(challengeId, { ...challenge, consumedAt: now });
    // Not atomic with the read above the way a single SQL statement is, but
    // this store has no concurrent callers: every operation runs to
    // completion on Node's single thread before the next one starts.
    await this.sessions.insert(session);
    return true;
  }
}

export interface MemoryStores extends Stores {
  readonly kind: 'memory';
}

/** Opens the memory stores, loading accounts from the seed file when one is named. */
export async function openMemoryStores(seedPath: string | null): Promise<MemoryStores> {
  const accounts = seedPath === null ? [] : await readSeed(seedPath);
  const sessions = new MemorySessions();
  return {
    kind: 'memory',
    accounts: new MemoryAccounts(seedPath, accounts),
    sessions,
    audit: new MemoryAudit(),
    drafts: new MemoryDrafts(),
    queueDecisions: new MemoryQueueDecisions(),
    otpChallenges: new MemoryOtpChallenges(sessions),
    throttle: new LoginThrottle(),
  };
}
