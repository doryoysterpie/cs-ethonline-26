-- 0006_incident_clustering
--
-- Sprint 4, decision D22. Turns eligible classification results into
-- provisional canonical incidents, and keeps the machine's record and the
-- human's corrections in separate layers.
--
-- Four ideas the schema enforces rather than documents:
--
--   1. A base clustering run covers its classification run exactly: every
--      eligible `include` or `review` result has exactly one membership, no
--      excluded result has any, and nothing crosses a batch, a classification
--      run or a clustering run.
--   2. A completed run, its clusters and its memberships are immutable, as in
--      Sprint 3. The machine record stays what the engine produced.
--   3. Human merge and split are append-only actions over a completed run.
--      They never rewrite the base output; the effective view is replayed from
--      the base plus the ordered actions.
--   4. Every membership carries its whole provenance chain: source row and
--      hash, classification result, classification run, batch, origin and
--      clustering run.
--
-- Migrations 0001 to 0005 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp` with every relation named by schema. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0006 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0006 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_results') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.source_rows') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0006 target schema does not hold the application tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Parent key so a membership can bind to the exact classification result,
  -- its run, its row and its batch in one composite reference.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.classification_results
      ADD CONSTRAINT classification_results_identity
        UNIQUE (id, run_id, source_row_id, batch_id)
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 1. Clustering runs.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.clustering_runs (
      id                          uuid        PRIMARY KEY,
      classification_run_id       uuid        NOT NULL,
      batch_id                    uuid        NOT NULL,
      data_origin                 text        NOT NULL
                                    CHECK (data_origin IN ('live', 'fixture', 'replay')),
      engine_version              text        NOT NULL CHECK (length(engine_version) > 0),
      contract_version            text        NOT NULL CHECK (length(contract_version) > 0),
      contract_hash               text        NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
      idempotency_key             text        NOT NULL UNIQUE
                                    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      status                      text        NOT NULL CHECK (status IN ('running', 'completed')),
      eligible_row_count          integer     NOT NULL CHECK (eligible_row_count >= 0),
      ineligible_row_count        integer     NOT NULL CHECK (ineligible_row_count >= 0),
      duplicate_group_count       integer     NOT NULL CHECK (duplicate_group_count >= 0),
      syndication_group_count     integer     NOT NULL CHECK (syndication_group_count >= 0),
      incident_count              integer     NOT NULL CHECK (incident_count >= 0),
      singleton_incident_count    integer     NOT NULL CHECK (singleton_incident_count >= 0),
      multi_source_incident_count integer     NOT NULL CHECK (multi_source_incident_count >= 0),
      largest_cluster_size        integer     NOT NULL CHECK (largest_cluster_size >= 0),
      ambiguous_link_count        integer     NOT NULL CHECK (ambiguous_link_count >= 0),
      started_at                  timestamptz NOT NULL,
      completed_at                timestamptz,
      CONSTRAINT clustering_runs_completed_at
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
      CONSTRAINT clustering_runs_incident_counts
        CHECK (incident_count = singleton_incident_count + multi_source_incident_count),
      CONSTRAINT clustering_runs_classification_fk
        FOREIGN KEY (classification_run_id, batch_id)
        REFERENCES %1$I.classification_runs (id, batch_id),
      CONSTRAINT clustering_runs_batch_origin_fk
        FOREIGN KEY (batch_id, data_origin)
        REFERENCES %1$I.import_batches (id, data_origin),
      CONSTRAINT clustering_runs_id_batch UNIQUE (id, batch_id)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format(
    'CREATE INDEX clustering_runs_classification_idx ON %1$I.clustering_runs (classification_run_id)',
    target);

  -- -------------------------------------------------------------------------
  -- 2. Provisional incident clusters.
  --
  -- The cluster row holds machine output only: a deterministic fingerprint,
  -- the kind the engine derived, counts, stable reason codes and a
  -- deterministically selected representative membership. No prose is stored,
  -- because no prose here would be canonical incident truth.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_clusters (
      id                       uuid        PRIMARY KEY,
      clustering_run_id        uuid        NOT NULL,
      batch_id                 uuid        NOT NULL,
      fingerprint              text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{8,128}$'),
      kind                     text        NOT NULL CHECK (kind IN
                                 ('singleton', 'duplicate_group', 'syndicated_group',
                                  'multi_report_incident')),
      member_count             integer     NOT NULL CHECK (member_count > 0),
      duplicate_group_count    integer     NOT NULL CHECK (duplicate_group_count > 0),
      syndication_group_count  integer     NOT NULL CHECK (syndication_group_count > 0),
      reason_codes             jsonb       NOT NULL
                                 CHECK (jsonb_typeof(reason_codes) = 'array'
                                        AND jsonb_array_length(reason_codes) > 0),
      representative_source_row_id uuid    NOT NULL,
      created_at               timestamptz NOT NULL,
      CONSTRAINT incident_clusters_run_fingerprint UNIQUE (clustering_run_id, fingerprint),
      CONSTRAINT incident_clusters_identity UNIQUE (id, clustering_run_id, batch_id),
      CONSTRAINT incident_clusters_run_fk
        FOREIGN KEY (clustering_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, batch_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 3. Memberships, carrying the whole provenance chain.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_memberships (
      id                       uuid        PRIMARY KEY,
      clustering_run_id        uuid        NOT NULL,
      incident_cluster_id      uuid        NOT NULL,
      batch_id                 uuid        NOT NULL,
      data_origin              text        NOT NULL
                                 CHECK (data_origin IN ('live', 'fixture', 'replay')),
      source_row_id            uuid        NOT NULL,
      row_hash                 text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
      classification_result_id uuid        NOT NULL,
      classification_run_id    uuid        NOT NULL,
      decision                 text        NOT NULL CHECK (decision IN ('include', 'review')),
      duplicate_fingerprint    text        NOT NULL CHECK (duplicate_fingerprint ~ '^[0-9a-f]{8,128}$'),
      syndication_fingerprint  text        NOT NULL CHECK (syndication_fingerprint ~ '^[0-9a-f]{8,128}$'),
      created_at               timestamptz NOT NULL,
      CONSTRAINT incident_memberships_run_row UNIQUE (clustering_run_id, source_row_id),
      CONSTRAINT incident_memberships_identity UNIQUE (id, clustering_run_id),
      CONSTRAINT incident_memberships_cluster_fk
        FOREIGN KEY (incident_cluster_id, clustering_run_id, batch_id)
        REFERENCES %1$I.incident_clusters (id, clustering_run_id, batch_id),
      CONSTRAINT incident_memberships_run_fk
        FOREIGN KEY (clustering_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, batch_id),
      CONSTRAINT incident_memberships_source_fk
        FOREIGN KEY (source_row_id, batch_id, row_hash)
        REFERENCES %1$I.source_rows (id, batch_id, row_hash),
      CONSTRAINT incident_memberships_result_fk
        FOREIGN KEY (classification_result_id, classification_run_id, source_row_id, batch_id)
        REFERENCES %1$I.classification_results (id, run_id, source_row_id, batch_id),
      CONSTRAINT incident_memberships_batch_origin_fk
        FOREIGN KEY (batch_id, data_origin)
        REFERENCES %1$I.import_batches (id, data_origin)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format(
    'CREATE INDEX incident_memberships_cluster_idx ON %1$I.incident_memberships (incident_cluster_id)',
    target);

  -- -------------------------------------------------------------------------
  -- 4. Ambiguous links: relationships the engine refused to act on.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.clustering_ambiguous_links (
      id                   uuid        PRIMARY KEY,
      clustering_run_id    uuid        NOT NULL,
      batch_id             uuid        NOT NULL,
      left_fingerprint     text        NOT NULL CHECK (left_fingerprint ~ '^[0-9a-f]{8,128}$'),
      right_fingerprint    text        NOT NULL CHECK (right_fingerprint ~ '^[0-9a-f]{8,128}$'),
      reason_codes         jsonb       NOT NULL
                             CHECK (jsonb_typeof(reason_codes) = 'array'
                                    AND jsonb_array_length(reason_codes) > 0),
      similarity           numeric(9, 6) NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
      shared_signals       integer     NOT NULL CHECK (shared_signals >= 0),
      shared_rare_signals  integer     NOT NULL CHECK (shared_rare_signals >= 0),
      created_at           timestamptz NOT NULL,
      CONSTRAINT clustering_links_pair UNIQUE (clustering_run_id, left_fingerprint, right_fingerprint),
      CONSTRAINT clustering_links_distinct CHECK (left_fingerprint <> right_fingerprint),
      CONSTRAINT clustering_links_run_fk
        FOREIGN KEY (clustering_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, batch_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 5. The human layer: append-only merge and split actions.
  --
  -- One linear revision history per run. `resulting_revision` is unique per
  -- run, so two actions claiming the same prior revision cannot both land: the
  -- second is rejected as stale by the database rather than by a check in the
  -- application.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.clustering_review_actions (
      id                      uuid        PRIMARY KEY,
      clustering_run_id       uuid        NOT NULL,
      batch_id                uuid        NOT NULL,
      operation               text        NOT NULL CHECK (operation IN ('merge', 'split')),
      reason_code             text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      note                    text        CHECK (note IS NULL OR length(note) BETWEEN 1 AND 280),
      actor                   text        NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
      prior_revision          integer     NOT NULL CHECK (prior_revision >= 0),
      resulting_revision      integer     NOT NULL CHECK (resulting_revision > 0),
      idempotency_key         text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      affected_incident_ids   jsonb       NOT NULL
                                CHECK (jsonb_typeof(affected_incident_ids) = 'array'),
      affected_membership_ids jsonb       NOT NULL
                                CHECK (jsonb_typeof(affected_membership_ids) = 'array'),
      created_at              timestamptz NOT NULL,
      CONSTRAINT clustering_actions_revision CHECK (resulting_revision = prior_revision + 1),
      CONSTRAINT clustering_actions_run_revision UNIQUE (clustering_run_id, resulting_revision),
      CONSTRAINT clustering_actions_idempotent UNIQUE (clustering_run_id, idempotency_key),
      CONSTRAINT clustering_actions_shape CHECK (
        (operation = 'merge'
           AND jsonb_array_length(affected_incident_ids) BETWEEN 2 AND 64
           AND jsonb_array_length(affected_membership_ids) = 0)
        OR
        (operation = 'split'
           AND jsonb_array_length(affected_incident_ids) = 1
           AND jsonb_array_length(affected_membership_ids) BETWEEN 1 AND 500)
      ),
      CONSTRAINT clustering_actions_run_fk
        FOREIGN KEY (clustering_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, batch_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 6. Guards.

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.clustering_run_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      eligible        integer;
      ineligible      integer;
      memberships     integer;
      clusters        integer;
      singletons      integer;
      multi           integer;
      largest         integer;
      uncovered       integer;
      excluded_linked integer;
      links           integer;
      duplicates      integer;
      syndications    integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'running' THEN
          RAISE EXCEPTION 'clustering run must be inserted in the running state'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'completed' THEN
          RAISE EXCEPTION 'completed clustering run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed clustering run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;

      IF NEW.id <> OLD.id
         OR NEW.classification_run_id <> OLD.classification_run_id
         OR NEW.batch_id <> OLD.batch_id
         OR NEW.data_origin <> OLD.data_origin
         OR NEW.engine_version <> OLD.engine_version
         OR NEW.contract_version <> OLD.contract_version
         OR NEW.contract_hash <> OLD.contract_hash
         OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.started_at <> OLD.started_at THEN
        RAISE EXCEPTION 'clustering run provenance is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;

      IF NEW.status = 'completed' THEN
        SELECT count(*) FILTER (WHERE decision IN ('include', 'review')),
               count(*) FILTER (WHERE decision NOT IN ('include', 'review'))
          INTO eligible, ineligible
          FROM %1$I.classification_results
         WHERE run_id = NEW.classification_run_id;

        SELECT count(*) INTO memberships
          FROM %1$I.incident_memberships WHERE clustering_run_id = NEW.id;

        SELECT count(*),
               count(*) FILTER (WHERE member_count = 1),
               count(*) FILTER (WHERE member_count > 1),
               coalesce(max(member_count), 0),
               coalesce(sum(duplicate_group_count), 0),
               coalesce(sum(syndication_group_count), 0)
          INTO clusters, singletons, multi, largest, duplicates, syndications
          FROM %1$I.incident_clusters WHERE clustering_run_id = NEW.id;

        SELECT count(*) INTO uncovered
          FROM %1$I.classification_results r
         WHERE r.run_id = NEW.classification_run_id
           AND r.decision IN ('include', 'review')
           AND NOT EXISTS (
             SELECT 1 FROM %1$I.incident_memberships m
              WHERE m.clustering_run_id = NEW.id AND m.source_row_id = r.source_row_id);

        SELECT count(*) INTO excluded_linked
          FROM %1$I.incident_memberships m
          JOIN %1$I.classification_results r
            ON r.id = m.classification_result_id
         WHERE m.clustering_run_id = NEW.id
           AND r.decision NOT IN ('include', 'review');

        SELECT count(*) INTO links
          FROM %1$I.clustering_ambiguous_links WHERE clustering_run_id = NEW.id;

        IF uncovered <> 0 THEN
          RAISE EXCEPTION 'clustering run does not cover every eligible classification result'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF excluded_linked <> 0 THEN
          RAISE EXCEPTION 'clustering run holds a membership for an excluded result'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF memberships <> eligible THEN
          RAISE EXCEPTION 'clustering run membership count does not match its eligible results'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF (SELECT coalesce(sum(member_count), 0) FROM %1$I.incident_clusters
             WHERE clustering_run_id = NEW.id) <> memberships THEN
          RAISE EXCEPTION 'clustering run cluster sizes do not match its memberships'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF NEW.eligible_row_count <> eligible
           OR NEW.ineligible_row_count <> ineligible
           OR NEW.incident_count <> clusters
           OR NEW.singleton_incident_count <> singletons
           OR NEW.multi_source_incident_count <> multi
           OR NEW.largest_cluster_size <> largest
           OR NEW.ambiguous_link_count <> links
           OR NEW.duplicate_group_count <> duplicates
           OR NEW.syndication_group_count <> syndications THEN
          RAISE EXCEPTION 'clustering run counters do not match its stored output'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER clustering_runs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.clustering_runs
      FOR EACH ROW EXECUTE FUNCTION %1$I.clustering_run_guard()
  $fmt$, target);

  -- Machine output belongs to its run: once the run is completed nothing in
  -- it may be added, changed or removed.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.clustering_output_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_status text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        SELECT status INTO run_status
          FROM %1$I.clustering_runs WHERE id = OLD.clustering_run_id FOR SHARE;
        IF run_status = 'completed' THEN
          RAISE EXCEPTION 'output of a completed clustering run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      IF TG_OP <> 'DELETE' THEN
        SELECT status INTO run_status
          FROM %1$I.clustering_runs WHERE id = NEW.clustering_run_id FOR SHARE;
        IF run_status = 'completed' THEN
          RAISE EXCEPTION 'output of a completed clustering run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_clusters_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.incident_clusters
      FOR EACH ROW EXECUTE FUNCTION %1$I.clustering_output_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_memberships_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.incident_memberships
      FOR EACH ROW EXECUTE FUNCTION %1$I.clustering_output_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER clustering_ambiguous_links_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.clustering_ambiguous_links
      FOR EACH ROW EXECUTE FUNCTION %1$I.clustering_output_guard()
  $fmt$, target);

  -- The review layer is append-only, and every action must name a completed
  -- run: correcting a run that is still being written is meaningless.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.clustering_review_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_status text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'clustering review actions are append-only'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT status INTO run_status
        FROM %1$I.clustering_runs WHERE id = NEW.clustering_run_id FOR SHARE;
      IF run_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'a clustering review action requires a completed run'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER clustering_review_actions_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.clustering_review_actions
      FOR EACH ROW EXECUTE FUNCTION %1$I.clustering_review_guard()
  $fmt$, target);
END
$migration$;
