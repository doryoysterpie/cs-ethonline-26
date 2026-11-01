-- 0024_revision_removed_characters
--
-- CAS-012 (D50, point 1), after the review of pull request 61 at db10902
-- (finding 1). A save removes every character the prohibited-text rule names
-- but the refused controls and bidirectional controls, and its notice lists
-- each removal by code point, name, line and column, never only a count. The
-- list travelled in the redirect's query string, which holds at most twenty,
-- so a save that removed more lost the rest. Each draft, round-up and article
-- revision now records every character removed from the text submitted for
-- it, as `[code point, line, column]` with line and column counted in code
-- points in that text, and the notice reads the list from the revision it
-- names. The record holds numbers only, never a removed character, so no
-- stored revision holds one (D50, point 1).
--
-- Existing revisions receive an empty list, which is their record: no save
-- before CAS-012 removed a character. Only an owner's edit carries a removal;
-- a generated or deterministic revision holds none. Adding a column with a
-- constant default rewrites no row, so the append-only guards of migrations
-- 0010, 0015 and 0016 stand and no published revision changes.
--
-- Migrations 0001 to 0023 are unchanged.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
  revisions text;
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0024 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0024 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.draft_revisions') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.roundup_revisions') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.article_revisions') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0024 target schema does not hold the three revision tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Each entry is an array of three whole numbers from 1: a code point the
  -- strip removes (never U+0000, a refused control), a line and a column.
  FOREACH revisions IN ARRAY ARRAY['draft_revisions', 'roundup_revisions', 'article_revisions'] LOOP
    EXECUTE pg_catalog.format($fmt$
      ALTER TABLE %1$I.%2$I
        ADD COLUMN removed_characters jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD CONSTRAINT %3$I CHECK (
          pg_catalog.jsonb_typeof(removed_characters) = 'array'
          AND NOT pg_catalog.jsonb_path_exists(
            removed_characters,
            'strict $[*] ? (@.type() != "array" || @.size() != 3)'
          )
          AND NOT pg_catalog.jsonb_path_exists(
            removed_characters,
            'strict $[*][*] ? (@.type() != "number" || @ < 1 || @ != @.floor())'
          )
          AND NOT pg_catalog.jsonb_path_exists(removed_characters, 'strict $[*] ? (@[0] > 1114111)')
        )
    $fmt$, target, revisions, revisions || '_removed_characters');
  END LOOP;

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.roundup_revisions ADD CONSTRAINT roundup_revisions_removed_by_edit
      CHECK (kind = 'edited' OR removed_characters = '[]'::jsonb)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.article_revisions ADD CONSTRAINT article_revisions_removed_by_edit
      CHECK (kind = 'edited' OR removed_characters = '[]'::jsonb)
  $fmt$, target);
END
$migration$;
