-- 0018_support
--
-- CAS-008 (D44, D45): the supporter tier through Stripe's hosted Checkout
-- and signed webhooks.
--
--   1. **Checkout sessions.** `checkout_sessions` binds each hosted-checkout
--      hand-off to the account that started it, so a later webhook resolves to
--      an account even when Stripe's object carries no reference. Append-only.
--
--   2. **Supporter events.** `supporter_events` records every webhook event
--      once, by its provider event identifier (unique: the idempotency key), with
--      the instant Stripe says it occurred and the instant it arrived, the
--      account, customer and subscription it resolves to, and the subscription
--      status it carries. The body itself is never stored, only its digest. The
--      supporter mark (D45) is derived from these rows by the event's own
--      instant, never by arrival order, since Stripe does not deliver in order.
--      Append-only.
--
--   3. **Audit kinds.** `audit_events.kind` gains `checkout_started`,
--      `webhook_received` and `supporter_changed`.
--
-- Migrations 0001 to 0017 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0018 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0018 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.signup_requests') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0018 target schema does not hold the reader and account tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Checkout sessions.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.checkout_sessions (
      id          text        PRIMARY KEY CHECK (id ~ '^cs_[A-Za-z0-9_]{8,200}$'),
      account_id  uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at  timestamptz NOT NULL
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX checkout_sessions_account_idx ON %1$I.checkout_sessions (account_id, created_at DESC)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.checkout_session_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a checkout session record is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER checkout_sessions_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.checkout_sessions
      FOR EACH ROW EXECUTE FUNCTION %1$I.checkout_session_guard()
  $fmt$, target);

  -- 2. Supporter events.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.supporter_events (
      id               uuid        PRIMARY KEY,
      provider         text        NOT NULL CHECK (provider IN ('stripe')),
      event_id         text        NOT NULL CHECK (event_id ~ '^evt_[A-Za-z0-9_]{8,200}$'),
      event_type       text        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,79}$'),
      occurred_at      timestamptz NOT NULL,
      received_at      timestamptz NOT NULL,
      account_id       uuid        REFERENCES %1$I.accounts (id),
      customer_id      text        CHECK (customer_id ~ '^cus_[A-Za-z0-9_]{8,200}$'),
      subscription_id  text        CHECK (subscription_id ~ '^sub_[A-Za-z0-9_]{8,200}$'),
      status           text        CHECK (status IN (
                                     'trialing', 'active', 'past_due', 'canceled', 'unpaid',
                                     'incomplete', 'incomplete_expired', 'paused')),
      payload_digest   text        NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT supporter_events_event_unique UNIQUE (provider, event_id)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX supporter_events_account_idx
      ON %1$I.supporter_events (account_id, occurred_at DESC, received_at DESC)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX supporter_events_subscription_idx ON %1$I.supporter_events (subscription_id)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX supporter_events_customer_idx ON %1$I.supporter_events (customer_id)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.supporter_event_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a supporter event is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER supporter_events_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.supporter_events
      FOR EACH ROW EXECUTE FUNCTION %1$I.supporter_event_guard()
  $fmt$, target);

  -- 3. The audit kinds.
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
        'limit_tripped', 'output_published', 'output_unpublished',
        'checkout_started', 'webhook_received', 'supporter_changed'
      ))
  $fmt$, target);
END
$migration$;
