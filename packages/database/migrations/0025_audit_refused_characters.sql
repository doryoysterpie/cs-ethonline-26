-- 0025_audit_refused_characters
--
-- CAS-012, the owner's ruling of 1 November 2026 on a refusal's notice (the
-- D50 amendment of that day). A refused save stores nothing, and its notice
-- names the first twenty refused characters and counts the rest, since the
-- list travels in the redirect. The record of a refused save is its audit
-- event: it now carries the field refused, the exact number of refused
-- characters, and the code point of each, in the order they stood. It carries
-- no position and no text. The event is the record; the redirect is the
-- notice.
--
-- The three columns are null together on every other event, and on every
-- existing one; adding columns with no default rewrites no row, so the
-- append-only guard of migration 0010 stands.
--
-- Migrations 0001 to 0024 are unchanged.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0025 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0025 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.audit_events') IS NULL THEN
    RAISE EXCEPTION 'migration 0025 target schema does not hold the audit table'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- A field is an identifier from the code (`markdown`), never a value; each
  -- code point is a whole number no greater than U+10FFFF. The three are named
  -- NOT NULL in the second branch, since a check that evaluates to null passes.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.audit_events
      ADD COLUMN refused_field text,
      ADD COLUMN refused_count integer,
      ADD COLUMN refused_code_points integer[],
      ADD CONSTRAINT audit_events_refused_characters CHECK (
        (refused_field IS NULL AND refused_count IS NULL AND refused_code_points IS NULL)
        OR (
          refused_field IS NOT NULL AND refused_count IS NOT NULL
          AND refused_code_points IS NOT NULL
          AND outcome = 'failure'
          AND refused_field ~ '^[a-z][A-Za-z]{0,31}$'
          AND refused_count >= 1
          AND pg_catalog.array_ndims(refused_code_points) = 1
          AND pg_catalog.cardinality(refused_code_points) = refused_count
          AND pg_catalog.array_position(refused_code_points, NULL) IS NULL
          AND 0 <= ALL (refused_code_points)
          AND 1114111 >= ALL (refused_code_points)
        )
      )
  $fmt$, target);
END
$migration$;
