-- 0016_article
--
-- CAS-005 (D36, D41, the D9 resolution for the article): the article written
-- from the full sources of a week's selection, the owner's edits, and the
-- article's own place in the model ledger.
--
--   1. **Revisions.** `article_revisions` holds one article per week run and
--      category as a sequence of revisions: 1 is the generated one with its
--      provenance (model, prompt version and hash, input digest, token counts,
--      cost, the word count, the naming basis under D4, and the reading record
--      per source: outcome code, bytes read, the extracted text's digest), 2
--      and later the owner's edits. There is no deterministic article, so the
--      sequence starts at 1. Append-only; a revision must follow the last; the
--      kind is bound to the revision number; provenance columns are present
--      exactly on the generated revision. No table holds fetched text (O-1).
--
--   2. **The ledger.** `model_calls.kind` admits `article`, so the article's
--      monthly cap is a sum over its own rows, apart from the round-up's
--      (D9 resolution for the article, option b).
--
--   3. **Audit kinds.** `audit_events.kind` gains the five events the article
--      writes: one per source read or refused (`source_fetched`, carrying the
--      source row, the outcome code, bytes and duration, never a URL), and the
--      request, completion, refusal and edit of an article, never with content.
--
-- Migrations 0001 to 0015 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0016 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0016 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.roundup_revisions') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.model_calls') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0016 target schema does not hold the round-up tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Revisions.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.article_revisions (
      week_run_id          uuid        NOT NULL REFERENCES %1$I.week_runs (id),
      category             text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      revision             integer     NOT NULL CHECK (revision >= 1),
      kind                 text        NOT NULL CHECK (kind IN ('generated', 'edited')),
      slots                jsonb       NOT NULL CHECK (jsonb_typeof(slots) = 'object'),
      markdown             text        NOT NULL CHECK (pg_catalog.length(markdown) BETWEEN 1 AND 400000),
      model                text        CHECK (model ~ '^[a-z][a-z0-9.-]{1,63}$'),
      prompt_version       text        CHECK (prompt_version ~ '^[a-z][a-z0-9-]*@[0-9]+$'),
      prompt_hash          text        CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
      input_digest         text        CHECK (input_digest ~ '^[0-9a-f]{64}$'),
      input_tokens         integer     CHECK (input_tokens >= 0),
      output_tokens        integer     CHECK (output_tokens >= 0),
      cost_microdollars    bigint      CHECK (cost_microdollars >= 0),
      word_count           integer     CHECK (word_count >= 0),
      naming_basis         text        CHECK (naming_basis IN ('primary_statement', 'two_independent', 'none')),
      sources              jsonb       CHECK (jsonb_typeof(sources) = 'array'),
      saved_by_account_id  uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at           timestamptz NOT NULL,
      CONSTRAINT article_revisions_pkey PRIMARY KEY (week_run_id, category, revision),
      CONSTRAINT article_revisions_kind CHECK (
        (revision = 1 AND kind = 'generated')
        OR (revision >= 2 AND kind = 'edited')
      ),
      CONSTRAINT article_revisions_provenance CHECK (
        (kind = 'generated') = (
          model IS NOT NULL AND prompt_version IS NOT NULL AND prompt_hash IS NOT NULL
          AND input_digest IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
          AND cost_microdollars IS NOT NULL AND word_count IS NOT NULL
          AND naming_basis IS NOT NULL AND sources IS NOT NULL
        )
      )
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.article_revision_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      last_revision integer;
      run_status    text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'an article revision is append-only; an edit is a new revision'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT w.status INTO run_status FROM %1$I.week_runs w WHERE w.id = NEW.week_run_id;
      IF run_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'an article belongs to a completed week run'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT max(r.revision) INTO last_revision FROM %1$I.article_revisions r
       WHERE r.week_run_id = NEW.week_run_id AND r.category = NEW.category;
      IF last_revision IS NULL THEN
        IF NEW.revision <> 1 THEN
          RAISE EXCEPTION 'the first article revision is the generated revision 1'
            USING ERRCODE = 'raise_exception';
        END IF;
      ELSIF NEW.revision <> last_revision + 1 THEN
        RAISE EXCEPTION 'an article revision must follow the last one'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER article_revisions_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.article_revisions
      FOR EACH ROW EXECUTE FUNCTION %1$I.article_revision_guard()
  $fmt$, target);

  -- 2. The ledger admits the article.
  EXECUTE pg_catalog.format(
    'ALTER TABLE %1$I.model_calls DROP CONSTRAINT model_calls_kind_check', target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.model_calls
      ADD CONSTRAINT model_calls_kind_check CHECK (kind IN ('roundup', 'article'))
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
        'article_requested', 'article_completed', 'article_refused', 'article_edited'
      ))
  $fmt$, target);
END
$migration$;
