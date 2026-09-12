import 'server-only';

import { randomUUID } from 'node:crypto';

import { DashboardError } from '../errors.ts';
import { dummyHash, verifyPassword, VerificationGate } from './password.ts';
import { LoginThrottle } from './rate-limit.ts';
import type { Role } from './roles.ts';
import {
  isUsernameShaped,
  type AccountRecord,
  type AuditEvent,
  type SessionRecord,
  type Stores,
} from './store.ts';
import { generateSessionToken, hashSessionToken, isSessionTokenShaped } from './tokens.ts';

/**
 * The session service: sign-in, session validation, rotation and revocation.
 *
 * Properties, each pinned by a unit test:
 *
 *   - **A session token is issued only by this code, at sign-in.** Nothing a
 *     client presents before sign-in is ever adopted as a session, so a fixed
 *     token cannot become one.
 *   - **Every sign-in is a new session** and a re-sign-in from an existing
 *     session revokes the old one. A privilege change revokes every session of
 *     the account; the acting administrator's own session is rotated.
 *   - **Two expiries.** An absolute lifetime from creation and an idle
 *     lifetime from the last request; either alone ends the session.
 *   - **A disabled or expired account ends its sessions** at the next request,
 *     and a judge's account expiry is checked on every request.
 *   - **Failure is generic.** Unknown username, wrong password, disabled or
 *     expired account and a throttled or busy verifier all return the same
 *     outcome, and the audit trail records the reason where the reason is
 *     safe: never a submitted username that matched nothing.
 *   - **Work is bounded.** Verification passes through the gate; the same
 *     dummy hash is verified for an unknown username.
 */

export const SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_SECONDS = 30 * 60;
/** A session is touched at most this often, so a busy page is not a write per request. */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60;

export interface Principal {
  readonly accountId: string;
  readonly username: string;
  readonly role: Role;
  readonly sessionId: string;
  /** Kept only to derive the CSRF token; never rendered or logged. */
  readonly sessionToken: string;
}

export type LoginOutcome =
  | { readonly ok: true; readonly principal: Principal; readonly absoluteExpiresAt: string }
  | { readonly ok: false; readonly status: 401 | 429 };

export interface LoginRequest {
  readonly username: unknown;
  readonly password: unknown;
  readonly networkKey: string;
  /** The session presented with the request, if any, revoked on success. */
  readonly presentedToken: string | null;
}

export interface SessionServiceOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly gate?: VerificationGate | undefined;
  readonly throttle?: LoginThrottle | undefined;
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function accountKey(username: string): string {
  return `account:${username.toLowerCase()}`;
}

export class SessionService {
  private readonly now: () => Date;
  private readonly makeId: () => string;
  readonly gate: VerificationGate;
  readonly throttle: LoginThrottle;

  constructor(
    private readonly stores: Stores,
    options: SessionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? randomUUID;
    this.gate = options.gate ?? new VerificationGate();
    this.throttle = options.throttle ?? new LoginThrottle();
  }

  private async audit(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
    await this.stores.audit.append({ id: this.makeId(), at: this.now().toISOString(), ...event });
  }

  private accountIsUsable(account: AccountRecord, at: Date): boolean {
    if (account.disabledAt !== null) return false;
    if (account.expiresAt !== null && Date.parse(account.expiresAt) <= at.getTime()) return false;
    return true;
  }

  private async issue(
    account: AccountRecord,
    at: Date,
  ): Promise<{ principal: Principal; absoluteExpiresAt: string }> {
    const token = generateSessionToken();
    const absoluteExpiresAt = new Date(
      at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000,
    ).toISOString();
    const session: SessionRecord = {
      id: this.makeId(),
      accountId: account.id,
      tokenHash: hashSessionToken(token),
      createdAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      absoluteExpiresAt,
      revokedAt: null,
      revokedReason: null,
    };
    await this.stores.sessions.insert(session);
    return {
      principal: {
        accountId: account.id,
        username: account.username,
        role: account.role,
        sessionId: session.id,
        sessionToken: token,
      },
      absoluteExpiresAt,
    };
  }

  async login(request: LoginRequest): Promise<LoginOutcome> {
    const at = this.now();
    const username = typeof request.username === 'string' ? request.username.trim() : '';
    const password = typeof request.password === 'string' ? request.password : '';
    const key = accountKey(isUsernameShaped(username) ? username : 'malformed');

    const decision = this.throttle.check(key, `network:${request.networkKey}`, seconds(at));
    if (!decision.allowed) {
      await this.audit({
        kind: 'login_throttled',
        outcome: 'failure',
        code: decision.reason === 'account' ? 'account_window' : 'network_window',
        actorAccountId: null,
        subjectAccountId: null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: null,
      });
      return { ok: false, status: 429 };
    }

    const account = isUsernameShaped(username)
      ? await this.stores.accounts.findByUsername(username)
      : null;
    const hash = account?.passwordHash ?? (await dummyHash());
    const verified = await this.gate.run(() => verifyPassword(hash, password));
    if (!verified.ok) {
      await this.audit({
        kind: 'login_busy',
        outcome: 'failure',
        code: 'verifier_saturated',
        actorAccountId: null,
        subjectAccountId: null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: null,
      });
      return { ok: false, status: 429 };
    }

    const usable = account !== null && this.accountIsUsable(account, at);
    if (account === null || !verified.value || !usable) {
      this.throttle.recordFailure(key, seconds(at));
      await this.audit({
        kind: 'login_failed',
        outcome: 'failure',
        // The reason is recorded only where it names an existing account.
        code:
          account === null
            ? 'no_such_account'
            : !verified.value
              ? 'password_mismatch'
              : account.disabledAt !== null
                ? 'account_disabled'
                : 'account_expired',
        actorAccountId: null,
        subjectAccountId: account?.id ?? null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: null,
      });
      return { ok: false, status: 401 };
    }

    // A presented session, valid or not, is never continued: sign-in always
    // issues a fresh token, and a live presented session is closed.
    if (request.presentedToken !== null && isSessionTokenShaped(request.presentedToken)) {
      const presented = await this.stores.sessions.findByTokenHash(
        hashSessionToken(request.presentedToken),
      );
      if (presented !== null && presented.revokedAt === null) {
        await this.stores.sessions.revoke(presented.id, at.toISOString(), 'superseded_by_login');
      }
    }

    this.throttle.recordSuccess(key);
    const issued = await this.issue(account, at);
    await this.audit({
      kind: 'login_succeeded',
      outcome: 'success',
      code: 'session_issued',
      actorAccountId: account.id,
      subjectAccountId: account.id,
      sessionId: issued.principal.sessionId,
      networkKey: request.networkKey,
      subjectId: null,
    });
    return { ok: true, principal: issued.principal, absoluteExpiresAt: issued.absoluteExpiresAt };
  }

  /**
   * Resolves a presented token to a principal, or null. Every reason for
   * null is checked in order: shape, existence, revocation, absolute expiry,
   * idle expiry, account existence, disablement, account expiry. A session
   * that fails a check after existing is revoked with the reason.
   */
  async authenticate(presentedToken: unknown): Promise<Principal | null> {
    if (!isSessionTokenShaped(presentedToken)) return null;
    const at = this.now();
    const session = await this.stores.sessions.findByTokenHash(hashSessionToken(presentedToken));
    if (session === null || session.revokedAt !== null) return null;

    const reject = async (reason: string): Promise<null> => {
      await this.stores.sessions.revoke(session.id, at.toISOString(), reason);
      await this.audit({
        kind: 'session_rejected',
        outcome: 'failure',
        code: reason,
        actorAccountId: null,
        subjectAccountId: session.accountId,
        sessionId: session.id,
        networkKey: null,
        subjectId: null,
      });
      return null;
    };

    if (Date.parse(session.absoluteExpiresAt) <= at.getTime()) return reject('absolute_expiry');
    if (Date.parse(session.lastSeenAt) + SESSION_IDLE_SECONDS * 1000 <= at.getTime()) {
      return reject('idle_expiry');
    }
    const account = await this.stores.accounts.getById(session.accountId);
    if (account === null) return reject('account_missing');
    if (account.disabledAt !== null) return reject('account_disabled');
    if (account.expiresAt !== null && Date.parse(account.expiresAt) <= at.getTime()) {
      return reject('account_expired');
    }
    if (at.getTime() - Date.parse(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
      await this.stores.sessions.touch(session.id, at.toISOString());
    }
    return {
      accountId: account.id,
      username: account.username,
      role: account.role,
      sessionId: session.id,
      sessionToken: presentedToken,
    };
  }

  /** Revokes the principal's own session. */
  async logout(principal: Principal): Promise<void> {
    const at = this.now().toISOString();
    await this.stores.sessions.revoke(principal.sessionId, at, 'logout');
    await this.audit({
      kind: 'logout',
      outcome: 'success',
      code: 'session_revoked',
      actorAccountId: principal.accountId,
      subjectAccountId: principal.accountId,
      sessionId: principal.sessionId,
      networkKey: null,
      subjectId: null,
    });
  }

  /** Revokes every live session of an account. Used after a privilege change or by an administrator. */
  async revokeAllSessions(
    actor: Principal | null,
    accountId: string,
    reason: string,
    exceptSessionId: string | null,
  ): Promise<number> {
    const at = this.now().toISOString();
    const count = await this.stores.sessions.revokeAllForAccount(
      accountId,
      at,
      reason,
      exceptSessionId,
    );
    await this.audit({
      kind: 'sessions_revoked',
      outcome: 'success',
      code: reason,
      actorAccountId: actor?.accountId ?? null,
      subjectAccountId: accountId,
      sessionId: actor?.sessionId ?? null,
      networkKey: null,
      subjectId: String(count),
    });
    return count;
  }

  /**
   * Rotates the principal's own session: a new token is issued and the
   * current one revoked. Called after any change to the principal's own
   * privileges so a token issued under the old privilege stops working.
   */
  async rotate(principal: Principal): Promise<{ principal: Principal; absoluteExpiresAt: string }> {
    const at = this.now();
    const account = await this.stores.accounts.getById(principal.accountId);
    if (account === null) {
      throw new DashboardError('authentication', 'account_missing', 'no valid session');
    }
    await this.stores.sessions.revoke(principal.sessionId, at.toISOString(), 'rotated');
    const issued = await this.issue(account, at);
    await this.audit({
      kind: 'session_rotated',
      outcome: 'success',
      code: 'privilege_change',
      actorAccountId: account.id,
      subjectAccountId: account.id,
      sessionId: issued.principal.sessionId,
      networkKey: null,
      subjectId: principal.sessionId,
    });
    return issued;
  }
}
