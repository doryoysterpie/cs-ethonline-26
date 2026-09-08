-- 0005_classification_schema_security
--
-- Codex Desktop's Sprint 3 re-audit demonstrated two defects that migration
-- 0004 could not reach:
--
--   1. Both guard functions were created unqualified with `SET search_path
--      FROM CURRENT`, which in a default connection stores `"$user", public`.
--      A role able to create a schema named after itself put shadow
--      `classification_results` and `source_rows` tables in front of the real
--      ones, and completed a run that held no results at all. The same shadow
--      schema captured `schema_migrations`, so the migration runner reported
--      four applied migrations as none.
--
--   2. The completion check reconciled a run against the transaction's
--      repeatable-read snapshot, while the permanent completed record is
--      defined over the live batch. A source row committed after the snapshot
--      left a run marked completed that did not cover its batch.
--
-- This migration binds every integrity function to the exact schema it is
-- applied in, and makes a batch's source set immutable from the moment it
-- becomes eligible for classification. Migrations 0001 to 0004 are unchanged.
--
-- Everything below is executed through `pg_catalog.format` with `%I`, so each
-- table, function and trigger is named by a safely quoted identifier in the
-- target schema. Each function stores `search_path = pg_catalog, <schema>,
-- pg_temp`: `pg_catalog` first so a shadowing function or operator cannot
-- displace a built-in, the target schema next, and `pg_temp` last so the
-- session's temporary schema is searched after the application's tables
-- rather than before them. No function is SECURITY DEFINER; each runs with
-- the caller's privileges, so no owner escalation is introduced.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
  unreconciled integer;
BEGIN
  -- ---------------------------------------------------------------------
  -- 0. Bind to the schema that actually holds the tables.
  --
  -- The runner sets one explicit application schema, so `current_schema()`
  -- is that schema and not a captured `"$user"`. The assertions below refuse
  -- to proceed unless the tables really are there, so a redirected path
  -- fails the migration instead of installing guards somewhere else.

  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0005 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0005 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.import_batches') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.source_rows') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_results') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0005 target schema does not hold the application tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------
  -- 1. The source-set freeze marker.
  --
  -- `source_set_frozen_at` is set once, by the classifier, before it reads a
  -- single source row. `source_set_version` is bumped by every source-row
  -- mutation of a batch that is not yet frozen; that bump is a real row
  -- update, which is what makes a repeatable-read classifier fail rather
  -- than silently miss a row that committed after its snapshot.

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.import_batches
      ADD COLUMN source_set_frozen_at timestamptz,
      ADD COLUMN source_set_version   integer NOT NULL DEFAULT 0
  $fmt$, target);

  -- ---------------------------------------------------------------------
  -- 2. Every existing completed run must already reconcile.
  --
  -- Freezing a batch makes its source set permanent, so a run that does not
  -- cover its batch today would be legitimized for ever. The migration fails
  -- transactionally instead.

  EXECUTE pg_catalog.format($fmt$
    SELECT count(*) FROM %1$I.classification_runs r
     WHERE r.status = 'completed'
       AND (
         (SELECT count(*) FROM %1$I.classification_results c WHERE c.run_id = r.id)
           <> (SELECT count(*) FROM %1$I.source_rows s WHERE s.batch_id = r.batch_id)
         OR r.classified_row_count
           <> (SELECT count(*) FROM %1$I.classification_results c WHERE c.run_id = r.id)
         OR EXISTS (
           SELECT 1 FROM %1$I.source_rows s
            WHERE s.batch_id = r.batch_id
              AND NOT EXISTS (
                SELECT 1 FROM %1$I.classification_results c
                 WHERE c.run_id = r.id AND c.source_row_id = s.id))
         OR EXISTS (
           SELECT 1 FROM %1$I.classification_results c
            WHERE c.run_id = r.id AND c.batch_id <> r.batch_id)
       )
  $fmt$, target) INTO unreconciled;

  IF unreconciled <> 0 THEN
    RAISE EXCEPTION 'a completed classification run does not reconcile with its batch'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Freeze every batch that already carries a completed run. Historical
  -- rejected and superseded runs keep their records; their batches simply
  -- become immutable.
  EXECUTE pg_catalog.format($fmt$
    UPDATE %1$I.import_batches b
       SET source_set_frozen_at = pg_catalog.now()
     WHERE b.source_set_frozen_at IS NULL
       AND EXISTS (SELECT 1 FROM %1$I.classification_runs r
                    WHERE r.batch_id = b.id AND r.status = 'completed')
  $fmt$, target);

  -- ---------------------------------------------------------------------
  -- 3. Replace migration 0004's guard functions, schema-bound.
  --
  -- Same rules as 0004, with two differences: every relation is named by
  -- schema, and a run may only complete once its batch source set is frozen.
  -- The second is what makes a completed record permanently reconciled: after
  -- the freeze no source row of that batch can be added, changed or removed.

  EXECUTE pg_catalog.format($fmt$
    CREATE OR REPLACE FUNCTION %1$I.classification_run_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      derived_total   integer;
      derived_include integer;
      derived_exclude integer;
      derived_review  integer;
      batch_rows      integer;
      foreign_rows    integer;
      frozen          timestamptz;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'running' THEN
          RAISE EXCEPTION 'classification run must be inserted in the running state'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'completed' THEN
          RAISE EXCEPTION 'completed classification run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed classification run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;

      IF NEW.id <> OLD.id
         OR NEW.batch_id <> OLD.batch_id
         OR NEW.data_origin <> OLD.data_origin
         OR NEW.classifier_version <> OLD.classifier_version
         OR NEW.ruleset_version <> OLD.ruleset_version
         OR NEW.ruleset_hash <> OLD.ruleset_hash
         OR NEW.mode <> OLD.mode
         OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.expected_row_count <> OLD.expected_row_count
         OR NEW.started_at <> OLD.started_at THEN
        RAISE EXCEPTION 'classification run provenance is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;

      IF NEW.status = 'completed' THEN
        SELECT b.source_set_frozen_at INTO frozen
          FROM %1$I.import_batches b WHERE b.id = NEW.batch_id FOR SHARE;
        IF frozen IS NULL THEN
          RAISE EXCEPTION 'classification run cannot complete before its batch is frozen'
            USING ERRCODE = 'raise_exception';
        END IF;

        SELECT count(*),
               count(*) FILTER (WHERE decision = 'include'),
               count(*) FILTER (WHERE decision = 'exclude'),
               count(*) FILTER (WHERE decision = 'review')
          INTO derived_total, derived_include, derived_exclude, derived_review
          FROM %1$I.classification_results
         WHERE run_id = NEW.id;

        SELECT count(*) INTO batch_rows
          FROM %1$I.source_rows WHERE batch_id = NEW.batch_id;

        SELECT count(*) INTO foreign_rows
          FROM %1$I.classification_results r
         WHERE r.run_id = NEW.id AND r.batch_id <> NEW.batch_id;

        IF foreign_rows <> 0 THEN
          RAISE EXCEPTION 'classification run holds a result from another batch'
            USING ERRCODE = 'raise_exception';
        END IF;

        IF derived_total <> batch_rows THEN
          RAISE EXCEPTION 'classification run does not cover every row of its batch'
            USING ERRCODE = 'raise_exception';
        END IF;

        IF EXISTS (
          SELECT 1 FROM %1$I.source_rows s
           WHERE s.batch_id = NEW.batch_id
             AND NOT EXISTS (
               SELECT 1 FROM %1$I.classification_results r
                WHERE r.run_id = NEW.id AND r.source_row_id = s.id)
        ) THEN
          RAISE EXCEPTION 'classification run does not cover every row of its batch'
            USING ERRCODE = 'raise_exception';
        END IF;

        IF NEW.expected_row_count <> batch_rows
           OR NEW.classified_row_count <> derived_total
           OR NEW.include_count <> derived_include
           OR NEW.exclude_count <> derived_exclude
           OR NEW.review_count <> derived_review THEN
          RAISE EXCEPTION 'classification run counters do not match its stored results'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE OR REPLACE FUNCTION %1$I.classification_result_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_status text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        SELECT status INTO run_status
          FROM %1$I.classification_runs WHERE id = OLD.run_id FOR SHARE;
        IF run_status = 'completed' THEN
          RAISE EXCEPTION 'classification results of a completed run are immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        SELECT status INTO run_status
          FROM %1$I.classification_runs WHERE id = NEW.run_id FOR SHARE;
        IF run_status = 'completed' THEN
          RAISE EXCEPTION 'classification results of a completed run are immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  -- Recreate both triggers explicitly against the schema-qualified functions.
  EXECUTE pg_catalog.format(
    'DROP TRIGGER IF EXISTS classification_runs_guard ON %1$I.classification_runs', target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER classification_runs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.classification_runs
      FOR EACH ROW EXECUTE FUNCTION %1$I.classification_run_guard()
  $fmt$, target);

  EXECUTE pg_catalog.format(
    'DROP TRIGGER IF EXISTS classification_results_guard ON %1$I.classification_results', target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER classification_results_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.classification_results
      FOR EACH ROW EXECUTE FUNCTION %1$I.classification_result_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------
  -- 4. The source-set freeze itself.
  --
  -- Every source-row mutation passes through one statement that updates the
  -- parent batch row. That single statement does both jobs:
  --
  --   * it refuses the mutation when the batch is already frozen; and
  --   * it is a real update, so a classifier holding an older repeatable-read
  --     snapshot cannot freeze the same batch without a serialization
  --     failure.
  --
  -- The two orderings are therefore both safe. A mutation that commits before
  -- the freeze is inside the classifier's snapshot. A mutation that has not
  -- committed when the classifier freezes is rejected when it reaches this
  -- statement, and its rows roll back with it.
  --
  -- Statement-level triggers with transition tables keep the cost to one
  -- parent update per statement rather than one per row, and the loop visits
  -- batches in identifier order so two concurrent multi-batch statements
  -- cannot deadlock against each other.

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.source_rows_freeze_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      affected uuid;
      still_there boolean;
    BEGIN
      FOR affected IN
        SELECT batch_id FROM (
          SELECT batch_id FROM changed_rows
        ) t GROUP BY batch_id ORDER BY batch_id
      LOOP
        UPDATE %1$I.import_batches
           SET source_set_version = source_set_version + 1
         WHERE id = affected AND source_set_frozen_at IS NULL;
        IF NOT FOUND THEN
          SELECT true INTO still_there
            FROM %1$I.import_batches WHERE id = affected;
          IF still_there THEN
            RAISE EXCEPTION 'source rows of a frozen batch are immutable'
              USING ERRCODE = 'raise_exception';
          END IF;
        END IF;
      END LOOP;
      RETURN NULL;
    END;
    $guard$
  $fmt$, target);

  -- One trigger per operation, because the transition tables a trigger may
  -- reference depend on the operation. Each presents its rows to the function
  -- under the single name `changed_rows`; an update presents both sides
  -- through two triggers, so moving a row between batches locks the old
  -- association and the new one.
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER source_rows_freeze_insert
      AFTER INSERT ON %1$I.source_rows
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.source_rows_freeze_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER source_rows_freeze_delete
      AFTER DELETE ON %1$I.source_rows
      REFERENCING OLD TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.source_rows_freeze_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER source_rows_freeze_update_old
      AFTER UPDATE ON %1$I.source_rows
      REFERENCING OLD TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.source_rows_freeze_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER source_rows_freeze_update_new
      AFTER UPDATE ON %1$I.source_rows
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.source_rows_freeze_guard()
  $fmt$, target);

  -- ---------------------------------------------------------------------
  -- 5. Bulk removal, and the marker itself.

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.frozen_batch_truncate_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF EXISTS (SELECT 1 FROM %1$I.import_batches WHERE source_set_frozen_at IS NOT NULL) THEN
        RAISE EXCEPTION 'source rows of a frozen batch are immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NULL;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER source_rows_freeze_truncate
      BEFORE TRUNCATE ON %1$I.source_rows
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.frozen_batch_truncate_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER import_batches_freeze_truncate
      BEFORE TRUNCATE ON %1$I.import_batches
      FOR EACH STATEMENT EXECUTE FUNCTION %1$I.frozen_batch_truncate_guard()
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.import_batch_freeze_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.source_set_frozen_at IS NOT NULL THEN
          RAISE EXCEPTION 'a frozen import batch cannot be deleted'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.source_set_frozen_at IS NOT NULL THEN
        IF NEW.source_set_frozen_at IS DISTINCT FROM OLD.source_set_frozen_at THEN
          RAISE EXCEPTION 'the source set freeze marker is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF NEW.id <> OLD.id OR NEW.data_origin <> OLD.data_origin THEN
          RAISE EXCEPTION 'a frozen import batch cannot change identity or origin'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER import_batches_freeze_guard
      BEFORE UPDATE OR DELETE ON %1$I.import_batches
      FOR EACH ROW EXECUTE FUNCTION %1$I.import_batch_freeze_guard()
  $fmt$, target);
END
$migration$;
