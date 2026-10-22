import type { Queryable } from './database.js';
import { DatabaseError, isDatabaseError } from './errors.js';

/**
 * Reader sign-up and the published mark (CAS-007, migration 0017). A request
 * moves one way through its life (requested, verified, decided); a
 * publication is a record, never an update, and the latest record per output
 * decides what readers see (D42).
 */

export type SignupDecision = 'approved' | 'denied';

export interface NewSignupRequest {
  readonly id: string;
  readonly normalizedEmail: string;
  /** HMAC-SHA-256 of the code under the server-held pepper; never the code. */
  readonly codeDigest: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface SignupRequestRecord extends NewSignupRequest {
  readonly attemptCount: number;
  readonly verifiedAt: string | null;
  readonly decidedAt: string | null;
  readonly decision: SignupDecision | null;
  readonly decidedBy: string | null;
  readonly accountId: string | null;
}

const COLUMNS = `id, normalized_email, code_digest, attempt_count,
  to_json(requested_at) #>> '{}' AS requested_at, to_json(expires_at) #>> '{}' AS expires_at,
  to_json(verified_at) #>> '{}' AS verified_at, to_json(decided_at) #>> '{}' AS decided_at,
  decision, decided_by, account_id`;

interface Row {
  id: string;
  normalized_email: string;
  code_digest: string;
  attempt_count: number;
  requested_at: string;
  expires_at: string;
  verified_at: string | null;
  decided_at: string | null;
  decision: SignupDecision | null;
  decided_by: string | null;
  account_id: string | null;
}

function toRecord(row: Row): SignupRequestRecord {
  return {
    id: row.id,
    normalizedEmail: row.normalized_email,
    codeDigest: row.code_digest,
    attemptCount: row.attempt_count,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
    decidedAt: row.decided_at,
    decision: row.decision,
    decidedBy: row.decided_by,
    accountId: row.account_id,
  };
}

/** Records a request; `open_exists` when the address already has an undecided one. */
export async function insertSignupRequest(
  client: Queryable,
  request: NewSignupRequest,
): Promise<'inserted' | 'open_exists'> {
  try {
    await client.query(
      `INSERT INTO signup_requests (id, normalized_email, code_digest, requested_at, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [
        request.id,
        request.normalizedEmail,
        request.codeDigest,
        request.requestedAt,
        request.expiresAt,
      ],
    );
    return 'inserted';
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') return 'open_exists';
    throw error;
  }
}

export async function getSignupRequest(
  client: Queryable,
  id: string,
): Promise<SignupRequestRecord | null> {
  const result = await client.query<Row>(`SELECT ${COLUMNS} FROM signup_requests WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function findOpenSignupRequest(
  client: Queryable,
  normalizedEmail: string,
): Promise<SignupRequestRecord | null> {
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM signup_requests WHERE normalized_email = $1 AND decided_at IS NULL`,
    [normalizedEmail],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/** One more wrong code; returns the request as it now stands, or null when unknown. */
export async function recordSignupAttempt(
  client: Queryable,
  id: string,
): Promise<SignupRequestRecord | null> {
  const result = await client.query<Row>(
    `UPDATE signup_requests SET attempt_count = attempt_count + 1 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/** The code was right: verified once, never again. */
export async function verifySignupRequest(
  client: Queryable,
  id: string,
  at: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE signup_requests SET verified_at = $2::timestamptz
      WHERE id = $1 AND verified_at IS NULL AND decided_at IS NULL`,
    [id, at],
  );
  return (result.rowCount ?? 0) === 1;
}

/** The admin's decision over a verified, undecided request; false when it is not one. */
export async function decideSignupRequest(
  client: Queryable,
  decision: {
    readonly id: string;
    readonly decision: SignupDecision;
    readonly decidedBy: string;
    readonly accountId: string | null;
    readonly at: string;
  },
): Promise<boolean> {
  if (decision.decision === 'denied' && decision.accountId !== null) {
    throw new DatabaseError('query', 'a denial creates no account');
  }
  const result = await client.query(
    `UPDATE signup_requests
        SET decided_at = $2::timestamptz, decision = $3, decided_by = $4, account_id = $5
      WHERE id = $1 AND verified_at IS NOT NULL AND decided_at IS NULL`,
    [decision.id, decision.at, decision.decision, decision.decidedBy, decision.accountId],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Verified and undecided requests, oldest first. */
export async function listPendingSignupRequests(
  client: Queryable,
  limit: number,
): Promise<SignupRequestRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new DatabaseError('query', 'limit out of range');
  }
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM signup_requests
      WHERE decided_at IS NULL AND verified_at IS NOT NULL
      ORDER BY requested_at, id LIMIT $1`,
    [limit],
  );
  return result.rows.map(toRecord);
}

// ---------------------------------------------------------------- the published mark

export type PublishedOutput = 'roundup' | 'article';

export interface NewPublication {
  readonly id: string;
  readonly weekRunId: string;
  readonly category: string;
  readonly output: PublishedOutput;
  readonly revision: number;
  readonly action: 'publish' | 'unpublish';
  readonly actorAccountId: string;
  readonly createdAt: string;
}

export interface PublicationRecord {
  readonly weekRunId: string;
  readonly category: string;
  readonly output: PublishedOutput;
  readonly revision: number;
  readonly publishedAt: string;
  readonly actorAccountId: string;
}

export async function insertPublication(
  client: Queryable,
  publication: NewPublication,
): Promise<void> {
  await client.query(
    `INSERT INTO output_publications (id, week_run_id, category, output, revision, action,
       actor_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      publication.id,
      publication.weekRunId,
      publication.category,
      publication.output,
      publication.revision,
      publication.action,
      publication.actorAccountId,
      publication.createdAt,
    ],
  );
}

interface PublicationRow {
  week_run_id: string;
  category: string;
  output: PublishedOutput;
  revision: number;
  action: 'publish' | 'unpublish';
  created_at: string;
  actor_account_id: string;
}

const CURRENT = `SELECT DISTINCT ON (week_run_id, category, output)
    week_run_id, category, output, revision, action,
    to_json(created_at) #>> '{}' AS created_at, actor_account_id
  FROM output_publications`;

/** The revision readers see for one output, or null when none is marked. */
export async function currentPublication(
  client: Queryable,
  weekRunId: string,
  category: string,
  output: PublishedOutput,
): Promise<PublicationRecord | null> {
  const result = await client.query<PublicationRow>(
    `${CURRENT} WHERE week_run_id = $1 AND category = $2 AND output = $3
      ORDER BY week_run_id, category, output, created_at DESC, id DESC`,
    [weekRunId, category, output],
  );
  const row = result.rows[0];
  if (row === undefined || row.action !== 'publish') return null;
  return {
    weekRunId: row.week_run_id,
    category: row.category,
    output: row.output,
    revision: row.revision,
    publishedAt: row.created_at,
    actorAccountId: row.actor_account_id,
  };
}

/** Every output currently marked, newest mark first. */
export async function listPublished(
  client: Queryable,
  limit: number,
): Promise<PublicationRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new DatabaseError('query', 'limit out of range');
  }
  const result = await client.query<PublicationRow>(
    `SELECT * FROM (${CURRENT} ORDER BY week_run_id, category, output, created_at DESC, id DESC) current
      WHERE action = 'publish' ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    weekRunId: row.week_run_id,
    category: row.category,
    output: row.output,
    revision: row.revision,
    publishedAt: row.created_at,
    actorAccountId: row.actor_account_id,
  }));
}
