-- 0007_clustering_integrity
--
-- Sprint 4 correction. Codex Desktop's audit of candidate 4da68716 found three
-- invariants that the application believed and the database did not enforce.
-- This migration moves them into the schema. Migrations 0001 to 0006 are
-- unchanged; everything here is additive and forward-only.
--
--   1. Provenance (audit finding F2). A membership could name a classification
--      result belonging to a different classification run of the same batch,
--      and the run still completed with every coverage and counter check
--      green. A composite identity on `clustering_runs` and a matching foreign
--      key from `incident_memberships` make the run's declared classification
--      run and the membership's classification run the same value by
--      construction.
--   2. Review notes (F4). The worker's merge and split APIs persisted control
--      characters that only the command line refused. The character policy now
--      lives in a CHECK constraint, so a direct INSERT or UPDATE cannot store
--      what the API must not accept.
--   3. Review identity (F3). Idempotency was keyed on part of the action, so a
--      replay carrying a different actor or note was answered with the
--      original action. The complete canonical payload is now computed by the
--      database as a generated column and made unique per run, so the stored
--      identity covers every persisted, behaviour-affecting field rather than
--      a subset the application chose.
--
-- Every function below is created through `pg_catalog.format` with quoted
-- identifiers, bound to the schema being migrated, stores
-- `search_path = pg_catalog, <schema>, pg_temp`, names every relation by
-- schema, and is not SECURITY DEFINER. Existing rows are validated by the
-- constraints themselves, and by an explicit check first so the failure names
-- the invariant rather than a constraint's internals. Either way the whole
-- migration is one transaction: a violation leaves nothing applied.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
  offenders bigint;
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0007 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0007 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.clustering_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.incident_memberships') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.clustering_review_actions') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0007 target schema does not hold the Sprint 4 clustering tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------- 1
  -- Provenance: a membership belongs to its clustering run's classification
  -- run, not merely to some classification run of the same batch.

  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*)
      FROM %1$I.incident_memberships m
      JOIN %1$I.clustering_runs r ON r.id = m.clustering_run_id
     WHERE m.classification_run_id <> r.classification_run_id
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION
      'migration 0007 found memberships whose classification run differs from their clustering run'
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_runs
      ADD CONSTRAINT clustering_runs_classification_identity
        UNIQUE (id, classification_run_id, batch_id)
  $fmt$, target);

  -- Validated against every existing row as it is created; a violating row
  -- fails the migration transactionally. The Sprint 4 result key is kept, so a
  -- membership is still bound to the exact classification result, its run, its
  -- source row and its batch as well.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.incident_memberships
      ADD CONSTRAINT incident_memberships_run_classification_fk
        FOREIGN KEY (clustering_run_id, classification_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, classification_run_id, batch_id)
  $fmt$, target);

  -- ---------------------------------------------------------------------- 2
  -- Review notes: one character policy, enforced where the row is written.
  --
  -- Refused: C0 controls U+0000 to U+001F, which covers newline, carriage
  -- return, tab and the ANSI escape introducer U+001B; DEL U+007F; C1 controls
  -- U+0080 to U+009F, which covers the eight-bit CSI U+009B; and the Unicode
  -- line and paragraph separators U+2028 and U+2029. An embedded NUL cannot
  -- reach a `text` value at all, and is named in the class so the policy reads
  -- completely rather than relying on that. Length is 1 to 280 characters and
  -- an empty note is not a note: absence is NULL.

  EXECUTE pg_catalog.format($fmt$
    SELECT pg_catalog.count(*) FROM %1$I.clustering_review_actions
     WHERE note IS NOT NULL
       AND (pg_catalog.length(note) < 1 OR pg_catalog.length(note) > 280
            OR note ~ '[\u0000-\u001f\u007f-\u009f\u2028\u2029]')
  $fmt$, target) INTO offenders;
  IF offenders <> 0 THEN
    RAISE EXCEPTION 'migration 0007 found review notes outside the note character policy'
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_review_actions
      ADD CONSTRAINT clustering_actions_note_policy
        CHECK (note IS NULL
               OR (pg_catalog.length(note) BETWEEN 1 AND 280
                   AND note !~ '[\u0000-\u001f\u007f-\u009f\u2028\u2029]'))
  $fmt$, target);

  -- ---------------------------------------------------------------------- 3
  -- Review identity: the whole canonical payload, computed by the database.
  --
  -- `expected_revision` records the revision the caller declared, and is NULL
  -- when the caller declared none and let the current revision stand. It is
  -- part of the payload because it is part of what was asked for; it must
  -- agree with the revision the action actually consumed.

  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_review_actions
      ADD COLUMN expected_revision integer,
      ADD CONSTRAINT clustering_actions_expected_revision
        CHECK (expected_revision IS NULL OR expected_revision = prior_revision)
  $fmt$, target);

  -- A deterministic, injective encoding of every semantic field: fixed
  -- version tag, one field per line, the note length-prefixed so its content
  -- cannot imitate a field boundary, identifier lists counted and ordered in
  -- the C collation so a database collation cannot reorder them, and absence
  -- distinguished from an empty value. `@cas/worker` computes the identical
  -- string, and a test holds the two to the same digest.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.clustering_review_payload_digest(
      p_operation          text,
      p_run                uuid,
      p_reason             text,
      p_actor              text,
      p_note               text,
      p_expected_revision  integer,
      p_incidents          jsonb,
      p_memberships        jsonb
    ) RETURNS text
      LANGUAGE plpgsql
      IMMUTABLE
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $digest$
    DECLARE
      incidents   text;
      memberships text;
      payload     text;
      newline     text := pg_catalog.chr(10);
    BEGIN
      SELECT coalesce(
               pg_catalog.string_agg(pg_catalog.lower(value), ','
                 ORDER BY pg_catalog.lower(value) COLLATE "C"), '')
        INTO incidents
        FROM pg_catalog.jsonb_array_elements_text(p_incidents) AS t(value);
      SELECT coalesce(
               pg_catalog.string_agg(pg_catalog.lower(value), ','
                 ORDER BY pg_catalog.lower(value) COLLATE "C"), '')
        INTO memberships
        FROM pg_catalog.jsonb_array_elements_text(p_memberships) AS t(value);
      payload :=
        'cas.clustering.review.v1' || newline ||
        'operation:' || p_operation || newline ||
        'run:' || pg_catalog.lower(p_run::text) || newline ||
        'reason:' || p_reason || newline ||
        'actor:' || p_actor || newline ||
        'note:' || CASE WHEN p_note IS NULL THEN 'absent'
                        ELSE 'present:' || pg_catalog.octet_length(p_note)::text || ':' || p_note
                   END || newline ||
        'revision:' || CASE WHEN p_expected_revision IS NULL THEN 'absent'
                            ELSE p_expected_revision::text END || newline ||
        'incidents:' || pg_catalog.jsonb_array_length(p_incidents)::text || ':'
          || incidents || newline ||
        'memberships:' || pg_catalog.jsonb_array_length(p_memberships)::text || ':'
          || memberships || newline;
      RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload, 'UTF8')), 'hex');
    END;
    $digest$
  $fmt$, target);

  -- Generated, not supplied: the application cannot write a digest that
  -- disagrees with the row it wrote, because it never writes one. Existing
  -- rows are computed as the column is added.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_review_actions
      ADD COLUMN payload_digest text
        GENERATED ALWAYS AS (%1$I.clustering_review_payload_digest(
          operation, clustering_run_id, reason_code, actor, note,
          expected_revision, affected_incident_ids, affected_membership_ids)) STORED
  $fmt$, target);

  -- One action per canonical payload per run, decided by the database rather
  -- than by whichever fields the application chose to key on.
  EXECUTE pg_catalog.format($fmt$
    ALTER TABLE %1$I.clustering_review_actions
      ADD CONSTRAINT clustering_actions_payload_identity
        UNIQUE (clustering_run_id, payload_digest)
  $fmt$, target);
END
$migration$;
