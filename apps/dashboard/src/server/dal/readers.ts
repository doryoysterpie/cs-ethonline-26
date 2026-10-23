import 'server-only';

import { randomUUID, timingSafeEqual } from 'node:crypto';

import { normalizeEmail } from '../auth/email.ts';
import {
  generateOtpCode,
  hashOtpCode,
  isOtpCodeShaped,
  OTP_LIFETIME_SECONDS,
  OTP_MAX_ATTEMPTS,
} from '../auth/otp.ts';
import type { Principal } from '../auth/session.ts';
import type { AuditEvent } from '../auth/store.ts';
import { DashboardError, isDashboardError, validation } from '../errors.ts';
import { optionalInstant, uuid } from '../input.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';
import { enforceReaderLimit } from './reader-limit.ts';
import { weekRunDto } from './read.ts';
import type { WeekRunDto } from './dto.ts';

/**
 * Reader sign-up with owner approval, the published mark and the reader read
 * limit (CAS-007, report section 1). Every function begins with its
 * capability check or, for the two unauthenticated steps, with the limits;
 * every outcome is an audit event with identifiers and fixed codes, never an
 * address and never content.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CATEGORY_SHAPE = /^[a-z][a-z0-9_]{1,31}$/u;
export const READER_EXPIRY_DEFAULT_DAYS = 365;
const PENDING_LIMIT = 200;
const PUBLISHED_LIMIT = 100;

async function audit(
  runtime: Pick<Runtime, 'stores'>,
  event: Omit<AuditEvent, 'id' | 'at'>,
): Promise<void> {
  await runtime.stores.audit.append({ id: randomUUID(), at: new Date().toISOString(), ...event });
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

export { enforceReaderLimit };

// ---------------------------------------------------------------- sign-up

export interface SignupRequestInput {
  readonly email: unknown;
  readonly networkKey: string;
  /** The request's instant; the wall clock when absent. Tests advance it past an expiry. */
  readonly now?: Date | undefined;
}

/**
 * The address step. Whatever the address, the answer is a request identifier
 * and the same next screen; a code is sent only when the address is
 * well-formed, holds no account and has no open request (report, section
 * 1.3). The email send is not awaited, as sign-in's is not, so the response
 * time says nothing either.
 */
export async function requestSignup(
  runtime: Runtime,
  input: SignupRequestInput,
): Promise<{ readonly requestId: string }> {
  if (runtime.email === null || runtime.otpPepper === null) {
    throw new DashboardError('configuration', 'signup_not_configured', 'sign-up is not configured');
  }
  const now = input.now ?? new Date();
  const normalized = normalizeEmail(input.email);
  const addressKey = `address:${normalized ?? 'malformed'}`;
  const byAddress = runtime.limits.signupAddress.check(addressKey, seconds());
  const byNetwork = runtime.limits.signupNetwork.check(`network:${input.networkKey}`, seconds());
  const base = {
    actorAccountId: null,
    subjectAccountId: null,
    sessionId: null,
    networkKey: input.networkKey,
  };
  if (!byAddress.allowed || !byNetwork.allowed) {
    if (byAddress.firstTrip || byNetwork.firstTrip) {
      await audit(runtime, {
        kind: 'limit_tripped',
        outcome: 'failure',
        code: byAddress.allowed ? 'signup_network' : 'signup_address',
        ...base,
        subjectId: null,
      });
    }
    await audit(runtime, {
      kind: 'signup_requested',
      outcome: 'failure',
      code: 'limited',
      ...base,
      subjectId: null,
    });
    return { requestId: randomUUID() };
  }
  const silent = async (): Promise<{ readonly requestId: string }> => {
    await audit(runtime, {
      kind: 'signup_requested',
      outcome: 'failure',
      code: 'silent',
      ...base,
      subjectId: null,
    });
    return { requestId: randomUUID() };
  };
  if (normalized === null) return silent();
  const existing = await runtime.stores.accounts.findByNormalizedEmail(normalized);
  if (existing !== null) return silent();
  const packages = await workspace();
  try {
    const code = generateOtpCode();
    const request = {
      id: randomUUID(),
      normalizedEmail: normalized,
      codeDigest: hashOtpCode(code, runtime.otpPepper),
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OTP_LIFETIME_SECONDS * 1000).toISOString(),
    };
    // An unverified request of the address past its expiry is superseded in
    // the same transaction (train review F4); a live one keeps the silence.
    const outcome = await runtime.database.withTransaction((tx) =>
      packages.database.insertSignupRequest(tx, request),
    );
    if (outcome === 'open_exists') return silent();
    const minutes = Math.round(OTP_LIFETIME_SECONDS / 60);
    void runtime.email
      .send({
        to: normalized,
        subject: 'Your Latest in Cyber sign-up code',
        text:
          `Your one-time sign-up code is ${code}. It expires in ${minutes} minutes and can be used once.\n\n` +
          'If you did not request access, you can ignore this email; nobody will ask you for this code.',
      })
      .catch(() => undefined);
    await audit(runtime, {
      kind: 'signup_requested',
      outcome: 'success',
      code: 'sent',
      ...base,
      subjectId: request.id,
    });
    return { requestId: request.id };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export type SignupVerification = 'verified' | 'invalid' | 'locked' | 'expired';

/**
 * The code step. A right code verifies the request once; a wrong code counts,
 * and the fifth locks the request. An unknown, expired or decided request
 * answers as an expired one.
 */
export async function verifySignup(
  runtime: Runtime,
  input: {
    readonly requestId: unknown;
    readonly code: unknown;
    readonly networkKey: string;
    readonly now?: Date | undefined;
  },
): Promise<SignupVerification> {
  if (runtime.otpPepper === null) {
    throw new DashboardError('configuration', 'signup_not_configured', 'sign-up is not configured');
  }
  if (typeof input.requestId !== 'string' || !UUID_SHAPE.test(input.requestId)) return 'expired';
  const packages = await workspace();
  const { getSignupRequest, recordSignupAttempt, verifySignupRequest } = packages.database;
  try {
    const request = await runtime.database.withClient((client) =>
      getSignupRequest(client, input.requestId as string),
    );
    const now = (input.now ?? new Date()).getTime();
    if (
      request === null ||
      request.decidedAt !== null ||
      request.supersededAt !== null ||
      Date.parse(request.expiresAt) <= now
    ) {
      return 'expired';
    }
    if (request.attemptCount >= OTP_MAX_ATTEMPTS) return 'locked';
    if (request.verifiedAt !== null) return 'verified';
    const presented = isOtpCodeShaped(input.code)
      ? hashOtpCode(input.code, runtime.otpPepper)
      : null;
    const matches =
      presented !== null &&
      timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(request.codeDigest, 'hex'));
    const base = {
      actorAccountId: null,
      subjectAccountId: null,
      sessionId: null,
      networkKey: input.networkKey,
      subjectId: request.id,
    };
    if (!matches) {
      const after = await runtime.database.withTransaction((tx) =>
        recordSignupAttempt(tx, request.id),
      );
      if (after !== null && after.attemptCount >= OTP_MAX_ATTEMPTS) {
        await audit(runtime, {
          kind: 'signup_locked',
          outcome: 'failure',
          code: 'attempts',
          ...base,
        });
        return 'locked';
      }
      return 'invalid';
    }
    const verified = await runtime.database.withTransaction((tx) =>
      verifySignupRequest(tx, request.id, new Date(now).toISOString()),
    );
    if (!verified) return 'expired';
    await audit(runtime, {
      kind: 'signup_verified',
      outcome: 'success',
      code: 'verified',
      ...base,
    });
    return 'verified';
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ---------------------------------------------------------------- approval

export interface PendingSignupDto {
  readonly requestId: string;
  readonly email: string;
  readonly requestedAt: string;
  readonly verifiedAt: string;
  readonly attemptCount: number;
}

export async function pendingSignups(
  runtime: Runtime,
  who: Principal | null,
): Promise<readonly PendingSignupDto[]> {
  requireCapability(who, 'admin:accounts');
  const packages = await workspace();
  try {
    const rows = await runtime.database.withClient((client) =>
      packages.database.listPendingSignupRequests(client, PENDING_LIMIT),
    );
    return rows.map((row) => ({
      requestId: row.id,
      email: row.normalizedEmail,
      requestedAt: row.requestedAt,
      verifiedAt: row.verifiedAt ?? row.requestedAt,
      attemptCount: row.attemptCount,
    }));
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

function approvalText(publicUrl: string | null, expiresAt: string): string {
  const where = publicUrl === null ? 'the dashboard' : publicUrl;
  const until = expiresAt.slice(0, 10);
  return (
    `Your request was approved. Sign in at ${where} with this address; a code is sent to it each time.\n\n` +
    `Your access runs until ${until}.`
  );
}

/**
 * Approval (train review F5): one transaction locks the request, re-checks
 * that it awaits a decision and that the address holds no account, creates
 * the reader account, records the decision and writes both audit events,
 * so either every record of the approval exists or none does; the email is
 * sent after the commit. The accounts live in the same database as the
 * requests only under the PostgreSQL stores, so the memory stores refuse.
 */
export async function approveSignup(
  runtime: Runtime,
  who: Principal | null,
  input: { readonly requestId: unknown; readonly expiresAt: unknown },
): Promise<{ readonly accountId: string }> {
  const principal = requireCapability(who, 'admin:accounts');
  const requestId = uuid(input.requestId, 'requestId');
  const now = new Date();
  const expiresAt =
    optionalInstant(input.expiresAt, 'expiresAt') ??
    new Date(now.getTime() + READER_EXPIRY_DEFAULT_DAYS * 24 * 3600 * 1000).toISOString();
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw validation('expires_at_past', 'A reader account needs an expiry in the future.');
  }
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Approving a reader needs the PostgreSQL account store.',
    );
  }
  const packages = await workspace();
  const {
    appendAuditEvent,
    decideSignupRequest,
    findAccountByNormalizedEmail,
    insertAccount,
    lockSignupRequest,
  } = packages.database;
  try {
    const approved = await runtime.database.withTransaction(async (tx) => {
      const request = await lockSignupRequest(tx, requestId);
      if (request === null) {
        throw new DashboardError(
          'not_found',
          'signup_request_not_found',
          'No request with that id.',
        );
      }
      if (request.verifiedAt === null || request.decidedAt !== null) {
        throw validation('signup_request_not_pending', 'That request is not awaiting a decision.');
      }
      if ((await findAccountByNormalizedEmail(tx, request.normalizedEmail)) !== null) {
        throw new DashboardError(
          'conflict',
          'account_exists',
          'An account with that email exists.',
        );
      }
      const accountId = randomUUID();
      await insertAccount(tx, {
        id: accountId,
        username: null,
        role: 'reader',
        passwordHash: null,
        createdAt: now.toISOString(),
        passwordChangedAt: now.toISOString(),
        disabledAt: null,
        expiresAt,
        normalizedEmail: request.normalizedEmail,
      });
      const decided = await decideSignupRequest(tx, {
        id: requestId,
        decision: 'approved',
        decidedBy: principal.accountId,
        accountId,
        at: now.toISOString(),
      });
      if (!decided) {
        throw new DashboardError(
          'conflict',
          'signup_request_decided',
          'That request was decided meanwhile.',
        );
      }
      await appendAuditEvent(tx, {
        id: randomUUID(),
        at: now.toISOString(),
        kind: 'account_provisioned',
        outcome: 'success',
        code: 'reader',
        actorAccountId: principal.accountId,
        subjectAccountId: accountId,
        sessionId: principal.sessionId,
        networkKey: null,
        subjectId: null,
      });
      await appendAuditEvent(tx, {
        id: randomUUID(),
        at: now.toISOString(),
        kind: 'signup_approved',
        outcome: 'success',
        code: 'reader',
        actorAccountId: principal.accountId,
        subjectAccountId: accountId,
        sessionId: principal.sessionId,
        networkKey: null,
        subjectId: requestId,
      });
      return { accountId, email: request.normalizedEmail };
    });
    void runtime.email
      ?.send({
        to: approved.email,
        subject: 'Your request to read Latest in Cyber was approved',
        text: approvalText(runtime.publicUrl, expiresAt),
      })
      .catch(() => undefined);
    return { accountId: approved.accountId };
  } catch (error) {
    if (packages.database.isDatabaseError(error) && error.code === '23505') {
      throw new DashboardError('conflict', 'account_exists', 'An account with that email exists.');
    }
    throw mapFailure(error, packages);
  }
}

/** Denial: the decision recorded, the fixed email sent, no account. */
export async function denySignup(
  runtime: Runtime,
  who: Principal | null,
  input: { readonly requestId: unknown },
): Promise<void> {
  const principal = requireCapability(who, 'admin:accounts');
  const requestId = uuid(input.requestId, 'requestId');
  const packages = await workspace();
  const { decideSignupRequest, getSignupRequest } = packages.database;
  try {
    const request = await runtime.database.withClient((client) =>
      getSignupRequest(client, requestId),
    );
    if (request === null) {
      throw new DashboardError('not_found', 'signup_request_not_found', 'No request with that id.');
    }
    const decided = await runtime.database.withTransaction((tx) =>
      decideSignupRequest(tx, {
        id: requestId,
        decision: 'denied',
        decidedBy: principal.accountId,
        accountId: null,
        at: new Date().toISOString(),
      }),
    );
    if (!decided) {
      throw validation('signup_request_not_pending', 'That request is not awaiting a decision.');
    }
    void runtime.email
      ?.send({
        to: request.normalizedEmail,
        subject: 'Your request to read Latest in Cyber',
        text: 'Your request was not approved.',
      })
      .catch(() => undefined);
    await audit(runtime, {
      kind: 'signup_denied',
      outcome: 'success',
      code: 'denied',
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      networkKey: null,
      subjectId: requestId,
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

// ---------------------------------------------------------------- the published mark

export type PublishedOutputKind = 'roundup' | 'article';

export interface PublicationInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  readonly output: unknown;
  readonly revision: unknown;
}

function outputOf(value: unknown): PublishedOutputKind {
  if (value === 'roundup' || value === 'article') return value;
  throw validation('output_invalid', 'The output is not valid.');
}

function categoryOf(value: unknown): string {
  if (typeof value !== 'string' || !CATEGORY_SHAPE.test(value)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  return value;
}

/** The owner marks one revision public (D42); the database refuses a revision that does not exist. */
export async function publishOutput(
  runtime: Runtime,
  who: Principal | null,
  input: PublicationInput,
): Promise<void> {
  const principal = requireCapability(who, 'publish:output');
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  const category = categoryOf(input.category);
  const output = outputOf(input.output);
  if (typeof input.revision !== 'number' && typeof input.revision !== 'string') {
    throw validation('revision_invalid', 'The revision is not valid.');
  }
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 0 || revision > 1_000_000) {
    throw validation('revision_invalid', 'The revision is not valid.');
  }
  const packages = await workspace();
  try {
    await runtime.database.withTransaction((tx) =>
      packages.database.insertPublication(tx, {
        id: randomUUID(),
        weekRunId,
        category,
        output,
        revision,
        action: 'publish',
        actorAccountId: principal.accountId,
        createdAt: new Date().toISOString(),
      }),
    );
    await audit(runtime, {
      kind: 'output_published',
      outcome: 'success',
      code: `${output}_${revision}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      networkKey: null,
      subjectId: weekRunId,
    });
  } catch (error) {
    if (isDashboardError(error)) throw error;
    if (packages.database.isDatabaseError(error) && error.code === 'P0001') {
      throw validation('revision_not_found', 'No such revision of that output.');
    }
    throw mapFailure(error, packages);
  }
}

/** The owner takes an output off the public pages; a new record, effective at once. */
export async function unpublishOutput(
  runtime: Runtime,
  who: Principal | null,
  input: Omit<PublicationInput, 'revision'>,
): Promise<void> {
  const principal = requireCapability(who, 'publish:output');
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  const category = categoryOf(input.category);
  const output = outputOf(input.output);
  const packages = await workspace();
  try {
    const current = await runtime.database.withClient((client) =>
      packages.database.currentPublication(client, weekRunId, category, output),
    );
    if (current === null) {
      throw validation('output_not_published', 'That output is not published.');
    }
    await runtime.database.withTransaction((tx) =>
      packages.database.insertPublication(tx, {
        id: randomUUID(),
        weekRunId,
        category,
        output,
        revision: current.revision,
        action: 'unpublish',
        actorAccountId: principal.accountId,
        createdAt: new Date().toISOString(),
      }),
    );
    await audit(runtime, {
      kind: 'output_unpublished',
      outcome: 'success',
      code: `${output}_${current.revision}`,
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      networkKey: null,
      subjectId: weekRunId,
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export interface PublishedEntryDto {
  readonly week: WeekRunDto;
  readonly category: string;
  readonly output: PublishedOutputKind;
  readonly revision: number;
  readonly publishedAt: string;
}

export interface PublishedOutputDto extends PublishedEntryDto {
  readonly markdown: string;
}

/** Every published output, newest mark first, for a principal who may view them. */
export async function publishedList(
  runtime: Runtime,
  who: Principal | null,
): Promise<readonly PublishedEntryDto[]> {
  const principal = requireCapability(who, 'view:published');
  await enforceReaderLimit(runtime, principal);
  const packages = await workspace();
  const { getWeekRun, listPublished } = packages.database;
  try {
    const marks = await runtime.database.withClient((client) =>
      listPublished(client, PUBLISHED_LIMIT),
    );
    const entries: PublishedEntryDto[] = [];
    for (const mark of marks) {
      const week = await runtime.database.withClient((client) =>
        getWeekRun(client, mark.weekRunId),
      );
      if (week === null) continue;
      entries.push({
        week: weekRunDto(week),
        category: mark.category,
        output: mark.output,
        revision: mark.revision,
        publishedAt: mark.publishedAt,
      });
    }
    return entries;
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

/** The public revision of one output: the owner's published Markdown and nothing else. */
export async function publishedOutput(
  runtime: Runtime,
  who: Principal | null,
  weekRunId: unknown,
  category: unknown,
  output: unknown,
): Promise<PublishedOutputDto> {
  const principal = requireCapability(who, 'view:published');
  await enforceReaderLimit(runtime, principal);
  const id = uuid(weekRunId, 'weekRunId');
  const wantedCategory = categoryOf(category);
  const wantedOutput = outputOf(output);
  const packages = await workspace();
  const { currentPublication, getWeekRun, listArticleRevisions, listRoundupRevisions } =
    packages.database;
  try {
    const current = await runtime.database.withClient((client) =>
      currentPublication(client, id, wantedCategory, wantedOutput),
    );
    const week = await runtime.database.withClient((client) => getWeekRun(client, id));
    if (current === null || week === null) {
      throw new DashboardError('not_found', 'output_not_published', 'Nothing is published there.');
    }
    const revisions: readonly { readonly revision: number; readonly markdown: string }[] =
      wantedOutput === 'roundup'
        ? await runtime.database.withClient((client) =>
            listRoundupRevisions(client, id, wantedCategory),
          )
        : await runtime.database.withClient((client) =>
            listArticleRevisions(client, id, wantedCategory),
          );
    const revision = revisions.find((candidate) => candidate.revision === current.revision);
    if (revision === undefined) {
      throw new DashboardError('not_found', 'output_not_published', 'Nothing is published there.');
    }
    return {
      week: weekRunDto(week),
      category: wantedCategory,
      output: wantedOutput,
      revision: current.revision,
      publishedAt: current.publishedAt,
      markdown: revision.markdown,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}
