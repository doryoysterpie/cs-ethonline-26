-- 0017_readers
--
-- CAS-007 (D42, D43): reader sign-up with owner approval, the published mark,
-- and the `reader` role in place of `judge`.
--
--   1. **Sign-up requests.** `signup_requests` holds one row per request: the
--      normalised address, the HMAC digest of its one-time code (never the
--      code), the attempt count, and the instants of its life. Mutable in the
--      narrow way `otp_challenges` is: the attempt count only increases;
--      `verified_at`, `decided_at`, `decision`, `decided_by` and `account_id`
--      move from null to a value once; a decision needs a verification; an
--      account needs an approval; nothing else changes; no delete. One open
--      request per address.
--
--   2. **The published mark.** `output_publications` is append-only: each row
--      marks or unmarks one revision of one output (round-up or article) for
--      one week run and category; the latest row decides what readers see
--      (D42). A row names a revision that exists.
--
--   3. **The reader role.** `accounts.role` admits `reader` and no longer
--      `judge`; every existing `judge` row becomes `reader` (D43), the one data
--      change a migration of this repository has made; the expiry rule moves
--      with it. `audit_events.kind` gains the eight kinds the unit writes.
--
-- Migrations 0001 to 0016 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0017 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0017 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.article_revisions') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0017 target schema does not hold the article and account tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Sign-up requests.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.signup_requests (
      id                uuid        PRIMARY KEY,
      normalized_email  text        NOT NULL
                                    CHECK (normalized_email ~ '^[a-z0-9._%%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
      code_digest       text        NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
      attempt_count     integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      requested_at      timestamptz NOT NULL,
      expires_at        timestamptz NOT NULL CHECK (expires_at > requested_at),
      verified_at       timestamptz,
      decided_at        timestamptz,
      decision          text        CHECK (decision IN ('approved', 'denied')),
      decided_by        uuid        REFERENCES %1$I.accounts (id),
      account_id        uuid        REFERENCES %1$I.accounts (id),
      CONSTRAINT signup_requests_decision_shape CHECK (
        (decided_at IS NULL) = (decision IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)
      ),
      CONSTRAINT signup_requests_decision_after_verification CHECK (
        decided_at IS NULL OR verified_at IS NOT NULL
      ),
      CONSTRAINT signup_requests_account_on_approval CHECK (
        account_id IS NULL OR decision = 'approved'
      )
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE UNIQUE INDEX signup_requests_open_address ON %1$I.signup_requests (normalized_email)
      WHERE decided_at IS NULL
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX signup_requests_pending_idx ON %1$I.signup_requests (requested_at)
      WHERE decided_at IS NULL AND verified_at IS NOT NULL
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.signup_request_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a sign-up request is decided or expires, never deleted'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
         OR NEW.code_digest IS DISTINCT FROM OLD.code_digest
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'a sign-up request''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.attempt_count < OLD.attempt_count THEN
        RAISE EXCEPTION 'a sign-up request''s attempt count cannot move backward'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'a verified sign-up request stays verified as it was'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.decided_at IS NOT NULL AND (
           NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.decision IS DISTINCT FROM OLD.decision
           OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
           OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
        RAISE EXCEPTION 'a decided sign-up request is never redecided'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER signup_requests_guard
      BEFORE UPDATE OR DELETE ON %1$I.signup_requests
      FOR EACH ROW EXECUTE FUNCTION %1$I.signup_request_guard()
  $fmt$, target);

  -- 2. The published mark.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.output_publications (
      id                uuid        PRIMARY KEY,
      week_run_id       uuid        NOT NULL REFERENCES %1$I.week_runs (id),
      category          text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      output            text        NOT NULL CHECK (output IN ('roundup', 'article')),
      revision          integer     NOT NULL CHECK (revision >= 0),
      action            text        NOT NULL CHECK (action IN ('publish', 'unpublish')),
      actor_account_id  uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at        timestamptz NOT NULL
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX output_publications_current_idx
      ON %1$I.output_publications (week_run_id, category, output, created_at DESC)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.output_publication_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      found integer;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a publication record is append-only; unmarking is a new record'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.output = 'roundup' THEN
        SELECT count(*) INTO found FROM %1$I.roundup_revisions r
         WHERE r.week_run_id = NEW.week_run_id AND r.category = NEW.category AND r.revision = NEW.revision;
      ELSE
        SELECT count(*) INTO found FROM %1$I.article_revisions r
         WHERE r.week_run_id = NEW.week_run_id AND r.category = NEW.category AND r.revision = NEW.revision;
      END IF;
      IF found <> 1 THEN
        RAISE EXCEPTION 'a publication names a revision that exists'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER output_publications_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.output_publications
      FOR EACH ROW EXECUTE FUNCTION %1$I.output_publication_guard()
  $fmt$, target);

  -- 3. The reader role in place of judge (D43), and the audit kinds.
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.accounts DROP CONSTRAINT accounts_role_check', target);
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.accounts DROP CONSTRAINT accounts_judge_expiry', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.accounts
      ADD CONSTRAINT accounts_role_check CHECK (role IN ('reader', 'judge', 'editor', 'admin', 'owner'))
  $fmt$, target);
  EXECUTE pg_catalog.format(
    'UPDATE %1$I.accounts SET role = ''reader'' WHERE role = ''judge''', target);
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.accounts DROP CONSTRAINT accounts_role_check', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.accounts
      ADD CONSTRAINT accounts_role_check CHECK (role IN ('reader', 'editor', 'admin', 'owner')),
      ADD CONSTRAINT accounts_reader_expiry CHECK (role <> 'reader' OR expires_at IS NOT NULL)
  $fmt$, target);
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.audit_events DROP CONSTRAINT audit_events_kind_check', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.audit_events
      ADD CONSTRAINT audit_events_kind_check CHECK (kind IN (
        'login_succeeded', 'login_failed', 'login_throttled', 'login_busy',
        'logout', 'session_rejected', 'session_rotated', 'sessions_revoked',
        'account_provisioned', 'account_password_rotated', 'account_disabled',
        'account_role_assigned', 'account_expiry_set', 'queue_reviewed',
        'incident_merged', 'incident_split', 'evidence_decided',
        'draft_revision_saved', 'otp_requested',
        'story_selected',
        'roundup_requested', 'roundup_completed', 'roundup_refused', 'roundup_edited',
        'source_fetched',
        'article_requested', 'article_completed', 'article_refused', 'article_edited',
        'signup_requested', 'signup_verified', 'signup_locked', 'signup_approved', 'signup_denied',
        'limit_tripped', 'output_published', 'output_unpublished'
      ))
  $fmt$, target);
END
$migration$;
