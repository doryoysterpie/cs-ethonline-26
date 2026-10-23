-- 0022_publication_sequence
--
-- CAS-009, after the owner's review of the open image-cache failure (23
-- October 2026; `docs/CAS-009-REPORT.md`, section 7). The latest publication
-- record of an output decides what readers and story cards see (D42), and
-- "latest" was read as the greatest `created_at`, an instant the application
-- writes from its own clock: two records in one millisecond, or written by
-- two instances whose clocks disagree, have no defined order. Each record now
-- carries `seq`, a number PostgreSQL assigns from one sequence at insert,
-- unique, never supplied by the application, so the order of records is the
-- order they were written. The current publication is the greatest `seq`.
-- Existing rows receive numbers when the column is added; nothing else about
-- them changes, and the append-only guard of migration 0017 stands.
--
-- Migrations 0001 to 0021 are unchanged.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0022 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0022 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.output_publications') IS NULL THEN
    RAISE EXCEPTION 'migration 0022 target schema does not hold the publication table'
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.output_publications
      ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY,
      ADD CONSTRAINT output_publications_seq_unique UNIQUE (seq)
  $fmt$, target);
  EXECUTE pg_catalog.format('DROP INDEX %1$I.output_publications_current_idx', target);
  EXECUTE pg_catalog.format($fmt$
    CREATE INDEX output_publications_current_idx
      ON %1$I.output_publications (week_run_id, category, output, seq DESC)
  $fmt$, target);
END
$migration$;
