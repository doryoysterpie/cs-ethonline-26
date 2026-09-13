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
  readonly username: string;
  readonly role: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly passwordChangedAt: string;
  readonly disabledAt: string | null;
  readonly expiresAt: string | null;
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
  pg_catalog.to_json(expires_at) #>> '{}' AS "expiresAt"`;

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

export async function getAccountById(client: Queryable, id: string): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listAccounts(client: Queryable): Promise<AccountRow[]> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY username`,
  );
  return result.rows;
}

export async function insertAccount(client: Queryable, account: AccountRow): Promise<void> {
  await client.query(
    `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at, disabled_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      account.id,
      account.username,
      account.role,
      account.passwordHash,
      account.createdAt,
      account.passwordChangedAt,
      account.disabledAt,
      account.expiresAt,
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
