-- 0021_story_cards
--
-- CAS-009 (D48): shareable story cards.
--
--   1. **Story cards.** `story_cards` holds one row per story a card was made
--      for: the week run, the category, the output and the entry's index in
--      that output, never a revision, since a card re-renders from whatever
--      revision is published now. One card per story (a second request for the
--      same story returns the first card). The address is a random 128-bit
--      identifier in URL-safe base64. The row records who made it first and
--      when, and counts origin views in one integer; the count only rises,
--      nothing else changes, and no row is deleted.
--
--   2. **Card images.** `story_card_images` caches the PNG rasterized from the
--      card's own SVG, one per card and published revision, so a correction is
--      rasterized once and every later request is served from the cache.
--      Append-only; bounded at 1 MiB; the digest beside the bytes.
--
--   3. **The audit kind** `card_created`.
--
-- Migrations 0001 to 0020 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0021 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0021 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.week_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.output_publications') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0021 target schema does not hold the week, account and publication tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. Story cards.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.story_cards (
      id           text        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
      week_run_id  uuid        NOT NULL REFERENCES %1$I.week_runs (id),
      category     text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      output       text        NOT NULL CHECK (output IN ('roundup', 'article')),
      entry_index  integer     NOT NULL CHECK (entry_index >= 0 AND entry_index < 1000),
      created_by   uuid        NOT NULL REFERENCES %1$I.accounts (id),
      created_at   timestamptz NOT NULL,
      views        bigint      NOT NULL DEFAULT 0 CHECK (views >= 0),
      CONSTRAINT story_cards_article_entry CHECK (output <> 'article' OR entry_index = 0),
      CONSTRAINT story_cards_story_unique UNIQUE (week_run_id, category, output, entry_index)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.story_card_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a story card is never deleted; unpublishing its output retires it'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.week_run_id IS DISTINCT FROM OLD.week_run_id
         OR NEW.category IS DISTINCT FROM OLD.category
         OR NEW.output IS DISTINCT FROM OLD.output
         OR NEW.entry_index IS DISTINCT FROM OLD.entry_index
         OR NEW.created_by IS DISTINCT FROM OLD.created_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a story card''s identity is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.views < OLD.views THEN
        RAISE EXCEPTION 'a story card''s view count only rises' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER story_cards_guard
      BEFORE UPDATE OR DELETE ON %1$I.story_cards
      FOR EACH ROW EXECUTE FUNCTION %1$I.story_card_guard()
  $fmt$, target);

  -- 2. Card images.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.story_card_images (
      card_id     text        NOT NULL REFERENCES %1$I.story_cards (id),
      revision    integer     NOT NULL CHECK (revision >= 0),
      png         bytea       NOT NULL CHECK (pg_catalog.octet_length(png) BETWEEN 8 AND 1048576),
      png_sha256  text        NOT NULL CHECK (png_sha256 ~ '^[0-9a-f]{64}$'),
      created_at  timestamptz NOT NULL,
      PRIMARY KEY (card_id, revision)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.story_card_image_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a card image is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER story_card_images_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.story_card_images
      FOR EACH ROW EXECUTE FUNCTION %1$I.story_card_image_guard()
  $fmt$, target);

  -- 3. The audit kind.
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
        'checkout_started', 'webhook_received', 'supporter_changed',
        'card_created'
      ))
  $fmt$, target);
END
$migration$;
