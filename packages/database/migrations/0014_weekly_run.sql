-- 0014_weekly_run
--
-- CAS-003 (post-event plan, D10 resolution, D37, D38): one command runs the
-- editorial week and records a manifest; the owner selects stories per
-- incident, with provenance.
--
--   1. **The manifest.** `week_runs` names the window (D10: Saturday 23:59 to
--      Saturday 23:59, America/Toronto; the freeze is the close; the
--      publication cutoff follows), the batch the week ran over, the
--      categories covered, and a status. A guard permits exactly one
--      transition, running to completed or failed, and refuses every other
--      update and every delete. Completed manifests are unique per key; a
--      failed attempt stays as history and a retry can proceed.
--
--   2. **The children.** `week_run_children` records every child run in
--      order, with its kind, category, identifier and outcome. Exactly one
--      identifier is set per kind unless the child failed, and a child can be
--      recorded only while its manifest is running. Append-only.
--
--   3. **The selection.** `issue_selections` is the owner's per-incident
--      decision for a week, bound to the incident by the composite key of
--      migration 0006 and to the manifest by its batch; unselecting is a new
--      record with the next revision, and the latest revision is the state.
--      `issue_selection_members` carries the incident's member rows at the
--      time of selection as references, never text. Both append-only.
--
-- Migrations 0001 to 0013 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0014 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0014 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.clustering_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.incident_clusters') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.accounts') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0014 target schema does not hold the clustering and account tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1. The manifest.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.week_runs (
      id                     uuid        PRIMARY KEY,
      data_origin            text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
      batch_id               uuid        NOT NULL,
      time_zone              text        NOT NULL CHECK (time_zone ~ '^[A-Za-z_]+/[A-Za-z_]+$'),
      window_start           timestamptz NOT NULL,
      window_end             timestamptz NOT NULL,
      freeze_at              timestamptz NOT NULL,
      publication_cutoff_at  timestamptz NOT NULL,
      categories             jsonb       NOT NULL
                               CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) > 0),
      idempotency_key        text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      status                 text        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      failure_code           text        CHECK (failure_code ~ '^[a-z][a-z0-9_]{1,63}$'),
      started_at             timestamptz NOT NULL,
      completed_at           timestamptz,
      CONSTRAINT week_runs_window CHECK (window_end > window_start),
      CONSTRAINT week_runs_freeze CHECK (freeze_at = window_end),
      CONSTRAINT week_runs_cutoff CHECK (publication_cutoff_at > freeze_at),
      CONSTRAINT week_runs_completion CHECK ((status <> 'running') = (completed_at IS NOT NULL)),
      CONSTRAINT week_runs_failure CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
      CONSTRAINT week_runs_id_batch UNIQUE (id, batch_id),
      CONSTRAINT week_runs_batch_fk
        FOREIGN KEY (batch_id, data_origin) REFERENCES %1$I.import_batches (id, data_origin)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE UNIQUE INDEX week_runs_completed_key ON %1$I.week_runs (idempotency_key)
      WHERE status = 'completed'
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.week_run_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'running' THEN
          RAISE EXCEPTION 'a week run must be inserted in the running state'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a week run is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      IF OLD.status <> 'running' THEN
        RAISE EXCEPTION 'a completed or failed week run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.status NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'a week run may only move from running to completed or failed'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.data_origin <> OLD.data_origin
         OR NEW.batch_id <> OLD.batch_id
         OR NEW.time_zone <> OLD.time_zone
         OR NEW.window_start <> OLD.window_start
         OR NEW.window_end <> OLD.window_end
         OR NEW.freeze_at <> OLD.freeze_at
         OR NEW.publication_cutoff_at <> OLD.publication_cutoff_at
         OR NEW.categories <> OLD.categories
         OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.started_at <> OLD.started_at THEN
        RAISE EXCEPTION 'week run provenance is immutable' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER week_runs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.week_runs
      FOR EACH ROW EXECUTE FUNCTION %1$I.week_run_guard()
  $fmt$, target);

  -- 2. The children.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.week_run_children (
      id                     uuid        PRIMARY KEY,
      week_run_id            uuid        NOT NULL REFERENCES %1$I.week_runs (id),
      position               integer     NOT NULL CHECK (position >= 1),
      kind                   text        NOT NULL CHECK (kind IN ('import', 'classification', 'clustering')),
      category               text        CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      batch_id               uuid        REFERENCES %1$I.import_batches (id),
      classification_run_id  uuid        REFERENCES %1$I.classification_runs (id),
      clustering_run_id      uuid        REFERENCES %1$I.clustering_runs (id),
      outcome                text        NOT NULL CHECK (outcome IN ('created', 'reused', 'provided', 'failed')),
      error_code             text        CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
      created_at             timestamptz NOT NULL,
      CONSTRAINT week_run_children_position UNIQUE (week_run_id, position),
      CONSTRAINT week_run_children_kind_category UNIQUE NULLS NOT DISTINCT (week_run_id, kind, category),
      CONSTRAINT week_run_children_failure CHECK ((outcome = 'failed') = (error_code IS NOT NULL)),
      CONSTRAINT week_run_children_category CHECK ((kind = 'import') = (category IS NULL)),
      CONSTRAINT week_run_children_identity CHECK (
        (outcome = 'failed' AND batch_id IS NULL AND classification_run_id IS NULL AND clustering_run_id IS NULL)
        OR (kind = 'import' AND batch_id IS NOT NULL AND classification_run_id IS NULL AND clustering_run_id IS NULL)
        OR (kind = 'classification' AND batch_id IS NULL AND classification_run_id IS NOT NULL AND clustering_run_id IS NULL)
        OR (kind = 'clustering' AND batch_id IS NULL AND classification_run_id IS NULL AND clustering_run_id IS NOT NULL)
      )
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.week_run_child_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_status text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a week run child is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      SELECT w.status INTO run_status FROM %1$I.week_runs w WHERE w.id = NEW.week_run_id FOR SHARE;
      IF run_status IS NULL THEN
        RAISE EXCEPTION 'a week run child must name an existing week run'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF run_status <> 'running' THEN
        RAISE EXCEPTION 'a week run child can be recorded only while its week run is running'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER week_run_children_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.week_run_children
      FOR EACH ROW EXECUTE FUNCTION %1$I.week_run_child_guard()
  $fmt$, target);

  -- 3. The selection.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.issue_selections (
      id                 uuid        PRIMARY KEY,
      week_run_id        uuid        NOT NULL,
      batch_id           uuid        NOT NULL,
      clustering_run_id  uuid        NOT NULL,
      incident_id        uuid        NOT NULL,
      category           text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      state              text        NOT NULL CHECK (state IN ('selected', 'unselected')),
      revision           integer     NOT NULL CHECK (revision >= 1),
      actor_account_id   uuid        NOT NULL REFERENCES %1$I.accounts (id),
      note               text        CHECK (note IS NULL OR pg_catalog.length(note) BETWEEN 1 AND 2000),
      created_at         timestamptz NOT NULL,
      CONSTRAINT issue_selections_revision UNIQUE (week_run_id, incident_id, revision),
      CONSTRAINT issue_selections_identity UNIQUE (id, clustering_run_id),
      CONSTRAINT issue_selections_week_fk
        FOREIGN KEY (week_run_id, batch_id) REFERENCES %1$I.week_runs (id, batch_id),
      CONSTRAINT issue_selections_incident_fk
        FOREIGN KEY (incident_id, clustering_run_id, batch_id)
        REFERENCES %1$I.incident_clusters (id, clustering_run_id, batch_id)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.issue_selection_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      last_revision integer;
      child_count   integer;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'an issue selection is append-only; unselecting is a new revision'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT count(*) INTO child_count FROM %1$I.week_run_children c
       WHERE c.week_run_id = NEW.week_run_id AND c.clustering_run_id = NEW.clustering_run_id
         AND c.kind = 'clustering' AND c.category = NEW.category;
      IF child_count <> 1 THEN
        RAISE EXCEPTION 'an issue selection must name a clustering run its week run recorded for that category'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT coalesce(max(s.revision), 0) INTO last_revision FROM %1$I.issue_selections s
       WHERE s.week_run_id = NEW.week_run_id AND s.incident_id = NEW.incident_id;
      IF NEW.revision <> last_revision + 1 THEN
        RAISE EXCEPTION 'an issue selection revision must follow the last one'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER issue_selections_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.issue_selections
      FOR EACH ROW EXECUTE FUNCTION %1$I.issue_selection_guard()
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.issue_selection_members (
      selection_id       uuid        NOT NULL,
      clustering_run_id  uuid        NOT NULL,
      membership_id      uuid        NOT NULL,
      source_row_id      uuid        NOT NULL,
      batch_id           uuid        NOT NULL,
      row_hash           text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT issue_selection_members_pkey PRIMARY KEY (selection_id, membership_id),
      CONSTRAINT issue_selection_members_selection_fk
        FOREIGN KEY (selection_id, clustering_run_id) REFERENCES %1$I.issue_selections (id, clustering_run_id),
      CONSTRAINT issue_selection_members_membership_fk
        FOREIGN KEY (membership_id, clustering_run_id) REFERENCES %1$I.incident_memberships (id, clustering_run_id),
      CONSTRAINT issue_selection_members_row_fk
        FOREIGN KEY (source_row_id, batch_id, row_hash) REFERENCES %1$I.source_rows (id, batch_id, row_hash)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.issue_selection_member_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'an issue selection member is append-only' USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER issue_selection_members_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.issue_selection_members
      FOR EACH ROW EXECUTE FUNCTION %1$I.issue_selection_member_guard()
  $fmt$, target);
END
$migration$;
