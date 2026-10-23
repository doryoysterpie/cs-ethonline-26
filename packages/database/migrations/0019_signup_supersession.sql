-- 0019_signup_supersession
--
-- CAS-007, corrected after the train review (F4; `docs/CAS-007-REPORT.md`,
-- section 7). An open sign-up request whose code expired before it was
-- verified stayed open for good: the one-open-request index counted it, no
-- step closed it, and the address could never ask again. A request now
-- carries `superseded_at`, set once by the next request for the same
-- address and only on a request that is unverified, undecided and past its
-- expiry; the open-request index ignores a superseded row, and a superseded
-- row changes no further. Nothing is deleted.
--
-- Migrations 0001 to 0018 are unchanged. The guard function is replaced in
-- place with the same name, so the trigger of migration 0017 stays bound;
-- it is created through `pg_catalog.format` with quoted identifiers, bound to
-- the schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. It is not SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0019 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0019 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.signup_requests') IS NULL THEN
    RAISE EXCEPTION 'migration 0019 target schema does not hold the sign-up table'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. The column and its shape: superseded only while unverified and
  --    undecided, and never before the expiry it supersedes.
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.signup_requests ADD COLUMN superseded_at timestamptz', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.signup_requests
      ADD CONSTRAINT signup_requests_superseded_shape CHECK (
        superseded_at IS NULL
        OR (verified_at IS NULL AND decided_at IS NULL AND superseded_at >= expires_at)
      )
  $fmt$, target);

  -- 2. One open request per address, a superseded row no longer open.
  EXECUTE pg_catalog.format('DROP INDEX %1$I.signup_requests_open_address', target);
  EXECUTE pg_catalog.format($fmt$
    CREATE UNIQUE INDEX signup_requests_open_address ON %1$I.signup_requests (normalized_email)
      WHERE decided_at IS NULL AND superseded_at IS NULL
  $fmt$, target);

  -- 3. The guard, as migration 0017 wrote it, plus the supersession rules.
  EXECUTE pg_catalog.format($fmt$
    CREATE OR REPLACE FUNCTION %1$I.signup_request_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a sign-up request is decided, expires or is superseded, never deleted'
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
      IF OLD.superseded_at IS NOT NULL THEN
        IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
           OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
           OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
          RAISE EXCEPTION 'a superseded sign-up request is closed and changes no further'
            USING ERRCODE = 'raise_exception';
        END IF;
      ELSIF NEW.superseded_at IS NOT NULL THEN
        IF OLD.verified_at IS NOT NULL OR OLD.decided_at IS NOT NULL
           OR NEW.superseded_at < OLD.expires_at THEN
          RAISE EXCEPTION 'only an unverified, undecided sign-up request past its expiry is superseded'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
           OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
          RAISE EXCEPTION 'superseding a sign-up request changes nothing else about it'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
END
$migration$;
