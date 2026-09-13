-- 0011_passwordless_email_auth
--
-- Correction. Username/password authentication is replaced by invite-only
-- passwordless email sign-in: an approved email receives a one-time numeric
-- code, and a valid code creates the same session migration 0010 already
-- defines. This migration only prepares the schema; it inserts no account,
-- disables no account and moves no data. Every account, session and audit
-- record migrations 0001 to 0010 produced is unchanged and unmoved.
--
-- Two changes to `accounts`:
--
--   1. `username` and `password_hash` become optional. An account now proves
--      an identity one of two ways, and `accounts_identity_present` refuses a
--      row that proves neither: `normalized_email` alone, or the existing
--      `username` and `password_hash` pair. Existing rows already satisfy
--      this, since both columns are still populated for them. Dropping a
--      column's NOT NULL does not touch its existing CHECK: a CHECK is
--      satisfied whenever the value it examines is NULL, per PostgreSQL's own
--      three-valued logic, so no shape constraint is loosened, only NULL is
--      newly permitted where it did not used to be sent at all.
--   2. `normalized_email` is added: unique, shape-checked, frozen once set by
--      the same guard that already freezes `username` and `id` — an account's
--      identity, of either kind, does not change after it exists. Comparison
--      is exact and case-sensitive at the database boundary; the application
--      is what lower-cases and trims before it ever reaches here, so the
--      column holds only what it will be compared against.
--
-- `otp_challenges` is new, and mutable in one narrow way: `attempt_count` may
-- only increase, `consumed_at` may only move from null to a value once, and
-- `superseded_at` the same — the same one-way-transition technique migration
-- 0010 applies to `sessions`' revocation, applied here to a code's lifecycle.
-- No code is ever stored: `code_digest` is an HMAC-SHA-256 of the code under
-- a server-held pepper the database never sees, so a copy of this table
-- alone answers no code, current or historical.
--
-- `audit_events.kind` gains exactly one value, `otp_requested`, for the step
-- password authentication never had: a request for a code, before any code
-- exists to succeed or fail. Verifying a code reuses the existing
-- `login_succeeded` / `login_failed` / `login_throttled` / `login_busy`
-- kinds unchanged, because it is the same event password verification always
-- was — a session was or was not issued — merely reached a different way.
--
-- `login_throttle_buckets` is untouched: it was already a generic keyed
-- counter, and the request and verify steps below rate-limit through it under
-- their own key prefixes, the same way the login step already does.
--
-- Every function and trigger below is created through `pg_catalog.format`
-- with quoted identifiers, bound to the schema being migrated, and stores
-- `search_path = pg_catalog, <schema>, pg_temp`. None is SECURITY DEFINER.
--
-- Migrations 0001 to 0010 are unchanged.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0011 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0011 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.sessions') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0011 target schema does not hold the dashboard accounts and sessions tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------- 1
  -- Accounts: username and password become optional; a normalized email
  -- identity is added, unique and frozen once set.

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.accounts
      ALTER COLUMN username DROP NOT NULL,
      ALTER COLUMN password_hash DROP NOT NULL,
      ADD COLUMN normalized_email text
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.accounts
      ADD CONSTRAINT accounts_normalized_email_unique UNIQUE (normalized_email),
      ADD CONSTRAINT accounts_normalized_email_shape
        CHECK (normalized_email IS NULL
               OR normalized_email ~ '^[a-z0-9._%%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
      ADD CONSTRAINT accounts_identity_present
        CHECK (normalized_email IS NOT NULL
               OR (username IS NOT NULL AND password_hash IS NOT NULL))
  $fmt$, target);

  -- Replace the guard: the same rules, with the email identity frozen
  -- alongside username, and null-safe comparison throughout (`<>` is NULL,
  -- not true, when either side is NULL, which would have let a first email
  -- ever be silently accepted as a "no change" on an old password-only row).
  EXECUTE pg_catalog.format($fmt$
    CREATE OR REPLACE FUNCTION %1$I.accounts_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an account is disabled, never deleted' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.username IS DISTINCT FROM OLD.username
         OR NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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

  -- ---------------------------------------------------------------------- 2
  -- One-time-code challenges.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.otp_challenges (
      id             uuid        PRIMARY KEY,
      account_id     uuid        NOT NULL REFERENCES %1$I.accounts (id),
      -- HMAC-SHA-256(code, server pepper). The code itself is never stored.
      code_digest    text        NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
      created_at     timestamptz NOT NULL,
      expires_at     timestamptz NOT NULL CHECK (expires_at > created_at),
      consumed_at    timestamptz,
      superseded_at  timestamptz,
      attempt_count  integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      network_key    text
    )
  $fmt$, target);

  EXECUTE pg_catalog.format(
    'CREATE INDEX otp_challenges_account_idx ON %1$I.otp_challenges (account_id)', target);
  EXECUTE pg_catalog.format(
    $fmt$CREATE INDEX otp_challenges_live_idx ON %1$I.otp_challenges (account_id)
           WHERE consumed_at IS NULL AND superseded_at IS NULL$fmt$,
    target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.otp_challenges_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an OTP challenge is consumed or superseded, never deleted'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.account_id IS DISTINCT FROM OLD.account_id
         OR NEW.code_digest IS DISTINCT FROM OLD.code_digest
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'an OTP challenge''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'a consumed OTP challenge cannot be consumed again or unconsumed'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
        RAISE EXCEPTION 'a superseded OTP challenge cannot be superseded again or unsuperseded'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.attempt_count < OLD.attempt_count THEN
        RAISE EXCEPTION 'an OTP challenge''s attempt count cannot move backward'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER otp_challenges_guard
      BEFORE UPDATE OR DELETE ON %1$I.otp_challenges
      FOR EACH ROW EXECUTE FUNCTION %1$I.otp_challenges_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------- 3
  -- The audit taxonomy gains the one step password authentication never had.

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
        'draft_revision_saved', 'otp_requested'
      ))
  $fmt$, target);
END
$migration$;
