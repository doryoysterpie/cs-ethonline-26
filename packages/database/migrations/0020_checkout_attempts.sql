-- 0020_checkout_attempts
--
-- CAS-008, corrected after the train review (F7; `docs/CAS-008-REPORT.md`,
-- section 7). Every submission of the support form created a new hosted
-- Checkout session under a fresh idempotency key, so a double submission, a
-- retry or two tabs could open two subscriptions for one account. A checkout
-- attempt is now a durable record: one open attempt per account, its
-- idempotency key fixed at creation and reused for every request to the
-- provider until the attempt closes, the session and its address bound to
-- it once the provider answers. An attempt closes at its expiry or when its
-- session completes; it is never deleted and nothing about it is rewritten
-- beyond those two one-way steps.
--
-- Migrations 0001 to 0019 are unchanged. The function and trigger below are
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and store `search_path = pg_catalog, <schema>,
-- pg_temp`. Neither is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0020 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0020 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.checkout_sessions') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0020 target schema does not hold the checkout and account tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.checkout_attempts (
      id               uuid        PRIMARY KEY,
      account_id       uuid        NOT NULL REFERENCES %1$I.accounts (id),
      idempotency_key  text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f-]{36}$'),
      created_at       timestamptz NOT NULL,
      expires_at       timestamptz NOT NULL CHECK (expires_at > created_at),
      session_id       text        REFERENCES %1$I.checkout_sessions (id),
      url              text        CHECK (url ~ '^https://' AND pg_catalog.length(url) <= 2048),
      closed_at        timestamptz,
      CONSTRAINT checkout_attempts_session_shape CHECK ((session_id IS NULL) = (url IS NULL))
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE UNIQUE INDEX checkout_attempts_open_account ON %1$I.checkout_attempts (account_id)
      WHERE closed_at IS NULL
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.checkout_attempt_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a checkout attempt closes, it is never deleted' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.account_id IS DISTINCT FROM OLD.account_id
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'a checkout attempt''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.session_id IS NOT NULL AND (
           NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.url IS DISTINCT FROM OLD.url) THEN
        RAISE EXCEPTION 'a checkout attempt is bound to one session once' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION 'a closed checkout attempt stays closed as it was' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER checkout_attempts_guard
      BEFORE UPDATE OR DELETE ON %1$I.checkout_attempts
      FOR EACH ROW EXECUTE FUNCTION %1$I.checkout_attempt_guard()
  $fmt$, target);
END
$migration$;
