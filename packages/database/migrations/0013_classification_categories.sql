-- 0013_classification_categories
--
-- CAS-002 (post-event plan, decision D33's direction and the categories of
-- section 1): a classification run now answers one category's question, and
-- the category is recorded beside the run rather than assumed from it.
--
--   1. **One category row per run.** `classification_run_categories` names the
--      category, the policy version it was classified under and the policy's
--      hash, bound to the run and its batch by the composite key migration
--      0003 declared, and to the batch's origin by the key migration 0002
--      declared.
--
--   2. **The row cannot disagree with its run.** A guard refuses a category
--      row whose policy hash is not the ruleset hash the run recorded, or
--      whose origin is not the run's. The category is therefore a name for
--      the hash the run already carries, never a second claim about it.
--
--   3. **Runs that predate categories are left exactly as they are.** No row
--      is written for them and nothing is backfilled: the cyberattack policy
--      builds, hash for hash, to the contract those runs recorded, so a reader
--      who needs to know what they were compares hashes rather than trusting
--      a label this migration would have had to invent.
--
-- Append-only, like every record of a machine decision. Migrations 0001 to
-- 0012 are unchanged. Every function and trigger below is created through
-- `pg_catalog.format` with quoted identifiers, bound to the schema being
-- migrated, and stores `search_path = pg_catalog, <schema>, pg_temp`. None is
-- SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0013 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0013 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.classification_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.import_batches') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0013 target schema does not hold the classification tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.classification_run_categories (
      run_id         uuid        PRIMARY KEY,
      batch_id       uuid        NOT NULL,
      data_origin    text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
      category       text        NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]{1,31}$'),
      policy_version text        NOT NULL CHECK (policy_version ~ '^[a-z][a-z0-9-]*@[0-9]+$'),
      policy_hash    text        NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
      created_at     timestamptz NOT NULL,
      CONSTRAINT classification_run_categories_run_fk
        FOREIGN KEY (run_id, batch_id) REFERENCES %1$I.classification_runs (id, batch_id),
      CONSTRAINT classification_run_categories_batch_fk
        FOREIGN KEY (batch_id, data_origin) REFERENCES %1$I.import_batches (id, data_origin)
    )
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.classification_run_category_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_hash   text;
      run_origin text;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a classification run category is append-only'
          USING ERRCODE = 'raise_exception';
      END IF;
      SELECT r.ruleset_hash, r.data_origin INTO run_hash, run_origin
        FROM %1$I.classification_runs r WHERE r.id = NEW.run_id;
      IF run_hash IS NULL THEN
        RAISE EXCEPTION 'a classification run category must name an existing run'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF run_hash <> NEW.policy_hash THEN
        RAISE EXCEPTION 'a classification run category must carry the ruleset hash its run recorded'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF run_origin <> NEW.data_origin THEN
        RAISE EXCEPTION 'a classification run category must carry the origin its run recorded'
          USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER classification_run_categories_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.classification_run_categories
      FOR EACH ROW EXECUTE FUNCTION %1$I.classification_run_category_guard()
  $fmt$, target);
END
$migration$;
