import type { Queryable } from './database.js';

/**
 * PostgreSQL operations backing the dashboard's authentication and
 * editorial-workflow persistence (migration 0010): accounts, sessions,
 * security audit events, append-only queue decisions and draft revisions,
 * and login throttle buckets.
 *
 * Every row shape here mirrors a record the dashboard's own store
 * interfaces already define (`apps/dashboard/src/server/auth/store.ts`);
 * this package does not import that application's types; it returns plain
 * objects with the same fields so the dashboard's adapter can pass them
 * through without a translation layer. A conflict is reported the same way
 * every other write in this package reports one: the raw, classified
 * `DatabaseError` propagates, carrying the PostgreSQL SQLSTATE (`23505` for
 * a uniqueness conflict, `23503` for a foreign-key violation) as its code;
 * the caller decides what that means for its own domain.
 */

export interface AccountRow {
  readonly id: string;
  /** Absent for an email-identified account (migration 0011). */
  readonly username: string | null;
  readonly role: string;
  /** Absent for an email-identified account (migration 0011). */
  readonly passwordHash: string | null;
  readonly createdAt: string;
  readonly passwordChangedAt: string;
  readonly disabledAt: string | null;
  readonly expiresAt: string | null;
  /** Absent for a legacy username/password account. Exact, already normalized. */
  readonly normalizedEmail: string | null;
}

export interface SessionRow {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export interface AuditEventRow {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly outcome: string;
  readonly code: string;
  readonly actorAccountId: string | null;
  readonly subjectAccountId: string | null;
  readonly sessionId: string | null;
  readonly networkKey: string | null;
  readonly subjectId: string | null;
}

export interface DraftRevisionRow {
  readonly draftKey: string;
  readonly revision: number;
  readonly markdown: string;
  readonly savedByAccountId: string;
  readonly savedAt: string;
}

export interface QueueDecisionRow {
  readonly id: string;
  readonly classificationRunId: string;
  readonly sourceRowId: string;
  readonly reviewState: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly actorAccountId: string;
  readonly createdAt: string;
}

export interface ThrottleBucket {
  readonly windowStart: number;
  readonly count: number;
}

const ACCOUNT_COLUMNS = `id, username, role, password_hash AS "passwordHash",
  pg_catalog.to_json(created_at) #>> '{}' AS "createdAt",
  pg_catalog.to_json(password_changed_at) #>> '{}' AS "passwordChangedAt",
  pg_catalog.to_json(disabled_at) #>> '{}' AS "disabledAt",
  pg_catalog.to_json(expires_at) #>> '{}' AS "expiresAt",
  normalized_email AS "normalizedEmail"`;

export async function findAccountByUsername(
  client: Queryable,
  username: string,
): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = $1`,
    [username],
  );
  return result.rows[0] ?? null;
}

/** Exact match only; the caller normalizes before this is ever called. */
export async function findAccountByNormalizedEmail(
  client: Queryable,
  normalizedEmail: string,
): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE normalized_email = $1`,
    [normalizedEmail],
  );
  return result.rows[0] ?? null;
}

export async function getAccountById(client: Queryable, id: string): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listAccounts(client: Queryable): Promise<AccountRow[]> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY pg_catalog.coalesce(username, normalized_email)`,
  );
  return result.rows;
}

export async function insertAccount(client: Queryable, account: AccountRow): Promise<void> {
  await client.query(
    `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at, disabled_at, expires_at, normalized_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      account.id,
      account.username,
      account.role,
      account.passwordHash,
      account.createdAt,
      account.passwordChangedAt,
      account.disabledAt,
      account.expiresAt,
      account.normalizedEmail,
    ],
  );
}

export async function setAccountPasswordHash(
  client: Queryable,
  id: string,
  passwordHash: string,
  at: string,
): Promise<void> {
  await client.query(
    'UPDATE accounts SET password_hash = $2, password_changed_at = $3 WHERE id = $1',
    [id, passwordHash, at],
  );
}

export async function setAccountDisabled(client: Queryable, id: string, at: string): Promise<void> {
  await client.query('UPDATE accounts SET disabled_at = $2 WHERE id = $1', [id, at]);
}

export async function setAccountRole(
  client: Queryable,
  id: string,
  role: string,
  expiresAt: string | null,
): Promise<void> {
  await client.query('UPDATE accounts SET role = $2, expires_at = $3 WHERE id = $1', [
    id,
    role,
    expiresAt,
  ]);
}

export async function setAccountExpiresAt(
  client: Queryable,
  id: string,
  expiresAt: string | null,
): Promise<void> {
  await client.query('UPDATE accounts SET expires_at = $2 WHERE id = $1', [id, expiresAt]);
}

const SESSION_COLUMNS = `id, account_id AS "accountId", token_hash AS "tokenHash",
  pg_catalog.to_json(created_at) #>> '{}' AS "createdAt",
  pg_catalog.to_json(last_seen_at) #>> '{}' AS "lastSeenAt",
  pg_catalog.to_json(absolute_expires_at) #>> '{}' AS "absoluteExpiresAt",
  pg_catalog.to_json(revoked_at) #>> '{}' AS "revokedAt",
  revoked_reason AS "revokedReason"`;

export async function insertSession(client: Queryable, session: SessionRow): Promise<void> {
  await client.query(
    `INSERT INTO sessions (id, account_id, token_hash, created_at, last_seen_at, absolute_expires_at, revoked_at, revoked_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      session.id,
      session.accountId,
      session.tokenHash,
      session.createdAt,
      session.lastSeenAt,
      session.absoluteExpiresAt,
      session.revokedAt,
      session.revokedReason,
    ],
  );
}

export async function findSessionByTokenHash(
  client: Queryable,
  tokenHash: string,
): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export async function touchSession(
  client: Queryable,
  id: string,
  lastSeenAt: string,
): Promise<void> {
  await client.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [id, lastSeenAt]);
}

export async function revokeSession(
  client: Queryable,
  id: string,
  at: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE sessions SET revoked_at = $2, revoked_reason = $3
       WHERE id = $1 AND revoked_at IS NULL`,
    [id, at, reason],
  );
}

export async function revokeAllSessionsForAccount(
  client: Queryable,
  accountId: string,
  at: string,
  reason: string,
  exceptSessionId: string | null,
): Promise<number> {
  const result = await client.query(
    `UPDATE sessions SET revoked_at = $2, revoked_reason = $3
       WHERE account_id = $1 AND revoked_at IS NULL
         AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [accountId, at, reason, exceptSessionId],
  );
  return result.rowCount ?? 0;
}

export async function listSessionsForAccount(
  client: Queryable,
  accountId: string,
): Promise<SessionRow[]> {
  const result = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

export async function appendAuditEvent(client: Queryable, event: AuditEventRow): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, at, kind, outcome, code, actor_account_id, subject_account_id, session_id, network_key, subject_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.id,
      event.at,
      event.kind,
      event.outcome,
      event.code,
      event.actorAccountId,
      event.subjectAccountId,
      event.sessionId,
      event.networkKey,
      event.subjectId,
    ],
  );
}

export async function listAuditEvents(client: Queryable, limit: number): Promise<AuditEventRow[]> {
  const result = await client.query<AuditEventRow>(
    `SELECT id, pg_catalog.to_json(at) #>> '{}' AS at, kind, outcome, code,
            actor_account_id AS "actorAccountId", subject_account_id AS "subjectAccountId",
            session_id AS "sessionId", network_key AS "networkKey", subject_id AS "subjectId"
       FROM audit_events ORDER BY at DESC, id DESC LIMIT $1`,
    [Math.max(0, limit)],
  );
  return result.rows;
}

export async function latestDraftRevision(
  client: Queryable,
  draftKey: string,
): Promise<DraftRevisionRow | null> {
  const result = await client.query<DraftRevisionRow>(
    `SELECT draft_key AS "draftKey", revision, markdown,
            saved_by_account_id AS "savedByAccountId",
            pg_catalog.to_json(saved_at) #>> '{}' AS "savedAt"
       FROM draft_revisions WHERE draft_key = $1 ORDER BY revision DESC LIMIT 1`,
    [draftKey],
  );
  return result.rows[0] ?? null;
}

export async function listDraftRevisions(
  client: Queryable,
  draftKey: string,
): Promise<DraftRevisionRow[]> {
  const result = await client.query<DraftRevisionRow>(
    `SELECT draft_key AS "draftKey", revision, markdown,
            saved_by_account_id AS "savedByAccountId",
            pg_catalog.to_json(saved_at) #>> '{}' AS "savedAt"
       FROM draft_revisions WHERE draft_key = $1 ORDER BY revision`,
    [draftKey],
  );
  return result.rows;
}

/**
 * Appends a draft revision. `evidenceRunId` is the identifier the draft
 * key's own leading 36 characters name; the migration's own check
 * constraint refuses a mismatch, so a caller error surfaces as a
 * PostgreSQL failure rather than a silently wrong binding.
 */
export async function appendDraftRevision(
  client: Queryable,
  evidenceRunId: string,
  revision: DraftRevisionRow,
): Promise<void> {
  await client.query(
    `INSERT INTO draft_revisions (draft_key, evidence_run_id, revision, markdown, saved_by_account_id, saved_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      revision.draftKey,
      evidenceRunId,
      revision.revision,
      revision.markdown,
      revision.savedByAccountId,
      revision.savedAt,
    ],
  );
}

export async function appendQueueDecision(
  client: Queryable,
  decision: QueueDecisionRow,
): Promise<void> {
  await client.query(
    `INSERT INTO queue_decisions (id, classification_run_id, source_row_id, review_state, reason_code, note, actor_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      decision.id,
      decision.classificationRunId,
      decision.sourceRowId,
      decision.reviewState,
      decision.reasonCode,
      decision.note,
      decision.actorAccountId,
      decision.createdAt,
    ],
  );
}

export async function listQueueDecisionsForRun(
  client: Queryable,
  classificationRunId: string,
): Promise<QueueDecisionRow[]> {
  const result = await client.query<QueueDecisionRow>(
    `SELECT id, classification_run_id AS "classificationRunId", source_row_id AS "sourceRowId",
            review_state AS "reviewState", reason_code AS "reasonCode", note,
            actor_account_id AS "actorAccountId",
            pg_catalog.to_json(created_at) #>> '{}' AS "createdAt"
       FROM queue_decisions WHERE classification_run_id = $1 ORDER BY created_at`,
    [classificationRunId],
  );
  return result.rows;
}

export interface OtpChallengeRow {
  readonly id: string;
  readonly accountId: string;
  /** HMAC-SHA-256(code, server pepper), hex. The code itself is never stored. */
  readonly codeDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly supersededAt: string | null;
  readonly attemptCount: number;
  readonly networkKey: string | null;
}

const OTP_CHALLENGE_COLUMNS = `id, account_id AS "accountId", code_digest AS "codeDigest",
  pg_catalog.to_json(created_at) #>> '{}' AS "createdAt",
  pg_catalog.to_json(expires_at) #>> '{}' AS "expiresAt",
  pg_catalog.to_json(consumed_at) #>> '{}' AS "consumedAt",
  pg_catalog.to_json(superseded_at) #>> '{}' AS "supersededAt",
  attempt_count AS "attemptCount",
  network_key AS "networkKey"`;

/**
 * Supersedes every other live challenge of the account, then inserts the new
 * one: "invalidated when a newer code is requested" is these two statements,
 * run by the caller inside one transaction so a reader never observes two
 * live challenges for the same account at once.
 */
export async function issueOtpChallenge(
  client: Queryable,
  challenge: OtpChallengeRow,
): Promise<void> {
  await client.query(
    `UPDATE otp_challenges SET superseded_at = $2
       WHERE account_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
    [challenge.accountId, challenge.createdAt],
  );
  await client.query(
    `INSERT INTO otp_challenges (id, account_id, code_digest, created_at, expires_at, network_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      challenge.id,
      challenge.accountId,
      challenge.codeDigest,
      challenge.createdAt,
      challenge.expiresAt,
      challenge.networkKey,
    ],
  );
}

/** The challenge by id, only if it is still live: unconsumed, unsuperseded, unexpired. */
export async function findLiveOtpChallenge(
  client: Queryable,
  id: string,
  now: string,
): Promise<OtpChallengeRow | null> {
  const result = await client.query<OtpChallengeRow>(
    `SELECT ${OTP_CHALLENGE_COLUMNS} FROM otp_challenges
      WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > $2`,
    [id, now],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically records one more attempt against a still-live challenge.
 * Returns the new count, or null if the challenge was no longer live to
 * attempt against (already consumed, superseded or expired) — the caller
 * treats that exactly like a wrong code, never as a different outcome.
 */
export async function recordOtpChallengeAttempt(
  client: Queryable,
  id: string,
  now: string,
): Promise<number | null> {
  const result = await client.query<{ attemptCount: number }>(
    `UPDATE otp_challenges SET attempt_count = attempt_count + 1
       WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > $2
     RETURNING attempt_count AS "attemptCount"`,
    [id, now],
  );
  return result.rows[0]?.attemptCount ?? null;
}

/**
 * Consumes a challenge and creates its session in one transaction: the two
 * either both happen or neither does. The `UPDATE ... WHERE ... RETURNING`
 * is what makes concurrent verification of the same challenge resolve to
 * exactly one success — PostgreSQL serializes concurrent updates to the same
 * row, so only the first to reach this statement finds `consumed_at IS
 * NULL` still true; every other concurrent or later call, however many,
 * updates zero rows and creates no session. Returns false in that case; the
 * caller must treat it as an ordinary failure, never as a crash, even though
 * the code it was given was correct.
 */
export async function consumeOtpChallengeAndCreateSession(
  client: Queryable,
  challengeId: string,
  now: string,
  maxAttempts: number,
  session: SessionRow,
): Promise<boolean> {
  const consumed = await client.query(
    `UPDATE otp_challenges SET consumed_at = $2
       WHERE id = $1 AND consumed_at IS NULL AND superseded_at IS NULL
         AND expires_at > $2 AND attempt_count < $3
     RETURNING id`,
    [challengeId, now, maxAttempts],
  );
  if ((consumed.rowCount ?? 0) === 0) return false;
  await insertSession(client, session);
  return true;
}

/**
 * Atomically bumps a throttle bucket: a fresh window if none is tracked or
 * the tracked one has expired, otherwise one more count in the same window.
 * The single `INSERT ... ON CONFLICT` statement is what makes this safe
 * across concurrently running application instances; there is no
 * read-then-write race because PostgreSQL resolves the conflict as one
 * atomic operation per row.
 */
export async function bumpThrottleBucket(
  client: Queryable,
  bucketKey: string,
  nowSeconds: number,
  windowSeconds: number,
): Promise<ThrottleBucket> {
  const result = await client.query<{ window_start: string; count: number }>(
    `INSERT INTO login_throttle_buckets (bucket_key, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       window_start = CASE WHEN $2 - login_throttle_buckets.window_start >= $3
                            THEN $2 ELSE login_throttle_buckets.window_start END,
       count = CASE WHEN $2 - login_throttle_buckets.window_start >= $3
                     THEN 1 ELSE login_throttle_buckets.count + 1 END
     RETURNING window_start, count`,
    [bucketKey, nowSeconds, windowSeconds],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('unreachable: upsert always returns exactly one row');
  return { windowStart: Number(row.window_start), count: row.count };
}

export async function getThrottleBucket(
  client: Queryable,
  bucketKey: string,
): Promise<ThrottleBucket | null> {
  const result = await client.query<{ window_start: string; count: number }>(
    'SELECT window_start, count FROM login_throttle_buckets WHERE bucket_key = $1',
    [bucketKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : { windowStart: Number(row.window_start), count: row.count };
}

export async function clearThrottleBucket(client: Queryable, bucketKey: string): Promise<void> {
  await client.query('DELETE FROM login_throttle_buckets WHERE bucket_key = $1', [bucketKey]);
}
