-- 0004_classification_integrity
--
-- Codex Desktop audit correction for Sprint 3. Migration 0003 left two gaps
-- that the audit demonstrated in a disposable database:
--
--   1. `classification_results.row_hash` was only shape-checked, so a result
--      could claim an input fingerprint that was not its source row's.
--   2. Nothing stopped a direct UPDATE or DELETE from rewriting a completed
--      run's decisions, rationales, counters, versions or provenance.
--
-- This migration binds the fingerprint relationally and makes a completed run
-- immutable at the database level, not merely in TypeScript. It also opens a
-- `running` state so a run can no longer be inserted as already complete: a
-- run becomes `completed` only through a transition that independently
-- re-derives every counter from the stored results.
--
-- Forward-only. Migrations 0001, 0002 and 0003 are not altered. Every
-- constraint below validates the existing rows as it is added, so a database
-- holding a contradiction fails this migration and is left unchanged.

-- ---------------------------------------------------------------------------
-- 1. Bind a result's input fingerprint to its source row.

-- Parent key for the composite foreign key. `id` is already the primary key,
-- so this only publishes the triple.
ALTER TABLE source_rows
  ADD CONSTRAINT source_rows_id_batch_hash UNIQUE (id, batch_id, row_hash);

-- A result's row hash must be the hash of the row it names. A syntactically
-- valid but different SHA-256 is rejected, on insert and on update, and the
-- source row's hash can no longer be changed out from under a stored result.
ALTER TABLE classification_results
  ADD CONSTRAINT classification_results_row_hash_fk
    FOREIGN KEY (source_row_id, batch_id, row_hash)
    REFERENCES source_rows (id, batch_id, row_hash);

-- ---------------------------------------------------------------------------
-- 2. Open a running state, and make the completed counters conditional.

ALTER TABLE classification_runs
  DROP CONSTRAINT classification_runs_status_check,
  DROP CONSTRAINT classification_runs_decision_counts,
  DROP CONSTRAINT classification_runs_complete;

ALTER TABLE classification_runs
  ALTER COLUMN completed_at DROP NOT NULL,
  ADD CONSTRAINT classification_runs_status
    CHECK (status IN ('running', 'completed')),
  ADD CONSTRAINT classification_runs_completed_at
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  -- The decision counts must always sum, and a completed run must additionally
  -- account for every row of its batch.
  ADD CONSTRAINT classification_runs_decision_counts
    CHECK (classified_row_count = include_count + exclude_count + review_count),
  ADD CONSTRAINT classification_runs_complete
    CHECK (status <> 'completed' OR classified_row_count = expected_row_count);

-- ---------------------------------------------------------------------------
-- 3. Completion validation and immutability.
--
-- Both functions are SECURITY INVOKER and pin the search path they were
-- created with, so they resolve the same tables the migration did. Their
-- messages are fixed strings: no identifier, source text, label or connection
-- detail is ever interpolated into an error.

CREATE FUNCTION classification_run_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path FROM CURRENT
AS $$
DECLARE
  derived_total   integer;
  derived_include integer;
  derived_exclude integer;
  derived_review  integer;
  batch_rows      integer;
  foreign_rows    integer;
BEGIN
  -- A run always begins as `running`. Without this an INSERT could declare
  -- itself complete with counters that sum correctly but describe no stored
  -- result at all, since the completion checks below only run on the
  -- transition.
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

  -- A completed run is frozen: no column may change, and it cannot go back to
  -- running.
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed classification run is immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Identity and provenance are fixed for the life of a run.
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
    -- Derive every counter from the stored results rather than trusting the
    -- values the caller supplied.
    SELECT count(*),
           count(*) FILTER (WHERE decision = 'include'),
           count(*) FILTER (WHERE decision = 'exclude'),
           count(*) FILTER (WHERE decision = 'review')
      INTO derived_total, derived_include, derived_exclude, derived_review
      FROM classification_results
     WHERE run_id = NEW.id;

    SELECT count(*) INTO batch_rows FROM source_rows WHERE batch_id = NEW.batch_id;

    SELECT count(*) INTO foreign_rows
      FROM classification_results r
     WHERE r.run_id = NEW.id AND r.batch_id <> NEW.batch_id;

    IF foreign_rows <> 0 THEN
      RAISE EXCEPTION 'classification run holds a result from another batch'
        USING ERRCODE = 'raise_exception';
    END IF;

    -- Exactly one result per source row of the batch, and no result for a row
    -- outside it. The unique key on (run_id, source_row_id) already forbids
    -- duplicates, so equal counts plus full coverage is sufficient.
    IF derived_total <> batch_rows THEN
      RAISE EXCEPTION 'classification run does not cover every row of its batch'
        USING ERRCODE = 'raise_exception';
    END IF;
    IF EXISTS (
      SELECT 1 FROM source_rows s
       WHERE s.batch_id = NEW.batch_id
         AND NOT EXISTS (
           SELECT 1 FROM classification_results r
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
$$;

CREATE TRIGGER classification_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON classification_runs
  FOR EACH ROW EXECUTE FUNCTION classification_run_guard();

CREATE FUNCTION classification_result_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path FROM CURRENT
AS $$
DECLARE
  run_status text;
BEGIN
  -- Take a share lock on the parent run before reading its status, so a
  -- mutation cannot pass a stale `running` check while another transaction is
  -- completing the run. The completing UPDATE takes an exclusive row lock, so
  -- the two serialize.
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO run_status FROM classification_runs WHERE id = OLD.run_id FOR SHARE;
    IF run_status = 'completed' THEN
      RAISE EXCEPTION 'classification results of a completed run are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO run_status FROM classification_runs WHERE id = NEW.run_id FOR SHARE;
    IF run_status = 'completed' THEN
      RAISE EXCEPTION 'classification results of a completed run are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_results_guard
  BEFORE INSERT OR UPDATE OR DELETE ON classification_results
  FOR EACH ROW EXECUTE FUNCTION classification_result_guard();
