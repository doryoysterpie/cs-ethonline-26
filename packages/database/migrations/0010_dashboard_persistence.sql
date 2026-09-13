-- 0010_dashboard_persistence
--
-- Production candidate correction. The dashboard's authentication and
-- editorial-workflow persistence — accounts, sessions, security audit
-- events, login throttling, append-only queue decisions and draft
-- revisions — has lived in process memory only, which is why the
-- PostgreSQL store was refused with a fixed "persistence paused" error.
-- This migration gives every one of those records a table, so the
-- PostgreSQL store can replace the in-memory one in production.
--
-- Historical or completed records are made unwritable by guard triggers,
-- the same technique migrations 0005 and 0009 use for the editorial
-- pipeline: `audit_events`, `queue_decisions` and `draft_revisions` refuse
-- every UPDATE and DELETE outright; `sessions` and `accounts` refuse
-- deletion and refuse to change their identity columns, and refuse to
-- reverse a revocation or a disablement once recorded. Login throttle
-- buckets are the one mutable, non-historical table here: they are
-- short-lived rate-limiting counters, not a record of anything that
-- happened.
--
-- Ownership and run provenance are foreign keys, not free text: a queue
-- decision is bound to the exact classification result it decided on by a
-- composite foreign key `(classification_run_id, source_row_id)`, not just
-- a run id a caller could point anywhere; a draft revision is bound to the
-- evidence run it belongs to, checked against the same identifier its own
-- opaque draft key already carries. Every audit event, queue decision and
-- draft revision names the account that acted, by foreign key.
--
-- Every function below is created through `pg_catalog.format` with quoted
-- identifiers, bound to the schema being migrated, and stores
-- `search_path = pg_catalog, <schema>, pg_temp`. None is SECURITY DEFINER:
-- each runs with the caller's own privileges, so no owner escalation is
-- introduced here.
--
-- Migrations 0001 to 0009 are unchanged.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0010 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0010 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.evidence_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_results') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0010 target schema does not hold the editorial pipeline tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------- 1
  -- Accounts.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.accounts (
      id                   uuid        PRIMARY KEY,
      username             text        NOT NULL UNIQUE
                                        CHECK (username ~ '^[a-z][a-z0-9_-]{2,31}$'),
      role                 text        NOT NULL CHECK (role IN ('judge', 'editor', 'admin')),
      -- Argon2id PHC string. Never a plaintext password, never logged.
      password_hash        text        NOT NULL CHECK (length(password_hash) > 0),
      created_at           timestamptz NOT NULL,
      password_changed_at  timestamptz NOT NULL,
      disabled_at          timestamptz,
      expires_at           timestamptz,
      CONSTRAINT accounts_judge_expiry CHECK (role <> 'judge' OR expires_at IS NOT NULL)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.accounts_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an account is disabled, never deleted' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id <> OLD.id OR NEW.username <> OLD.username OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'an account''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
        RAISE EXCEPTION 'a disabled account cannot be re-enabled or re-disabled'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER accounts_guard
      BEFORE UPDATE OR DELETE ON %1$I.accounts
      FOR EACH ROW EXECUTE FUNCTION %1$I.accounts_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 2
  -- Sessions.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.sessions (
      id                     uuid        PRIMARY KEY,
      account_id             uuid        NOT NULL REFERENCES %1$I.accounts (id),
      -- SHA-256 of the session token. The token itself is never stored.
      token_hash             text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at             timestamptz NOT NULL,
      last_seen_at           timestamptz NOT NULL,
      absolute_expires_at    timestamptz NOT NULL,
      revoked_at             timestamptz,
      revoked_reason         text,
      CONSTRAINT sessions_revocation_paired
        CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
      CONSTRAINT sessions_last_seen_after_created CHECK (last_seen_at >= created_at)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format(
    'CREATE INDEX sessions_account_idx ON %1$I.sessions (account_id)', target);
  EXECUTE pg_catalog.format(
    $fmt$CREATE INDEX sessions_live_expiry_idx ON %1$I.sessions (absolute_expires_at)
           WHERE revoked_at IS NULL$fmt$,
    target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.sessions_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a session is revoked, never deleted' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.account_id <> OLD.account_id
         OR NEW.token_hash <> OLD.token_hash
         OR NEW.created_at <> OLD.created_at
         OR NEW.absolute_expires_at <> OLD.absolute_expires_at THEN
        RAISE EXCEPTION 'a session''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.revoked_at IS NOT NULL
         AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
              OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
        RAISE EXCEPTION 'a revoked session cannot be revoked again or unrevoked'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.last_seen_at < OLD.last_seen_at THEN
        RAISE EXCEPTION 'a session''s last-seen instant cannot move backward'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER sessions_guard
      BEFORE UPDATE OR DELETE ON %1$I.sessions
      FOR EACH ROW EXECUTE FUNCTION %1$I.sessions_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 3
  -- Security audit events. Append-only.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.audit_events (
      id                   uuid        PRIMARY KEY,
      at                   timestamptz NOT NULL,
      kind                 text        NOT NULL CHECK (kind IN (
                             'login_succeeded', 'login_failed', 'login_throttled', 'login_busy',
                             'logout', 'session_rejected', 'session_rotated', 'sessions_revoked',
                             'account_provisioned', 'account_password_rotated', 'account_disabled',
                             'account_role_assigned', 'account_expiry_set', 'queue_reviewed',
                             'incident_merged', 'incident_split', 'evidence_decided',
                             'draft_revision_saved'
                           )),
      outcome              text        NOT NULL CHECK (outcome IN ('success', 'failure')),
      code                 text        NOT NULL CHECK (length(code) > 0),
      actor_account_id     uuid        REFERENCES %1$I.accounts (id),
      subject_account_id   uuid        REFERENCES %1$I.accounts (id),
      session_id           uuid        REFERENCES %1$I.sessions (id),
      network_key          text,
      subject_id           text
    )
  $fmt$, target);

  EXECUTE pg_catalog.format(
    'CREATE INDEX audit_events_at_idx ON %1$I.audit_events (at DESC)', target);
  EXECUTE pg_catalog.format(
    'CREATE INDEX audit_events_subject_account_idx ON %1$I.audit_events (subject_account_id)',
    target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.append_only_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      RAISE EXCEPTION '%% is append-only: rows are never changed or removed', TG_TABLE_NAME
        USING ERRCODE = 'raise_exception';
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER audit_events_guard
      BEFORE UPDATE OR DELETE ON %1$I.audit_events
      FOR EACH ROW EXECUTE FUNCTION %1$I.append_only_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 4
  -- Queue decisions. Append-only; bound to the exact classification result
  -- it decided on, not merely to a run id a caller could point anywhere.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.queue_decisions (
      id                      uuid        PRIMARY KEY,
      classification_run_id   uuid        NOT NULL,
      source_row_id           uuid        NOT NULL,
      review_state            text        NOT NULL
                                           CHECK (review_state IN ('selected', 'rejected', 'unreviewed')),
      reason_code             text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      note                    text        CHECK (note IS NULL OR length(note) BETWEEN 1 AND 280),
      actor_account_id        uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at              timestamptz NOT NULL,
      FOREIGN KEY (classification_run_id, source_row_id)
        REFERENCES %1$I.classification_results (run_id, source_row_id)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format(
    $fmt$CREATE INDEX queue_decisions_run_idx
           ON %1$I.queue_decisions (classification_run_id, created_at)$fmt$,
    target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER queue_decisions_guard
      BEFORE UPDATE OR DELETE ON %1$I.queue_decisions
      FOR EACH ROW EXECUTE FUNCTION %1$I.append_only_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 5
  -- Draft revisions. Append-only; bound to the evidence run named by the
  -- draft key's own leading identifier, checked rather than trusted.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.draft_revisions (
      draft_key            text        NOT NULL CHECK (length(draft_key) > 36),
      evidence_run_id      uuid        NOT NULL REFERENCES %1$I.evidence_runs (id),
      revision             integer     NOT NULL CHECK (revision >= 1),
      markdown             text        NOT NULL CHECK (length(markdown) >= 1),
      saved_by_account_id  uuid        NOT NULL REFERENCES %1$I.accounts (id),
      saved_at             timestamptz NOT NULL,
      PRIMARY KEY (draft_key, revision),
      CONSTRAINT draft_revisions_key_names_run
        CHECK (pg_catalog."left"(draft_key, 36) = evidence_run_id::text)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER draft_revisions_guard
      BEFORE UPDATE OR DELETE ON %1$I.draft_revisions
      FOR EACH ROW EXECUTE FUNCTION %1$I.append_only_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 6
  -- Login throttling. Short-lived rate-limiting counters, not a historical
  -- record, so this table alone is ordinarily mutable and carries no guard.
  -- Its purpose is entirely operational: closing the seam the in-process
  -- throttle left open, where a deployment of several instances shared no
  -- state and a limit enforced by one instance meant nothing to another.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.login_throttle_buckets (
      bucket_key   text    PRIMARY KEY CHECK (length(bucket_key) BETWEEN 1 AND 128),
      window_start bigint  NOT NULL,
      count        integer NOT NULL CHECK (count >= 0)
    )
  $fmt$, target);
END
$migration$;
