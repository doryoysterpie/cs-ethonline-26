import 'server-only';

import type { Database } from '@cas/database';

import { DashboardError } from '../errors.ts';
import { workspace } from '../packages.ts';
import { ACCOUNT_FAILURE_LIMIT, NETWORK_ATTEMPT_LIMIT, WINDOW_SECONDS } from './rate-limit.ts';
import type { Throttle, ThrottleDecision } from './rate-limit.ts';
import { isRole, type Role } from './roles.ts';
import type {
  AccountRecord,
  AccountStore,
  AuditEvent,
  AuditStore,
  DraftRevision,
  DraftStore,
  QueueDecision,
  QueueDecisionStore,
  SessionRecord,
  SessionStore,
  Stores,
} from './store.ts';

/**
 * The PostgreSQL store (migration 0010), production's persistence.
 *
 * Every method is a thin adapter over `@cas/database`'s dashboard-auth
 * operations, which hold the SQL: this file only shapes rows into the
 * dashboard's own record types and translates a PostgreSQL conflict into the
 * `DashboardError` the memory store already raises for the same case, so the
 * session service, the data-access layer and the provisioning command see
 * one contract regardless of which store is open. Historical and
 * append-only rows are protected by the migration's own guard triggers, not
 * by anything in this file: a bug here cannot make a completed record
 * mutable, because the database refuses the statement.
 *
 * `@cas/database` is loaded through `workspace()`, exactly as the rest of
 * the server tree loads it, rather than through a static import: the
 * package resolves its migrations directory from `import.meta.url`, which a
 * bundler cannot preserve, so it is loaded at run time from Node instead of
 * bundled by Next (`packages.ts`).
 */

function conflict(code: string, message: string): DashboardError {
  return new DashboardError('conflict', code, message);
}

async function isUniqueViolation(error: unknown): Promise<boolean> {
  const { database } = await workspace();
  return database.isDatabaseError(error) && error.code === '23505';
}

class PostgresAccounts implements AccountStore {
  constructor(private readonly db: Database) {}

  async findByUsername(username: string): Promise<AccountRecord | null> {
    const { database } = await workspace();
    const row = await this.db.withClient((client) =>
      database.findAccountByUsername(client, username),
    );
    return row === null ? null : toAccount(row);
  }

  async getById(id: string): Promise<AccountRecord | null> {
    const { database } = await workspace();
    const row = await this.db.withClient((client) => database.getAccountById(client, id));
    return row === null ? null : toAccount(row);
  }

  async list(): Promise<AccountRecord[]> {
    const { database } = await workspace();
    const rows = await this.db.withClient((client) => database.listAccounts(client));
    return rows.map(toAccount);
  }

  async insert(account: AccountRecord): Promise<void> {
    const { database } = await workspace();
    try {
      await this.db.withClient((client) => database.insertAccount(client, account));
    } catch (error) {
      if (await isUniqueViolation(error)) {
        throw conflict('account_exists', 'an account with that username exists');
      }
      throw error;
    }
  }

  async setPasswordHash(id: string, passwordHash: string, at: string): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) =>
      database.setAccountPasswordHash(client, id, passwordHash, at),
    );
  }

  async setDisabled(id: string, at: string): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.setAccountDisabled(client, id, at));
  }

  async setRole(id: string, role: Role, expiresAt: string | null): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.setAccountRole(client, id, role, expiresAt));
  }

  async setExpiresAt(id: string, expiresAt: string | null): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.setAccountExpiresAt(client, id, expiresAt));
  }
}

function toAccount(row: {
  readonly id: string;
  readonly username: string;
  readonly role: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly passwordChangedAt: string;
  readonly disabledAt: string | null;
  readonly expiresAt: string | null;
}): AccountRecord {
  if (!isRole(row.role)) {
    throw new DashboardError(
      'unavailable',
      'account_role_unrecognized',
      'the store could not complete the request',
    );
  }
  return { ...row, role: row.role };
}

class PostgresSessions implements SessionStore {
  constructor(private readonly db: Database) {}

  async insert(session: SessionRecord): Promise<void> {
    const { database } = await workspace();
    try {
      await this.db.withClient((client) => database.insertSession(client, session));
    } catch (error) {
      if (await isUniqueViolation(error)) {
        throw conflict('session_exists', 'a session with that identity exists');
      }
      throw error;
    }
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const { database } = await workspace();
    return this.db.withClient((client) => database.findSessionByTokenHash(client, tokenHash));
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.touchSession(client, id, lastSeenAt));
  }

  async revoke(id: string, at: string, reason: string): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.revokeSession(client, id, at, reason));
  }

  async revokeAllForAccount(
    accountId: string,
    at: string,
    reason: string,
    exceptSessionId: string | null,
  ): Promise<number> {
    const { database } = await workspace();
    return this.db.withClient((client) =>
      database.revokeAllSessionsForAccount(client, accountId, at, reason, exceptSessionId),
    );
  }

  async listForAccount(accountId: string): Promise<SessionRecord[]> {
    const { database } = await workspace();
    return this.db.withClient((client) => database.listSessionsForAccount(client, accountId));
  }
}

class PostgresAudit implements AuditStore {
  constructor(private readonly db: Database) {}

  async append(event: AuditEvent): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.appendAuditEvent(client, event));
  }

  async list(limit: number): Promise<AuditEvent[]> {
    const { database } = await workspace();
    const rows = await this.db.withClient((client) => database.listAuditEvents(client, limit));
    return rows as AuditEvent[];
  }
}

class PostgresDrafts implements DraftStore {
  constructor(private readonly db: Database) {}

  async latest(draftKey: string): Promise<DraftRevision | null> {
    const { database } = await workspace();
    return this.db.withClient((client) => database.latestDraftRevision(client, draftKey));
  }

  async list(draftKey: string): Promise<DraftRevision[]> {
    const { database } = await workspace();
    return this.db.withClient((client) => database.listDraftRevisions(client, draftKey));
  }

  async append(revision: DraftRevision): Promise<void> {
    const { database } = await workspace();
    const evidenceRunId = revision.draftKey.slice(0, 36);
    try {
      await this.db.withClient((client) =>
        database.appendDraftRevision(client, evidenceRunId, revision),
      );
    } catch (error) {
      if (await isUniqueViolation(error)) {
        throw conflict(
          'draft_revision_conflict',
          'the draft was revised by someone else; reload and try again',
        );
      }
      throw error;
    }
  }
}

class PostgresQueueDecisions implements QueueDecisionStore {
  constructor(private readonly db: Database) {}

  async append(decision: QueueDecision): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.appendQueueDecision(client, decision));
  }

  async listForRun(classificationRunId: string): Promise<QueueDecision[]> {
    const { database } = await workspace();
    const rows = await this.db.withClient((client) =>
      database.listQueueDecisionsForRun(client, classificationRunId),
    );
    return rows as QueueDecision[];
  }
}

function remaining(windowStart: number, nowSeconds: number): number {
  return Math.max(0, windowStart + WINDOW_SECONDS - nowSeconds);
}

/**
 * The PostgreSQL-backed login throttle: the same two independent limits as
 * `LoginThrottle`, over the shared `login_throttle_buckets` table instead of
 * process memory, so the limit holds across every application instance
 * rather than resetting per process.
 */
export class PostgresLoginThrottle implements Throttle {
  constructor(private readonly db: Database) {}

  async check(
    accountKey: string,
    networkKey: string,
    nowSeconds: number,
  ): Promise<ThrottleDecision> {
    const { database } = await workspace();
    const network = await this.db.withClient((client) =>
      database.bumpThrottleBucket(client, networkKey, nowSeconds, WINDOW_SECONDS),
    );
    if (network.count > NETWORK_ATTEMPT_LIMIT) {
      return {
        allowed: false,
        reason: 'network',
        retryAfterSeconds: remaining(network.windowStart, nowSeconds),
      };
    }
    const account = await this.db.withClient((client) =>
      database.getThrottleBucket(client, accountKey),
    );
    if (
      account !== null &&
      nowSeconds - account.windowStart < WINDOW_SECONDS &&
      account.count >= ACCOUNT_FAILURE_LIMIT
    ) {
      return {
        allowed: false,
        reason: 'account',
        retryAfterSeconds: remaining(account.windowStart, nowSeconds),
      };
    }
    return { allowed: true };
  }

  async recordFailure(accountKey: string, nowSeconds: number): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) =>
      database.bumpThrottleBucket(client, accountKey, nowSeconds, WINDOW_SECONDS),
    );
  }

  async recordSuccess(accountKey: string): Promise<void> {
    const { database } = await workspace();
    await this.db.withClient((client) => database.clearThrottleBucket(client, accountKey));
  }
}

export interface PostgresStores extends Stores {
  readonly kind: 'postgres';
}

/** Opens the PostgreSQL stores over an already-configured database handle. */
export function openPostgresStores(db: Database): PostgresStores {
  return {
    kind: 'postgres',
    accounts: new PostgresAccounts(db),
    sessions: new PostgresSessions(db),
    audit: new PostgresAudit(db),
    drafts: new PostgresDrafts(db),
    queueDecisions: new PostgresQueueDecisions(db),
    throttle: new PostgresLoginThrottle(db),
  };
}
