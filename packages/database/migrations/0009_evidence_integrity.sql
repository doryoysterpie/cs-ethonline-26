-- 0009_evidence_integrity
--
-- Sprint 5 audit correction (Codex Desktop, 10 September 2026, findings F1 and
-- F2). Two things migration 0008 documented but did not make unwritable:
--
--   1. **Origin is bound, not labelled.** An evidence run's origin now has to
--      equal the origin of the signal run it reads and the origin of the
--      clustering run it resolves, by composite foreign key. A replay signal
--      run cannot feed a live evidence run, and a live signal run cannot feed
--      a replay one, whatever any caller writes in the `data_origin` column.
--      A live signal run may not name a reserved-domain gateway host either:
--      `.example`, `.invalid`, `.test` and `localhost` are where fixtures live,
--      and nothing live was ever served from them.
--
--   2. **A claim is a row, not a UUID.** `corroborated` and `contradicted` are
--      statements about a specific claim, and until now the claim was whatever
--      UUID the reviewer typed. `incident_claims` gives a claim a record: the
--      incident it is about, the source row it rests on and that row's
--      immutable hash, the clustering run, batch and origin the row belongs
--      to, a bounded kind, a bounded statement and a canonical fingerprint.
--      The composite foreign key to `incident_memberships` is the proof that
--      the cited row really is a member of the cited incident under the cited
--      run. Every association, review action and resolved state that names a
--      claim is then bound to a claim of the same incident, run, batch and
--      origin, by foreign key where the columns exist and by a guard trigger
--      where they do not.
--
-- Existing rows are validated before each constraint is added. A contradiction
-- fails the whole migration inside its transaction and nothing is rewritten,
-- deleted or reinterpreted: a historical row that cites a claim no record
-- exists for is reported as a count and left exactly as it is. No claim record
-- is fabricated to legitimise it.
--
-- Migrations 0001 to 0008 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp` with every relation named by schema. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target    text := pg_catalog.current_schema();
  offenders bigint;
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0009 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0009 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.evidence_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.graph_signal_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.incident_memberships') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0009 target schema does not hold the Sprint 5 evidence tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------- 1
  -- Origin binding.

  -- 1a. A live signal run cannot name a reserved-domain host. Validated
  --     against every existing row first.
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*) FROM %1$I.graph_signal_runs
     WHERE data_origin = 'live'
       AND (gateway_host = 'localhost'
            OR gateway_host ~ '(^|\.)(example|invalid|test|localhost)$')
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION 'migration 0009 found live signal runs served from a reserved-domain host'
      USING ERRCODE = 'raise_exception';
  END IF;
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.graph_signal_runs
      ADD CONSTRAINT graph_signal_runs_live_host
        CHECK (data_origin <> 'live'
               OR NOT (gateway_host = 'localhost'
                       OR gateway_host ~ '(^|\.)(example|invalid|test|localhost)$'))
  $fmt$, target);

  -- 1b. Parent key on clustering runs carrying the origin, so a child can bind
  --     to the run and its origin together.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_runs
      ADD CONSTRAINT clustering_runs_batch_origin_identity UNIQUE (id, batch_id, data_origin)
  $fmt$, target);

  -- 1c. Every existing evidence run must already agree with both parents.
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*)
      FROM %1$I.evidence_runs e
      JOIN %1$I.graph_signal_runs s ON s.id = e.signal_run_id
     WHERE s.data_origin <> e.data_origin
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION
      'migration 0009 found evidence runs whose origin differs from their signal run'
      USING ERRCODE = 'raise_exception';
  END IF;
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*)
      FROM %1$I.evidence_runs e
      JOIN %1$I.clustering_runs c ON c.id = e.clustering_run_id AND c.batch_id = e.batch_id
     WHERE c.data_origin <> e.data_origin
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION
      'migration 0009 found evidence runs whose origin differs from their clustering run'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 1d. The binding itself. `graph_signal_runs (id, data_origin)` is the
  --     parent key migration 0008 already declared for signals.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.evidence_runs
      ADD CONSTRAINT evidence_runs_signal_origin_fk
        FOREIGN KEY (signal_run_id, data_origin)
        REFERENCES %1$I.graph_signal_runs (id, data_origin),
      ADD CONSTRAINT evidence_runs_clustering_origin_fk
        FOREIGN KEY (clustering_run_id, batch_id, data_origin)
        REFERENCES %1$I.clustering_runs (id, batch_id, data_origin),
      ADD CONSTRAINT evidence_runs_origin_identity
        UNIQUE (id, clustering_run_id, batch_id, data_origin)
  $fmt$, target);

  -- ---------------------------------------------------------------------- 2
  -- Claims.

  -- 2a. The membership parent key. A claim cites a source row as a member of
  --     an incident under a clustering run; this key is what that citation
  --     references, hash and origin included.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.incident_memberships
      ADD CONSTRAINT incident_memberships_claim_identity
        UNIQUE (clustering_run_id, incident_cluster_id, batch_id, data_origin,
                source_row_id, row_hash)
  $fmt$, target);

  -- 2b. The claim relation. The statement carries the same character policy
  --     as a review note or rationale: 1 to 280 characters, no C0 control,
  --     DEL, C1 control, U+2028 or U+2029. The fingerprint is the canonical
  --     digest of the claim's identity, computed by the worker and unique
  --     within an incident, so recording the same claim twice is a no-op
  --     rather than a second row.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_claims (
      id                  uuid        PRIMARY KEY,
      clustering_run_id   uuid        NOT NULL,
      batch_id            uuid        NOT NULL,
      incident_cluster_id uuid        NOT NULL,
      data_origin         text        NOT NULL
                            CHECK (data_origin IN ('live', 'fixture', 'replay')),
      source_row_id       uuid        NOT NULL,
      row_hash            text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
      claim_kind          text        NOT NULL
                            CHECK (claim_kind IN ('reported_headline', 'recorded_statement')),
      statement           text        NOT NULL,
      fingerprint         text        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      actor               text        NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
      reason_code         text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      created_at          timestamptz NOT NULL,
      CONSTRAINT incident_claims_statement_policy
        CHECK (pg_catalog.length(statement) BETWEEN 1 AND 280
               AND statement !~ '[\u0000-\u001f\u007f-\u009f\u2028\u2029]'),
      CONSTRAINT incident_claims_membership_fk
        FOREIGN KEY (clustering_run_id, incident_cluster_id, batch_id, data_origin,
                     source_row_id, row_hash)
        REFERENCES %1$I.incident_memberships (clustering_run_id, incident_cluster_id, batch_id,
                                              data_origin, source_row_id, row_hash),
      CONSTRAINT incident_claims_fingerprint UNIQUE (clustering_run_id, incident_cluster_id, fingerprint),
      CONSTRAINT incident_claims_identity
        UNIQUE (id, clustering_run_id, incident_cluster_id, batch_id),
      CONSTRAINT incident_claims_origin_identity
        UNIQUE (id, clustering_run_id, incident_cluster_id, batch_id, data_origin)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_claims_guard
      BEFORE UPDATE OR DELETE ON %1$I.incident_claims
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_action_append_only_guard()
  $fmt$, target);

  -- 2c. No existing row may cite a claim, because no claim record can exist
  --     yet. A historical citation is reported and the migration stops; it
  --     is never given a fabricated record to point at.
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*) FROM %1$I.incident_signal_associations WHERE claim_id IS NOT NULL
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION 'migration 0009 found % association(s) citing a claim that has no record',
      offenders USING ERRCODE = 'raise_exception';
  END IF;
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*) FROM %1$I.evidence_review_actions WHERE claim_id IS NOT NULL
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION 'migration 0009 found % review action(s) citing a claim that has no record',
      offenders USING ERRCODE = 'raise_exception';
  END IF;
  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*) FROM %1$I.incident_evidence_states WHERE claim_id IS NOT NULL
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION 'migration 0009 found % evidence state(s) citing a claim that has no record',
      offenders USING ERRCODE = 'raise_exception';
  END IF;

  -- 2d. Foreign keys where the incident columns exist. A NULL claim is not
  --     checked; a non-null one has to be a claim of the same incident, run
  --     and batch.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.incident_signal_associations
      ADD CONSTRAINT incident_signal_associations_claim_fk
        FOREIGN KEY (claim_id, clustering_run_id, incident_cluster_id, batch_id)
        REFERENCES %1$I.incident_claims (id, clustering_run_id, incident_cluster_id, batch_id)
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.incident_evidence_states
      ADD CONSTRAINT incident_evidence_states_claim_fk
        FOREIGN KEY (claim_id, clustering_run_id, incident_cluster_id, batch_id)
        REFERENCES %1$I.incident_claims (id, clustering_run_id, incident_cluster_id, batch_id)
  $fmt$, target);

  -- 2e. The guard. A review action carries no incident columns of its own,
  --     so its claim is checked through the association it decides; and all
  --     three tables are checked for origin, which the foreign keys above do
  --     not carry. The claim must exist, belong to the same incident, run and
  --     batch, and share the evidence run's origin. An accepted `supports` or
  --     `conflicts` must name a claim at all.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.evidence_claim_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      ctx_clustering_run uuid;
      ctx_incident       uuid;
      ctx_batch          uuid;
      ctx_origin         text;
      matched            integer;
    BEGIN
      IF TG_TABLE_NAME = 'evidence_review_actions' THEN
        IF NEW.operation = 'accept' AND NEW.relation IN ('supports', 'conflicts')
           AND NEW.claim_id IS NULL THEN
          RAISE EXCEPTION 'an accepted supporting or conflicting association must name a claim'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF NEW.claim_id IS NULL THEN RETURN NEW; END IF;
        SELECT a.clustering_run_id, a.incident_cluster_id, a.batch_id
          INTO ctx_clustering_run, ctx_incident, ctx_batch
          FROM %1$I.incident_signal_associations a
         WHERE a.id = NEW.association_id AND a.evidence_run_id = NEW.evidence_run_id;
      ELSE
        IF NEW.claim_id IS NULL THEN RETURN NEW; END IF;
        ctx_clustering_run := NEW.clustering_run_id;
        ctx_incident       := NEW.incident_cluster_id;
        ctx_batch          := NEW.batch_id;
      END IF;
      IF ctx_incident IS NULL THEN
        RAISE EXCEPTION 'a claim can only be cited through an association of the same evidence run'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT data_origin INTO ctx_origin
        FROM %1$I.evidence_runs WHERE id = NEW.evidence_run_id;
      SELECT count(*) INTO matched
        FROM %1$I.incident_claims c
       WHERE c.id = NEW.claim_id
         AND c.clustering_run_id = ctx_clustering_run
         AND c.incident_cluster_id = ctx_incident
         AND c.batch_id = ctx_batch
         AND c.data_origin = ctx_origin;
      IF matched <> 1 THEN
        RAISE EXCEPTION 'the cited claim is not a recorded claim of this incident, run, batch and origin'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER evidence_review_actions_claim_guard
      BEFORE INSERT ON %1$I.evidence_review_actions
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_claim_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_signal_associations_claim_guard
      BEFORE INSERT ON %1$I.incident_signal_associations
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_claim_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_evidence_states_claim_guard
      BEFORE INSERT ON %1$I.incident_evidence_states
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_claim_guard()
  $fmt$, target);
END
$migration$;
