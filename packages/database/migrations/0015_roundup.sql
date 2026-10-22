-- 0015_roundup
--
-- CAS-004 (D9 resolution, D39, D40): the round-up generated from a week's
-- selection, the owner's edits, the model ledger, and the owner role.
--
--   1. **Revisions.** `roundup_revisions` holds one round-up per week run and
--      category as a sequence of revisions: 0 is the deterministic rendering,
--      1 the generated one with its provenance (model, prompt and template
--      versions and hashes, input digest, token counts, cost), 2 and later
--      the owner's edits. Append-only; a revision must follow the last; the
--      kind is bound to the revision number; provenance columns are present
--      exactly on the generated revision.
--
--   2. **The model ledger.** `model_calls` records every request made or
--      refused with its token counts and cost in microdollars, so the monthly
--      cap of D9 is a sum over this table and never an estimate kept in
--      memory. Append-only.
--
--   3. **The owner role.** `accounts.role` gains `owner` (D39), the way
--      migration 0011 extended a check; and `audit_events.kind` gains the
--      four events the round-up writes, never with content.
--
-- Migrations 0001 to 0014 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0015 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0015 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.week_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0015 target schema does not hold the week and account tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Revisions.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.roundup_revisions (
      week_run_id          uuid        NOT NULL REFERENCES %1$I.week_runs (id),
      category             text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      revision             integer     NOT NULL CHECK (revision >= 0),
      kind                 text        NOT NULL CHECK (kind IN ('deterministic', 'generated', 'edited')),
      slots                jsonb       NOT NULL CHECK (jsonb_typeof(slots) = 'object'),
      markdown             text        NOT NULL CHECK (pg_catalog.length(markdown) BETWEEN 1 AND 400000),
      model                text        CHECK (model ~ '^[a-z][a-z0-9.-]{1,63}$'),
      prompt_version       text        CHECK (prompt_version ~ '^[a-z][a-z0-9-]*@[0-9]+$'),
      prompt_hash          text        CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
      template_version     text        CHECK (template_version ~ '^[a-z][a-z0-9-]*@[0-9]+$'),
      template_hash        text        CHECK (template_hash ~ '^[0-9a-f]{64}$'),
      input_digest         text        CHECK (input_digest ~ '^[0-9a-f]{64}$'),
      input_tokens         integer     CHECK (input_tokens >= 0),
      output_tokens        integer     CHECK (output_tokens >= 0),
      cost_microdollars    bigint      CHECK (cost_microdollars >= 0),
      saved_by_account_id  uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at           timestamptz NOT NULL,
      CONSTRAINT roundup_revisions_pkey PRIMARY KEY (week_run_id, category, revision),
      CONSTRAINT roundup_revisions_kind CHECK (
        (revision = 0 AND kind = 'deterministic')
        OR (revision = 1 AND kind = 'generated')
        OR (revision >= 2 AND kind = 'edited')
      ),
      CONSTRAINT roundup_revisions_provenance CHECK (
        (kind = 'generated') = (
          model IS NOT NULL AND prompt_version IS NOT NULL AND prompt_hash IS NOT NULL
          AND template_version IS NOT NULL AND template_hash IS NOT NULL AND input_digest IS NOT NULL
          AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cost_microdollars IS NOT NULL
        )
      )
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.roundup_revision_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      last_revision integer;
      run_status    text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a round-up revision is append-only; an edit is a new revision'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT w.status INTO run_status FROM %1$I.week_runs w WHERE w.id = NEW.week_run_id;
      IF run_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'a round-up belongs to a completed week run'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT max(r.revision) INTO last_revision FROM %1$I.roundup_revisions r
       WHERE r.week_run_id = NEW.week_run_id AND r.category = NEW.category;
      IF last_revision IS NULL THEN
        IF NEW.revision <> 0 THEN
          RAISE EXCEPTION 'the first round-up revision is the deterministic revision 0'
            USING ERRCODE = 'raise_exception';
        END IF;
      ELSIF NEW.revision <> last_revision + 1 THEN
        RAISE EXCEPTION 'a round-up revision must follow the last one'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER roundup_revisions_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.roundup_revisions
      FOR EACH ROW EXECUTE FUNCTION %1$I.roundup_revision_guard()
  $fmt$, target);

  -- 2. The model ledger.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.model_calls (
      id                 uuid        PRIMARY KEY,
      kind               text        NOT NULL CHECK (kind IN ('roundup')),
      week_run_id        uuid        REFERENCES %1$I.week_runs (id),
      category           text        CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      model              text        NOT NULL CHECK (model ~ '^[a-z][a-z0-9.-]{1,63}$'),
      input_tokens       integer     NOT NULL CHECK (input_tokens >= 0),
      output_tokens      integer     NOT NULL CHECK (output_tokens >= 0),
      cost_microdollars  bigint      NOT NULL CHECK (cost_microdollars >= 0),
      outcome            text        NOT NULL CHECK (outcome IN ('completed', 'refused', 'failed')),
      code               text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
      actor_account_id   uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at         timestamptz NOT NULL
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX model_calls_month_idx ON %1$I.model_calls (created_at)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.model_call_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a model call record is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER model_calls_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.model_calls
      FOR EACH ROW EXECUTE FUNCTION %1$I.model_call_guard()
  $fmt$, target);

  -- 3. The owner role, and the audit kinds.
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.accounts DROP CONSTRAINT accounts_role_check', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.accounts
      ADD CONSTRAINT accounts_role_check CHECK (role IN ('judge', 'editor', 'admin', 'owner'))
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
        'roundup_requested', 'roundup_completed', 'roundup_refused', 'roundup_edited'
      ))
  $fmt$, target);
END
$migration$;
