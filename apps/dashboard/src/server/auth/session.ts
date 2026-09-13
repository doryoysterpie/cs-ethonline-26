import 'server-only';

import { randomUUID } from 'node:crypto';

import { DashboardError } from '../errors.ts';
import { normalizeEmail } from './email.ts';
import type { EmailProvider } from './email-provider.ts';
import { generateOtpCode, hashOtpCode, OTP_LIFETIME_SECONDS, OTP_MAX_ATTEMPTS } from './otp.ts';
import { dummyHash, verifyPassword, VerificationGate } from './password.ts';
import type { Throttle } from './rate-limit.ts';
import type { Role } from './roles.ts';
import {
  isUsernameShaped,
  type AccountRecord,
  type AuditEvent,
  type SessionRecord,
  type Stores,
} from './store.ts';
import {
  constantTimeEqual,
  generateSessionToken,
  hashSessionToken,
  isSessionTokenShaped,
} from './tokens.ts';

/** A challenge id (a UUID) is shaped like this, whether or not it names a real row. */
const CHALLENGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function isChallengeIdShaped(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_ID.test(value);
}

/**
 * A digest of a code that verifies against nothing, so a challenge that does
 * not exist still pays for one HMAC and one constant-time comparison before
 * failing — the same reasoning as `dummyHash()` for an unknown username,
 * scaled to the far cheaper primitive OTP verification uses.
 */
let dummyDigest: string | null = null;
function dummyCodeDigest(pepper: string): string {
  dummyDigest ??= hashOtpCode(generateOtpCode(), pepper);
  return dummyDigest;
}

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
  /** Absent for an email-identified account. */
  readonly username: string | null;
  /** Absent for a legacy username/password account. */
  readonly normalizedEmail: string | null;
  readonly role: Role;
  readonly sessionId: string;
  /** Kept only to derive the CSRF token; never rendered or logged. */
  readonly sessionToken: string;
}

/** A safe, human-facing identity for a principal, whichever kind of account it is. */
export function displayIdentity(principal: Principal): string {
  return principal.username ?? principal.normalizedEmail ?? principal.accountId;
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
  /** Defaults to the throttle bound to the stores passed to the constructor. */
  readonly throttle?: Throttle | undefined;
  /** Required to call `requestOtp`; absent, that method fails closed. */
  readonly emailProvider?: EmailProvider | undefined;
  /** Required to call `requestOtp` or `verifyOtp`; absent, both fail closed. */
  readonly otpPepper?: string | undefined;
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function accountKey(username: string): string {
  return `account:${username.toLowerCase()}`;
}

function emailKey(normalizedEmail: string): string {
  return `otp-request:${normalizedEmail}`;
}

function verifyKey(challengeId: string): string {
  return `otp-verify:${challengeId}`;
}

function principalOf(account: AccountRecord, sessionId: string, sessionToken: string): Principal {
  return {
    accountId: account.id,
    username: account.username,
    normalizedEmail: account.normalizedEmail,
    role: account.role,
    sessionId,
    sessionToken,
  };
}

export class SessionService {
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private readonly emailProvider: EmailProvider | undefined;
  private readonly otpPepper: string | undefined;
  readonly gate: VerificationGate;
  readonly throttle: Throttle;

  constructor(
    private readonly stores: Stores,
    options: SessionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? randomUUID;
    this.gate = options.gate ?? new VerificationGate();
    this.throttle = options.throttle ?? stores.throttle;
    this.emailProvider = options.emailProvider;
    this.otpPepper = options.otpPepper;
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
      principal: principalOf(account, session.id, token),
      absoluteExpiresAt,
    };
  }

  async login(request: LoginRequest): Promise<LoginOutcome> {
    const at = this.now();
    const username = typeof request.username === 'string' ? request.username.trim() : '';
    const password = typeof request.password === 'string' ? request.password : '';
    const key = accountKey(isUsernameShaped(username) ? username : 'malformed');

    const decision = await this.throttle.check(key, `network:${request.networkKey}`, seconds(at));
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
      await this.throttle.recordFailure(key, seconds(at));
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

    await this.throttle.recordSuccess(key);
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

  /** A presented session, valid or not, is never continued past a new sign-in. */
  private async revokePresented(presentedToken: string | null, at: Date): Promise<void> {
    if (presentedToken === null || !isSessionTokenShaped(presentedToken)) return;
    const presented = await this.stores.sessions.findByTokenHash(hashSessionToken(presentedToken));
    if (presented !== null && presented.revokedAt === null) {
      await this.stores.sessions.revoke(presented.id, at.toISOString(), 'superseded_by_login');
    }
  }

  /**
   * Requests a one-time code. The response is the same `{ ok: true }`
   * whether or not the email is approved, sent or unknown — approval is
   * never observable from the outcome, only from the (identical either way)
   * next screen. Throttled is the one outcome that differs, exactly as it
   * already does for password sign-in.
   *
   * The email send is not awaited: an approved and an unapproved email both
   * return as soon as their (comparably fast) database work finishes, so the
   * far slower and more variable cost of actually reaching a mail provider
   * is never part of the timing an unauthenticated caller can observe.
   */
  async requestOtp(request: {
    readonly email: unknown;
    readonly networkKey: string;
  }): Promise<
    | { readonly ok: true; readonly challengeId: string }
    | { readonly ok: false; readonly status: 429 }
  > {
    if (this.emailProvider === undefined || this.otpPepper === undefined) {
      throw new DashboardError(
        'configuration',
        'otp_email_not_configured',
        'passwordless sign-in is not configured',
      );
    }
    const at = this.now();
    const normalized = normalizeEmail(request.email);
    const key = emailKey(normalized ?? 'malformed');
    const decision = await this.throttle.check(key, `network:${request.networkKey}`, seconds(at));
    if (!decision.allowed) {
      await this.audit({
        kind: 'otp_requested',
        outcome: 'failure',
        code: decision.reason === 'account' ? 'email_window' : 'network_window',
        actorAccountId: null,
        subjectAccountId: null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: null,
      });
      return { ok: false, status: 429 };
    }

    const account =
      normalized === null ? null : await this.stores.accounts.findByNormalizedEmail(normalized);
    const usable =
      account !== null && account.normalizedEmail !== null && this.accountIsUsable(account, at);
    // Unapproved and malformed submissions get a challenge id too — one that
    // names no real row — so the response and the next screen are identical
    // either way; only a real code will ever verify against a real one.
    const challengeId = this.makeId();
    if (usable) {
      const code = generateOtpCode();
      const challenge = {
        id: challengeId,
        accountId: account.id,
        codeDigest: hashOtpCode(code, this.otpPepper),
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + OTP_LIFETIME_SECONDS * 1000).toISOString(),
        consumedAt: null,
        supersededAt: null,
        attemptCount: 0,
        networkKey: request.networkKey,
      };
      await this.stores.otpChallenges.issue(challenge);
      const provider = this.emailProvider;
      const minutes = Math.round(OTP_LIFETIME_SECONDS / 60);
      void provider
        .send({
          to: account.normalizedEmail,
          subject: 'Your Latest in Cyber sign-in code',
          text:
            `Your one-time sign-in code is ${code}. It expires in ${minutes} minutes ` +
            'and can be used once.\n\n' +
            'If you did not request this, you can ignore this email; support will never ask you for this code.',
        })
        .catch(() => undefined);
      await this.audit({
        kind: 'otp_requested',
        outcome: 'success',
        code: 'code_issued',
        actorAccountId: null,
        subjectAccountId: account.id,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: challenge.id,
      });
    } else {
      await this.audit({
        kind: 'otp_requested',
        outcome: 'failure',
        code: normalized === null ? 'malformed_email' : 'email_not_approved',
        actorAccountId: null,
        subjectAccountId: account?.id ?? null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: null,
      });
    }
    return { ok: true, challengeId };
  }

  /**
   * Verifies a one-time code against the challenge named by `challengeId`
   * (the pending-verification cookie's value — never the email, never in a
   * URL). Consuming a correct code and creating the session is one atomic
   * store operation (`OtpChallengeStore.consumeAndCreateSession`), so
   * concurrent verification of the same code resolves to exactly one
   * success; every other concurrent or later attempt, even with the right
   * code, is an ordinary failure.
   */
  async verifyOtp(request: {
    readonly challengeId: unknown;
    readonly code: unknown;
    readonly networkKey: string;
    readonly presentedToken: string | null;
  }): Promise<LoginOutcome> {
    if (this.otpPepper === undefined) {
      throw new DashboardError(
        'configuration',
        'otp_email_not_configured',
        'passwordless sign-in is not configured',
      );
    }
    const at = this.now();
    const challengeId = isChallengeIdShaped(request.challengeId) ? request.challengeId : null;
    const code = typeof request.code === 'string' ? request.code : '';
    const key = verifyKey(challengeId ?? 'malformed');

    const decision = await this.throttle.check(key, `network:${request.networkKey}`, seconds(at));
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

    const challenge =
      challengeId === null
        ? null
        : await this.stores.otpChallenges.findLive(challengeId, at.toISOString());
    const digest = hashOtpCode(code, this.otpPepper);
    const matches =
      challenge !== null &&
      challenge.attemptCount < OTP_MAX_ATTEMPTS &&
      constantTimeEqual(digest, challenge.codeDigest);
    // A challenge that does not exist still pays for one comparison, against
    // a fixed reference digest, so its absence costs the same time as a
    // present-but-wrong code.
    if (challenge === null) constantTimeEqual(digest, dummyCodeDigest(this.otpPepper));

    if (!matches) {
      if (challenge !== null)
        await this.stores.otpChallenges.recordAttempt(challenge.id, at.toISOString());
      await this.throttle.recordFailure(key, seconds(at));
      await this.audit({
        kind: 'login_failed',
        outcome: 'failure',
        code:
          challenge === null
            ? 'no_such_challenge'
            : challenge.attemptCount >= OTP_MAX_ATTEMPTS
              ? 'attempts_exhausted'
              : 'code_mismatch',
        actorAccountId: null,
        subjectAccountId: challenge?.accountId ?? null,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: challengeId,
      });
      return { ok: false, status: 401 };
    }

    await this.revokePresented(request.presentedToken, at);

    const token = generateSessionToken();
    const session: SessionRecord = {
      id: this.makeId(),
      accountId: challenge.accountId,
      tokenHash: hashSessionToken(token),
      createdAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      absoluteExpiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000).toISOString(),
      revokedAt: null,
      revokedReason: null,
    };
    const consumed = await this.stores.otpChallenges.consumeAndCreateSession(
      challenge.id,
      at.toISOString(),
      OTP_MAX_ATTEMPTS,
      session,
    );
    if (!consumed) {
      await this.audit({
        kind: 'login_failed',
        outcome: 'failure',
        code: 'code_already_used',
        actorAccountId: null,
        subjectAccountId: challenge.accountId,
        sessionId: null,
        networkKey: request.networkKey,
        subjectId: challengeId,
      });
      return { ok: false, status: 401 };
    }

    const account = await this.stores.accounts.getById(challenge.accountId);
    if (account === null || !this.accountIsUsable(account, at)) {
      await this.stores.sessions.revoke(session.id, at.toISOString(), 'account_unusable');
      await this.audit({
        kind: 'login_failed',
        outcome: 'failure',
        code: 'account_unusable',
        actorAccountId: null,
        subjectAccountId: challenge.accountId,
        sessionId: session.id,
        networkKey: request.networkKey,
        subjectId: null,
      });
      return { ok: false, status: 401 };
    }

    await this.throttle.recordSuccess(key);
    const principal = principalOf(account, session.id, token);
    await this.audit({
      kind: 'login_succeeded',
      outcome: 'success',
      code: 'session_issued',
      actorAccountId: account.id,
      subjectAccountId: account.id,
      sessionId: session.id,
      networkKey: request.networkKey,
      subjectId: null,
    });
    return { ok: true, principal, absoluteExpiresAt: session.absoluteExpiresAt };
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
    return principalOf(account, session.id, presentedToken);
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
