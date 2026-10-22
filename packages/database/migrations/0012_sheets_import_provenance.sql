-- 0012_sheets_import_provenance
--
-- CAS-001 (post-event plan, decisions D31 and D33 to D36): the living feed is
-- read from the authorized Google Sheets workbook, and a batch read that way
-- carries provenance a CSV batch never had. This migration gives that
-- provenance a home without changing the meaning of any existing column.
--
--   1. **One read record per Sheets batch.** `sheets_import_reads` names the
--      workbook and tab digests (never an identifier), the tab's title, the
--      workbook's declared zone, the serial-to-instant rule the batch was
--      converted under, how many rows and pages the read took, and when it
--      started and ended. It is bound to its batch and to the batch's origin
--      by the composite key migration 0002 declared, and a Sheets batch may
--      only ever be `live`: a file can be a fixture or a replay, a workbook
--      read at run time cannot.
--
--   2. **Every converted serial beside its instant.** `sheets_import_timestamps`
--      keeps the serial number's own text for each timestamp cell the bridge
--      converted, bound to the stored source row, its batch and its immutable
--      hash by the composite key migration 0004 declared. Nothing is lost in
--      the conversion: the instant is what the importer evaluated, the serial
--      is what the workbook held.
--
-- Both tables are append-only through a guard that refuses UPDATE and DELETE,
-- the same shape as the evidence guards of migration 0008. Migrations 0001 to
-- 0011 are unchanged; no existing row is touched or reinterpreted. The
-- `import_batches` row of a Sheets batch is distinguished by its importer
-- version alone, which already names the transport.
--
-- Every function and trigger below is created through `pg_catalog.format`
-- with quoted identifiers, bound to the schema being migrated, and stores
-- `search_path = pg_catalog, <schema>, pg_temp`. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0012 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0012 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.import_batches') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.source_rows') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0012 target schema does not hold the editorial ingestion tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---------------------------------------------------------------------- 1
  -- The read record. Digests are the connector's stable digests: a prefix
  -- of a SHA-256, never the identifier they were taken from.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.sheets_import_reads (
      batch_id          uuid        PRIMARY KEY,
      data_origin       text        NOT NULL CHECK (data_origin = 'live'),
      workbook_digest   text        NOT NULL CHECK (workbook_digest ~ '^[0-9a-f]{12,64}$'),
      tab_digest        text        NOT NULL CHECK (tab_digest ~ '^[0-9a-f]{12,64}$'),
      tab_title         text        NOT NULL,
      sheet_time_zone   text,
      serial_transform  text        NOT NULL CHECK (serial_transform ~ '^[a-z][a-z0-9-]*@[0-9]+$'),
      rows_read         integer     NOT NULL CHECK (rows_read >= 0),
      pages             integer     NOT NULL CHECK (pages >= 0),
      read_started_at   timestamptz NOT NULL,
      read_completed_at timestamptz NOT NULL,
      CONSTRAINT sheets_import_reads_title_policy
        CHECK (pg_catalog.length(tab_title) BETWEEN 1 AND 100
               AND tab_title !~ '[\u0000-\u001f\u007f-\u009f\u2028\u2029]'),
      CONSTRAINT sheets_import_reads_zone_policy
        CHECK (sheet_time_zone IS NULL
               OR (pg_catalog.length(sheet_time_zone) BETWEEN 1 AND 64
                   AND sheet_time_zone ~ '^[A-Za-z0-9/_+-]+$')),
      CONSTRAINT sheets_import_reads_read_order
        CHECK (read_completed_at >= read_started_at),
      CONSTRAINT sheets_import_reads_identity UNIQUE (batch_id, data_origin),
      CONSTRAINT sheets_import_reads_batch_fk
        FOREIGN KEY (batch_id, data_origin) REFERENCES %1$I.import_batches (id, data_origin)
    )
  $fmt$, target);

  -- ---------------------------------------------------------------------- 2
  -- The converted serials. One row per timestamp cell the bridge converted,
  -- bound to the stored source row with its hash, and to the read record.
  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.sheets_import_timestamps (
      id            uuid        PRIMARY KEY,
      batch_id      uuid        NOT NULL,
      data_origin   text        NOT NULL CHECK (data_origin = 'live'),
      source_row_id uuid        NOT NULL,
      row_hash      text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
      column_index  integer     NOT NULL CHECK (column_index BETWEEN 1 AND 64),
      serial_text   text        NOT NULL,
      instant       timestamptz,
      CONSTRAINT sheets_import_timestamps_serial_policy
        CHECK (pg_catalog.length(serial_text) BETWEEN 1 AND 64
               AND serial_text ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'),
      CONSTRAINT sheets_import_timestamps_cell UNIQUE (source_row_id, column_index),
      CONSTRAINT sheets_import_timestamps_read_fk
        FOREIGN KEY (batch_id, data_origin)
        REFERENCES %1$I.sheets_import_reads (batch_id, data_origin),
      CONSTRAINT sheets_import_timestamps_row_fk
        FOREIGN KEY (source_row_id, batch_id, row_hash)
        REFERENCES %1$I.source_rows (id, batch_id, row_hash)
    )
  $fmt$, target);

  -- ---------------------------------------------------------------------- 3
  -- Append-only. A read record and its serials describe what happened; a
  -- correction is a new batch, never an edit of the record of the old one.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.sheets_import_append_only_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'sheets import provenance is append-only'
        USING ERRCODE = 'raise_exception';
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER sheets_import_reads_guard
      BEFORE UPDATE OR DELETE ON %1$I.sheets_import_reads
      FOR EACH ROW EXECUTE FUNCTION %1$I.sheets_import_append_only_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER sheets_import_timestamps_guard
      BEFORE UPDATE OR DELETE ON %1$I.sheets_import_timestamps
      FOR EACH ROW EXECUTE FUNCTION %1$I.sheets_import_append_only_guard()
  $fmt$, target);
END
$migration$;
